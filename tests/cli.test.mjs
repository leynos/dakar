import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const cliPath = join(repoRoot, 'bin', 'dakar-review.mjs')
const installPath = join(repoRoot, 'install.sh')

function runCli(args, options = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('CLI help documents review invocation', () => {
  const output = runCli(['--help'])

  assert.match(output, /Usage: dakar-review/u)
  assert.match(output, /--repo-root <path>/u)
  assert.match(output, /--format <json\|markdown>/u)
})

test('CLI dry-run prints one machine-readable JSON result', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-runs-'))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-empty-xdg-config-'))
  const output = runCli(
    [
      '--dry-run',
      '--repo-root',
      repoRoot,
      '--runs-root',
      runsRoot,
      '--timeout',
      '20',
      '--max-tasks',
      '2',
    ],
    { env: { XDG_CONFIG_HOME: xdgConfig } },
  )
  const result = JSON.parse(output)

  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.workflowVersion, 'divide-and-conquer-v1')
  assert.equal(result.repoRoot, repoRoot)
  assert.equal(result.synthesisAdapter, 'codex-high')
  assert.equal(result.limits.maxTasks, 2)
  assert.match(result.config, /examples\/df12-code-review\.yaml$/u)
})

test('CLI uses user config when repository config is absent', () => {
  const targetRepo = mkdtempSync(join(tmpdir(), 'dakar-target-repo-'))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-xdg-config-'))
  const userConfig = join(xdgConfig, 'dakar', 'config.yaml')
  mkdirSync(join(xdgConfig, 'dakar'), { recursive: true })
  writeFileSync(userConfig, 'reviews:\n  profile: chill\n')

  const runsRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-runs-'))
  const output = runCli(
    [
      '--dry-run',
      '--repo-root',
      targetRepo,
      '--runs-root',
      runsRoot,
      '--timeout',
      '20',
    ],
    { env: { XDG_CONFIG_HOME: xdgConfig } },
  )
  const result = JSON.parse(output)

  assert.equal(result.ok, true)
  assert.equal(result.config, userConfig)
})

test('package installs a callable CLI with Bun global install', (t) => {
  const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (bunCheck.status !== 0) {
    t.skip('bun is not installed')
    return
  }

  const bunInstall = mkdtempSync(join(tmpdir(), 'dakar-bun-install-'))
  execFileSync('bun', ['install', '-g', repoRoot], {
    cwd: repoRoot,
    env: { ...process.env, BUN_INSTALL: bunInstall },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = execFileSync(join(bunInstall, 'bin', 'dakar-review'), ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  assert.equal(output.trim(), '0.1.0')
})

test('install script installs a callable CLI with Bun', (t) => {
  const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (bunCheck.status !== 0) {
    t.skip('bun is not installed')
    return
  }

  const bunInstall = mkdtempSync(join(tmpdir(), 'dakar-bun-install-'))
  execFileSync(installPath, {
    cwd: repoRoot,
    env: { ...process.env, BUN_INSTALL: bunInstall },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = execFileSync(join(bunInstall, 'bin', 'dakar-review'), ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  assert.equal(output.trim(), '0.1.0')
})

test('install script help does not install', () => {
  const output = execFileSync(installPath, ['--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  assert.match(output, /Usage: \.\/install\.sh/u)
})
