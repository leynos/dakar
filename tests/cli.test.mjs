/**
 * @file Verify the installable Dakar review CLI contract.
 *
 * The tests cover argument help, dry-run JSON output, telemetry channel
 * separation, configuration resolution, review-history recovery, and local Bun
 * installation behaviour.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  assert.match(output, /--telemetry/u)
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
  assert.equal(result.agentInstructionsIncluded, true)
})

test('CLI telemetry streams ODW progress to stderr and keeps stdout JSON', () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-runs-'))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-empty-xdg-config-'))
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--dry-run',
      '--repo-root',
      repoRoot,
      '--runs-root',
      runsRoot,
      '--timeout',
      '20',
      '--telemetry',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, XDG_CONFIG_HOME: xdgConfig },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const output = JSON.parse(result.stdout)

  assert.equal(result.status, 0)
  assert.equal(output.ok, true)
  assert.equal(output.dryRun, true)
  assert.match(result.stderr, /dakar-review: following ODW run \d{8}-\d{6}-[0-9a-f]+/u)
  assert.match(result.stderr, /run_started/u)
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

test('CLI rejects missing explicit config paths before ODW starts', () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, '--dry-run', '--repo-root', repoRoot, '--config', 'does-not-exist.yaml'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const error = JSON.parse(result.stderr)

  assert.equal(result.status, 1)
  assert.equal(error.stage, 'cli')
  assert.match(error.error, /explicit config does not exist/u)
})

test('CLI includes repository AGENTS.md instructions in workflow args', () => {
  const targetRepo = mkdtempSync(join(tmpdir(), 'dakar-agents-repo-'))
  const runsRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-runs-'))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-empty-xdg-config-'))
  writeFileSync(join(targetRepo, 'AGENTS.md'), '# Agent Instructions\n\nRespect local review policy.\n')

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
  assert.equal(result.agentInstructionsIncluded, true)
})

test('CLI recovers review-history recording when ODW record phase fails', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-record-recovery-'))
  const stateFile = join(tempRoot, 'state', 'reviews.toml')
  const fakeOdw = join(tempRoot, 'odw')
  const fakeResult = {
    ok: false,
    stage: 'record',
    stateFile,
    reviewBase: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    commitCount: 1,
    changedFiles: ['src/example.js'],
    findings: [],
    reportMarkdown: '## Verdict: Pass\n\nNo accepted findings.',
    metrics: {
      modelAssignments: [{ model: 'gpt-5.5/high' }],
    },
    recorded: { ok: false },
  }
  writeFileSync(
    fakeOdw,
    `#!/bin/sh\nprintf 'running fake-run ...\\n%s\\n' '${JSON.stringify(fakeResult).replace(/'/g, "'\"'\"'")}'\n`,
  )
  chmodSync(fakeOdw, 0o755)

  const output = runCli([
    '--repo-root',
    repoRoot,
    '--odw-bin',
    fakeOdw,
    '--runs-root',
    join(tempRoot, 'runs'),
  ])
  const result = JSON.parse(output)
  const stateText = readFileSync(stateFile, 'utf8')

  assert.equal(result.ok, true)
  assert.equal(result.recorded.ok, true)
  assert.equal(result.recorded.recoveredBy, 'dakar-review')
  assert.match(stateText, /head_commit = "bbbb/u)
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
