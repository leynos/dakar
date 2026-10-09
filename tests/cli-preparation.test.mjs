/**
 * Verifies CLI preparation and trusted gates.
 *
 * @module
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { repoRoot, cliPath, runCli, spawnCli, setUpRecordRepo, writePreparedEchoOdw } from './cli-test-support.mjs'

process.env.DAKAR_SKIP_CONTEXT_WARMUP = '1'

test('CLI skips the review without invoking ODW when nothing is unreviewed', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-skip-'))
  const targetRepo = join(tempRoot, 'repo')
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-empty-xdg-config-'))
  mkdirSync(targetRepo, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  execFileSync('git', ['-C', targetRepo, 'commit', '--allow-empty', '-m', 'initial'])
  const marker = join(tempRoot, 'odw-invoked')
  const fakeOdw = join(tempRoot, 'odw')
  const stateRoot = join(tempRoot, 'state')
  writeFileSync(fakeOdw, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
  chmodSync(fakeOdw, 0o755)

  const output = runCli(
    [
      '--repo-root', targetRepo,
      '--base', 'HEAD',
      '--head', 'HEAD',
      '--state-root', stateRoot,
      '--odw-bin', fakeOdw,
      '--runs-root', join(tempRoot, 'runs'),
    ],
    { env: { XDG_CONFIG_HOME: xdgConfig } },
  )
  const result = JSON.parse(output)

  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /No unreviewed commits/u)
  assert.equal(result.resolvedConfig, undefined)
  assert.equal(typeof result.headCommit, 'string')
  assert.ok(result.headCommit.length > 0)
  assert.equal(result.recorded, undefined)
  assert.equal(existsSync(marker), false)
  // A skipped review records nothing: no reviews.toml under the trusted state root.
  assert.equal(existsSync(join(stateRoot, 'reviews.toml')), false)
})

test('CLI skip result honours --format markdown by emitting the JSON fallback', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-skip-md-'))
  const targetRepo = join(tempRoot, 'repo')
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-empty-xdg-config-'))
  mkdirSync(targetRepo, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  execFileSync('git', ['-C', targetRepo, 'commit', '--allow-empty', '-m', 'initial'])
  const fakeOdw = join(tempRoot, 'odw')
  writeFileSync(fakeOdw, `#!/bin/sh\nexit 1\n`)
  chmodSync(fakeOdw, 0o755)

  // The skip result carries no reportMarkdown, so markdown must fall back to the
  // JSON serialization printWorkflowOutput emits; the output stays parseable.
  const output = runCli(
    [
      '--repo-root', targetRepo,
      '--base', 'HEAD',
      '--head', 'HEAD',
      '--state-root', join(tempRoot, 'state'),
      '--odw-bin', fakeOdw,
      '--runs-root', join(tempRoot, 'runs'),
      '--format', 'markdown',
    ],
    { env: { XDG_CONFIG_HOME: xdgConfig } },
  )
  const result = JSON.parse(output)

  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /No unreviewed commits/u)
})

test('CLI fails with a prepare envelope without invoking ODW when refs are invalid', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-prepare-fail-'))
  const targetRepo = join(tempRoot, 'repo')
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-empty-xdg-config-'))
  mkdirSync(targetRepo, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  execFileSync('git', ['-C', targetRepo, 'commit', '--allow-empty', '-m', 'initial'])
  const marker = join(tempRoot, 'odw-invoked')
  const fakeOdw = join(tempRoot, 'odw')
  writeFileSync(fakeOdw, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--repo-root', targetRepo,
      '--base', 'HEAD',
      '--head', 'definitely-missing-ref',
      '--state-root', join(tempRoot, 'state'),
      '--odw-bin', fakeOdw,
      '--runs-root', join(tempRoot, 'runs'),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, XDG_CONFIG_HOME: xdgConfig },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /"stage":\s*"prepare"/u)
  assert.match(result.stderr, /"ok":\s*false/u)
  assert.equal(existsSync(marker), false)
})

test('a blocking deterministic gate returns SARIF without invoking ODW', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const config = join(tempRoot, 'gates.yaml')
  const marker = join(tempRoot, 'odw-invoked')
  const fakeOdw = join(tempRoot, 'odw')
  writeFileSync(config, `
pre_merge_checks:
  custom_checks:
    - mode: error
      name: Blocking fixture
      command: node -e "process.stderr.write('repair this'); process.exit(7)"
`)
  writeFileSync(fakeOdw, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
  chmodSync(fakeOdw, 0o755)

  const completed = spawnSync(
    process.execPath,
    [
      cliPath,
      '--repo-root', targetRepo,
      '--base', base,
      '--config', config,
      '--state-root', join(tempRoot, 'state'),
      '--odw-bin', fakeOdw,
      '--runs-root', join(tempRoot, 'runs'),
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const result = JSON.parse(completed.stdout)

  assert.equal(completed.status, 1)
  assert.equal(existsSync(marker), false)
  assert.equal(result.stage, 'deterministic-gates')
  assert.deepEqual(result.metrics.ledger, [])
  assert.equal(result.metrics.spentUsd, 0)
  assert.equal(result.metrics.reservedAuditUsd, 0)
  assert.equal(result.recordInput, undefined)
  assert.equal(result.sarif.version, '2.1.0')
  assert.match(result.reportMarkdown, /Blocking fixture/u)
})

test('a repository configuration absent from the trusted base fails closed', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const marker = join(tempRoot, 'odw-invoked')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFileSync(join(targetRepo, '.coderabbit.yaml'), `
pre_merge_checks:
  custom_checks:
    - mode: error
      name: Untrusted head command
      command: node -e "process.exit(9)"
`)
  execFileSync('git', ['-C', targetRepo, 'add', '.coderabbit.yaml'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'untrusted config change'])
  writePreparedEchoOdw(fakeOdw, { bodyPrefix: `appendFileSync('${marker}', 'yes')` })

  const completed = spawnSync(
    process.execPath,
    [cliPath,
      '--repo-root', targetRepo,
      '--base', base,
      '--state-root', join(tempRoot, 'state'),
      '--odw-bin', fakeOdw,
      '--runs-root', join(tempRoot, 'runs'),
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )

  assert.equal(completed.status, 1)
  assert.equal(completed.stdout, '')
  assert.match(completed.stderr, /cannot read trusted review configuration/u)
  assert.match(completed.stderr, /\.coderabbit\.yaml/u)
  assert.equal(existsSync(marker), false, 'ODW must not run after a trusted-base lookup failure')
})

test('repository-local gate policy executes the trusted base version for root, nested, and dot-prefixed names', async (t) => {
  for (const name of ['gates.yaml', 'nested/gates.yaml', '..policy.yaml']) {
    await t.test(name, (subtest) => {
      const { tempRoot, targetRepo } = setUpRecordRepo()
      subtest.after(() => rmSync(tempRoot, { recursive: true, force: true }))
      const config = join(targetRepo, name)
      mkdirSync(join(config, '..'), { recursive: true })
      const baseMarker = join(tempRoot, 'base-gate-ran')
      const headMarker = join(tempRoot, 'head-gate-ran')
      const policy = (marker) => `pre_merge_checks:\n  custom_checks:\n    - mode: error\n      name: Trusted fixture\n      command: touch ${marker}\n`
      writeFileSync(config, policy(baseMarker))
      execFileSync('git', ['-C', targetRepo, 'add', name])
      execFileSync('git', ['-C', targetRepo, 'commit', '--amend', '--no-edit'])
      const trustedBase = execFileSync('git', ['-C', targetRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      writeFileSync(config, policy(headMarker))
      execFileSync('git', ['-C', targetRepo, 'add', name])
      execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'change gate policy at head'])
      const fakeOdw = join(tempRoot, 'odw.mjs')
      writePreparedEchoOdw(fakeOdw)

      const result = spawnCli(['--repo-root', targetRepo, '--base', trustedBase, '--config', config,
        '--state-root', join(tempRoot, 'state'), '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')])

      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).ok, true)
      assert.equal(existsSync(baseMarker), true, 'the trusted base gate runs')
      assert.equal(existsSync(headMarker), false, 'the changed head gate never runs')
    })
  }
})

test('an external sibling configuration stays disk-backed even when its directory shares the repository prefix', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const sibling = `${targetRepo}-peer`
  mkdirSync(sibling)
  const marker = join(tempRoot, 'external-gate-ran')
  const config = join(sibling, 'gates.yaml')
  writeFileSync(config, `pre_merge_checks:\n  custom_checks:\n    - mode: error\n      name: External fixture\n      command: touch ${marker}\n`)
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writePreparedEchoOdw(fakeOdw)

  const result = spawnCli(['--repo-root', targetRepo, '--base', base, '--config', config,
    '--state-root', join(tempRoot, 'state'), '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true)
  assert.equal(existsSync(marker), true, 'the sibling configuration is read from disk')
})

test('a recordWithheld result stays successful and records nothing', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const stateRoot = join(tempRoot, 'trusted-state')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  // Partial planned coverage legitimately withholds recordInput; the CLI must
  // pass the result through unrecorded without flipping it to a record error.
  writeFileSync(
    fakeOdw,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, verdict: 'pass', findings: [], reportMarkdown: 'x', metrics: {},
  recordWithheld: { reason: 'planned finder coverage was incomplete', truncatedFileCount: 2, admissionRefusalCount: 0, lunaDowngradeCount: 0 } }))
`,
  )
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--state-root', stateRoot, '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const output = JSON.parse(result.stdout)

  assert.equal(result.status, 0)
  assert.equal(output.ok, true)
  assert.equal(output.stage, undefined, 'a withheld record is not a record error')
  assert.equal(output.recordWithheld.truncatedFileCount, 2)
  assert.equal(output.recorded, undefined, 'nothing is stamped as recorded')
  assert.equal(existsSync(join(stateRoot, 'reviews.toml')), false, 'nothing may be recorded')
})
