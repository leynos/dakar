/**
 * Tests clean-checkout installation, Bun global mutations, and installer lock
 * recovery without involving the review CLI test fixtures.
 *
 * @module
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants as fsConstants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const installPath = join(repoRoot, 'install.sh')
// Installation tests do not invoke the review CLI, but keep the inherited
// environment safe if an installed executable delegates to it unexpectedly.
process.env.DAKAR_SKIP_CONTEXT_WARMUP = '1'

/** Resolves a real fixture utility before a child process receives a restricted PATH. */
function resolvePathUtility(command, searchPath = process.env.PATH ?? '') {
  const executable = searchPath.split(delimiter).map((directory) => join(directory || '.', command)).find((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  })
  assert.ok(executable, `required test utility ${command} was not found on the original PATH`)
  return executable
}

/** Copies the checkout's installation inputs without its dependencies. */
function makeCleanInstallFixture(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dakar-install-fixture-'))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  const fixture = join(fixtureRoot, 'dakar')
  const excluded = new Set([join(repoRoot, '.git'), join(repoRoot, 'node_modules')])
  cpSync(repoRoot, fixture, {
    recursive: true,
    filter: (source) => !excluded.has(source),
  })
  return fixture
}

/** Waits for a test fixture signal without depending on process scheduling. */
async function waitFor(condition, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${description}`)
}

/** Waits for a test fixture path without depending on process scheduling. */
async function waitForPath(path, description) {
  await waitFor(() => existsSync(path), description)
}

/** Returns the eventual exit status of a spawned installation process. */
async function waitForExit(child) {
  const [code, signal] = await once(child, 'exit')
  return { code, signal }
}

/** Starts an installer and retains its stderr for assertions. */
function startInstaller(installFixture, env, detached = false) {
  const child = spawn('/bin/sh', [join(installFixture, 'install.sh')], {
    cwd: installFixture,
    detached,
    env,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return { child, exit: waitForExit(child), stderr: () => stderr }
}

/** Reads the serialized installer-operation trace maintained by the fake tools. */
function readInstallerEvents(eventLog) {
  if (!existsSync(eventLog)) {
    return []
  }
  return readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean)
}

/** Creates two clean checkouts and deterministic fake installer dependencies. */
function makeInstallerHarness(t) {
  const firstFixture = makeCleanInstallFixture(t)
  const secondFixture = makeCleanInstallFixture(t)
  const toolDir = mkdtempSync(join(tmpdir(), 'dakar-install-tools-'))
  const bunInstall = mkdtempSync(join(tmpdir(), 'dakar-bun-install-'))
  const originalPath = process.env.PATH ?? ''
  const realMkdir = resolvePathUtility('mkdir', originalPath)
  t.after(() => rmSync(toolDir, { recursive: true, force: true }))
  t.after(() => rmSync(bunInstall, { recursive: true, force: true }))
  mkdirSync(join(bunInstall, 'install'), { recursive: true })

  const blocked = join(toolDir, 'operation-blocked')
  const eventLog = join(toolDir, 'events')
  const lockDir = join(bunInstall, 'install', '.dakar-install.lock')
  const lockWaiter = join(toolDir, 'lock-waiter')
  const release = join(toolDir, 'release')

  writeFileSync(
    join(toolDir, 'mkdir'),
    `#!/bin/sh
if [ "$1" = "$DAKAR_TEST_LOCK_DIR" ] && [ -d "$1" ]; then
  : > "$DAKAR_TEST_LOCK_WAITER"
fi
exec "$DAKAR_TEST_REAL_MKDIR" "$@"
`,
  )
  writeFileSync(
    join(toolDir, 'npm'),
    `#!/bin/sh
printf '%s\\n' "$DAKAR_TEST_INSTALLER:npm" >> "$DAKAR_TEST_EVENTS"
if [ "$DAKAR_TEST_NPM_EXIT_CODE" != 0 ]; then
  exit "$DAKAR_TEST_NPM_EXIT_CODE"
fi
`,
  )
  writeFileSync(
    join(toolDir, 'bun'),
    `#!/bin/sh
case "$1:$2:$3" in
  pm:cache:) printf '%s\\n' "$BUN_INSTALL/install/cache" ;;
  remove:-g:dakar) operation=remove ;;
  install:-g:*) operation=install ;;
  *) exit 0 ;;
esac

if [ -n "$operation" ]; then
  printf '%s\\n' "$DAKAR_TEST_INSTALLER:$operation" >> "$DAKAR_TEST_EVENTS"
  if [ "$DAKAR_TEST_INSTALLER" = first ] && [ "$DAKAR_TEST_BLOCK_OPERATION" = "$operation" ]; then
    : > "$DAKAR_TEST_BLOCKED"
    while [ ! -e "$DAKAR_TEST_RELEASE" ]; do
      sleep 0.01
    done
  fi
fi
`,
  )
  for (const command of ['node', 'odw']) {
    writeFileSync(join(toolDir, command), '#!/bin/sh\nexit 0\n')
  }
  for (const command of ['bun', 'mkdir', 'node', 'npm', 'odw']) {
    chmodSync(join(toolDir, command), 0o755)
  }

  const baseEnv = {
    ...process.env,
    BUN_INSTALL: bunInstall,
    DAKAR_TEST_BLOCKED: blocked,
    DAKAR_TEST_EVENTS: eventLog,
    DAKAR_TEST_LOCK_DIR: lockDir,
    DAKAR_TEST_LOCK_WAITER: lockWaiter,
    DAKAR_TEST_RELEASE: release,
    DAKAR_TEST_REAL_MKDIR: realMkdir,
    PATH: `${toolDir}:${originalPath}`,
  }

  return {
    blocked,
    events: () => readInstallerEvents(eventLog),
    firstFixture,
    lockDir,
    lockWaiter,
    release,
    secondFixture,
    env(installer, overrides = {}) {
      return {
        ...baseEnv,
        DAKAR_TEST_BLOCK_OPERATION: 'none',
        DAKAR_TEST_INSTALLER: installer,
        DAKAR_TEST_NPM_EXIT_CODE: '0',
        ...overrides,
      }
    },
  }
}

test('install script installs a callable CLI from a clean checkout', (t) => {
  const missingPrerequisite = ['bun', 'node', 'npm', 'odw'].find(
    (command) => spawnSync(command, ['--version'], { encoding: 'utf8' }).status !== 0,
  )
  if (missingPrerequisite) {
    t.skip(`${missingPrerequisite} is required but is not installed`)
    return
  }

  const installFixture = makeCleanInstallFixture(t)
  const bunInstall = mkdtempSync(join(tmpdir(), 'dakar-bun-install-'))
  t.after(() => rmSync(bunInstall, { recursive: true, force: true }))
  execFileSync(join(installFixture, 'install.sh'), {
    cwd: installFixture,
    env: { ...process.env, BUN_INSTALL: bunInstall, NODE_ENV: 'production' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = execFileSync(join(bunInstall, 'bin', 'dakar-review'), ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const rootPackage = JSON.parse(readFileSync(join(installFixture, 'package.json'), 'utf8'))
  const installedYamlPackage = JSON.parse(
    readFileSync(join(installFixture, 'node_modules', 'js-yaml', 'package.json'), 'utf8'),
  )
  assert.equal(installedYamlPackage.version, rootPackage.dependencies['js-yaml'])
  assert.equal(existsSync(join(installFixture, 'node_modules', 'typescript', 'package.json')), true)
  assert.equal(output.trim(), '0.1.0')
})

test('install script repairs stale duplicate Bun global entries', (t) => {
  const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (bunCheck.status !== 0) {
    t.skip('bun is not installed')
    return
  }

  const bunInstall = mkdtempSync(join(tmpdir(), 'dakar-bun-install-'))
  t.after(() => rmSync(bunInstall, { recursive: true, force: true }))
  const installFixture = makeCleanInstallFixture(t)
  const globalDir = join(bunInstall, 'install', 'global')
  mkdirSync(globalDir, { recursive: true })
  writeFileSync(
    join(globalDir, 'package.json'),
    '{\n  "dependencies": {\n    "dakar": "/tmp/old",\n    "dakar": "/tmp/older"\n  }\n}\n',
  )
  writeFileSync(
    join(globalDir, 'bun.lock'),
    '{\n  "packages": {\n    "dakar": ["old"],\n    "dakar": ["older"]\n  }\n}\n',
  )

  const result = spawnSync(join(installFixture, 'install.sh'), {
    cwd: installFixture,
    env: { ...process.env, BUN_INSTALL: bunInstall },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const combinedOutput = `${result.stdout}\n${result.stderr}`

  assert.equal(result.status, 0, combinedOutput)
  assert.doesNotMatch(combinedOutput, /Duplicate key|Duplicate package path/u)
  assert.equal((readFileSync(join(globalDir, 'package.json'), 'utf8').match(/"dakar"\s*:/gu) || []).length, 1)
  assert.equal(
    execFileSync(join(bunInstall, 'bin', 'dakar-review'), ['--version'], { encoding: 'utf8' }).trim(),
    '0.1.0',
  )
})

test('install script serializes each Bun global mutation across checkouts', async (t) => {
  for (const blockedOperation of ['remove', 'install']) {
    await t.test(`blocks a second installer during Bun ${blockedOperation}`, async (t) => {
      const harness = makeInstallerHarness(t)
      const first = startInstaller(
        harness.firstFixture,
        harness.env('first', { DAKAR_TEST_BLOCK_OPERATION: blockedOperation }),
      )
      let second

      try {
        await waitForPath(harness.blocked, `the first Bun ${blockedOperation} operation`)
        assert.equal(existsSync(harness.lockDir), true)

        second = startInstaller(harness.secondFixture, harness.env('second'))
        await waitForPath(harness.lockWaiter, 'the second installer to wait for the lock')
        await waitFor(
          () => second.stderr().includes('operation=global-install lock=waiting'),
          'the waiting lock diagnostic',
        )
        assert.match(second.stderr(), /elapsed=\d+s path=/u)
        assert.equal(existsSync(harness.lockDir), true)
        assert.equal(harness.events().some((event) => event.startsWith('second:')), false)

        writeFileSync(harness.release, '')
        assert.deepEqual(await first.exit, { code: 0, signal: null })
        assert.deepEqual(await second.exit, { code: 0, signal: null })
        assert.deepEqual(harness.events(), [
          'first:npm',
          'first:remove',
          'first:install',
          'second:npm',
          'second:remove',
          'second:install',
        ])
        assert.equal(existsSync(harness.lockDir), false)
      } finally {
        writeFileSync(harness.release, '')
        await first.exit
        if (second) {
          await second.exit
        }
      }
    })
  }
})

test('install script releases its lock after a failed dependency restoration', async (t) => {
  const harness = makeInstallerHarness(t)
  const installer = startInstaller(
    harness.firstFixture,
    harness.env('first', { DAKAR_TEST_NPM_EXIT_CODE: '17' }),
  )

  assert.notEqual((await installer.exit).code, 0)
  assert.deepEqual(harness.events(), ['first:npm'])
  assert.equal(existsSync(harness.lockDir), false)
})

test('install script releases its own lock after handled signals', async (t) => {
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    await t.test(signal, async (t) => {
      const harness = makeInstallerHarness(t)
      const installer = startInstaller(
        harness.firstFixture,
        harness.env('first', { DAKAR_TEST_BLOCK_OPERATION: 'remove' }),
        true,
      )

      try {
        await waitForPath(harness.blocked, `a blocked Bun remove before ${signal}`)
        assert.equal(existsSync(harness.lockDir), true)
        process.kill(-installer.child.pid, signal)

        assert.notEqual((await installer.exit).code, 0)
        assert.deepEqual(harness.events(), ['first:npm', 'first:remove'])
        assert.equal(existsSync(harness.lockDir), false)
      } finally {
        writeFileSync(harness.release, '')
        await installer.exit
      }
    })
  }
})

test('cancelling a waiting installer preserves another installer lock', async (t) => {
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    await t.test(signal, async (t) => {
      const harness = makeInstallerHarness(t)
      const holder = startInstaller(
        harness.firstFixture,
        harness.env('first', { DAKAR_TEST_BLOCK_OPERATION: 'remove' }),
      )
      let waiter

      try {
        await waitForPath(harness.blocked, 'the lock-owning installer to block in Bun remove')
        waiter = startInstaller(harness.secondFixture, harness.env('second'), true)
        await waitForPath(harness.lockWaiter, 'the second installer to wait for the lock')
        process.kill(-waiter.child.pid, signal)

        assert.notEqual((await waiter.exit).code, 0)
        assert.equal(existsSync(harness.lockDir), true)
        assert.deepEqual(harness.events(), ['first:npm', 'first:remove'])

        writeFileSync(harness.release, '')
        assert.deepEqual(await holder.exit, { code: 0, signal: null })
        assert.equal(existsSync(harness.lockDir), false)
      } finally {
        writeFileSync(harness.release, '')
        await holder.exit
        if (waiter) {
          await waiter.exit
        }
      }
    })
  }
})

test('install script times out without reclaiming another installer lock', async (t) => {
  const harness = makeInstallerHarness(t)
  mkdirSync(harness.lockDir)
  const installer = startInstaller(
    harness.firstFixture,
    harness.env('first', { DAKAR_INSTALL_LOCK_WAIT_SECONDS: '1' }),
  )

  const result = await installer.exit
  assert.notEqual(result.code, 0)
  assert.match(installer.stderr(), /operation=global-install lock=timeout/u)
  assert.match(installer.stderr(), /elapsed=\d+s/u)
  assert.match(installer.stderr(), new RegExp(`path=${harness.lockDir}`, 'u'))
  assert.match(installer.stderr(), /confirm no installer process is active/u)
  assert.deepEqual(harness.events(), [])
  assert.equal(existsSync(harness.lockDir), true)
})

test('install script rejects invalid lock-wait limits before mutation', async (t) => {
  for (const lockWaitLimit of ['0', '01', '10seconds']) {
    await t.test(lockWaitLimit, async (t) => {
      const harness = makeInstallerHarness(t)
      const installer = startInstaller(
        harness.firstFixture,
        harness.env('first', { DAKAR_INSTALL_LOCK_WAIT_SECONDS: lockWaitLimit }),
      )

      assert.equal((await installer.exit).code, 2)
      assert.match(installer.stderr(), /DAKAR_INSTALL_LOCK_WAIT_SECONDS must be a positive base-10 integer/u)
      assert.deepEqual(harness.events(), [])
      assert.equal(existsSync(harness.lockDir), false)
    })
  }
})

test('install script reports an unavailable Bun global lock path', (t) => {
  const installFixture = makeCleanInstallFixture(t)
  const toolDir = mkdtempSync(join(tmpdir(), 'dakar-install-tools-'))
  t.after(() => rmSync(toolDir, { recursive: true, force: true }))
  const unavailableBunInstall = join(toolDir, 'not-a-directory')
  const npmMarker = join(toolDir, 'npm-invoked')
  writeFileSync(unavailableBunInstall, '')
  writeFileSync(
    join(toolDir, 'bun'),
    `#!/bin/sh
case "$1:$2" in
  pm:cache) printf '%s\\n' "$BUN_INSTALL/install/cache" ;;
  *) exit 0 ;;
esac
`,
  )
  writeFileSync(join(toolDir, 'npm'), `#!/bin/sh\n: > '${npmMarker}'\n`)
  for (const command of ['node', 'odw']) {
    writeFileSync(join(toolDir, command), '#!/bin/sh\nexit 0\n')
  }
  for (const command of ['bun', 'node', 'npm', 'odw']) {
    chmodSync(join(toolDir, command), 0o755)
  }

  const result = spawnSync('/bin/sh', [join(installFixture, 'install.sh')], {
    cwd: installFixture,
    env: { ...process.env, PATH: `${toolDir}:${process.env.PATH}`, BUN_INSTALL: unavailableBunInstall },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /operation=global-install lock=acquisition-failed/u)
  assert.match(result.stderr, /path=.*\.dakar-install\.lock/u)
  assert.equal(existsSync(npmMarker), false, 'npm must not run when lock acquisition fails')
})

test('install script stops before installation when npm is unavailable', (t) => {
  const toolDir = mkdtempSync(join(tmpdir(), 'dakar-install-tools-'))
  t.after(() => rmSync(toolDir, { recursive: true, force: true }))
  const realDirname = resolvePathUtility('dirname', process.env.PATH ?? '')
  const installMarker = join(toolDir, 'bun-invoked')
  writeFileSync(join(toolDir, 'bun'), `#!/bin/sh\n: > '${installMarker}'\n`)
  writeFileSync(join(toolDir, 'node'), '#!/bin/sh\nexit 0\n')
  writeFileSync(join(toolDir, 'odw'), '#!/bin/sh\nexit 0\n')
  writeFileSync(join(toolDir, 'dirname'), '#!/bin/sh\nexec "$DAKAR_TEST_REAL_DIRNAME" "$@"\n')
  for (const command of ['bun', 'node', 'odw', 'dirname']) {
    chmodSync(join(toolDir, command), 0o755)
  }

  const result = spawnSync('/bin/sh', [installPath], {
    cwd: repoRoot,
    env: { PATH: toolDir, DAKAR_TEST_REAL_DIRNAME: realDirname },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  assert.equal(result.status, 127)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /install\.sh: npm is required but was not found on PATH/u)
  assert.equal(existsSync(installMarker), false, 'Bun must not run without npm')
})

test('install script help does not install', () => {
  const output = execFileSync(installPath, ['--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  assert.match(output, /Usage: \.\/install\.sh/u)
})
