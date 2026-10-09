/**
 * Shared isolated repository and fake-process fixtures for CLI tests.
 *
 * @module
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

/** Absolute Dakar repository root. */
export const repoRoot = resolve(new URL('..', import.meta.url).pathname)
/** Authored CLI entry point. */
export const cliPath = join(repoRoot, 'bin', 'dakar-review.mjs')
const CONTEXT_WARMUP_EVENT_PREFIX = 'dakar-review: warmup '
process.env.DAKAR_SKIP_CONTEXT_WARMUP = '1'

/** Parse bounded structured warmup events from the CLI's stderr channel. */
export function contextWarmupEvents(stderr) {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith(CONTEXT_WARMUP_EVENT_PREFIX))
    .map((line) => JSON.parse(line.slice(CONTEXT_WARMUP_EVENT_PREFIX.length)))
}

/** Executes the authored CLI and captures its final stdout. */
export function runCli(args, options = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Spawns the CLI with context warm-up disabled and both output streams captured. */
export function spawnCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DAKAR_SKIP_CONTEXT_WARMUP: '1', ...env },
  })
}

/** Loads the private CLI parser without exporting it from the executable module. */
export function loadCliArgumentParser() {
  const source = readFileSync(cliPath, 'utf8')
  const start = source.indexOf('const OPTION_SPECS = new Map([')
  const end = source.indexOf('\n/**\n * Extract and parse the first JSON object found in a string of text.', start)
  assert.notEqual(start, -1, 'the CLI option table should exist')
  assert.notEqual(end, -1, 'the private parser section should have a stable boundary')
  return new Function(`${source.slice(start, end)}\nreturn parseArgs\n`)()
}

/**
 * Builds one isolated repository fixture for CLI argument or config capture.
 *
 * @param {'args' | 'config'} kind - The fake ODW response the fixture captures.
 * @returns {{ targetRepo: string, runsRoot: string, xdgConfig: string, fakeOdw: string }}
 *   The isolated repository, run root, XDG config root, and executable paths.
 */
export function setUpCaptureRepo(kind) {
  if (kind === 'args') {
    return makeCaptureRepo({
      repoPrefix: 'dakar-tuning-repo-',
      fakeOdwFilename: 'capture-odw.mjs',
      fakeOdwScript: `#!/usr/bin/env node
const values = process.argv.slice(2)
const input = JSON.parse(values[values.indexOf('--args') + 1])
process.stdout.write(JSON.stringify({ ok: true, receivedArgs: input }))
`,
    })
  }

  return makeCaptureRepo({
    repoPrefix: 'dakar-config-repo-',
    fakeOdwFilename: 'capture-config-odw.mjs',
    fakeOdwScript: `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const values = process.argv.slice(2)
const configPath = values[values.indexOf('--config') + 1]
const config = JSON.parse(readFileSync(configPath, 'utf8'))
process.stdout.write(JSON.stringify({ ok: true, configPath, config }))
`,
  })
}

/**
 * Allocate the shared committed-repository and fake-ODW scaffold for capture fixtures.
 *
 * @param {object} options - Fixture-specific repository and executable settings.
 * @param {string} options.repoPrefix - Prefix for the temporary repository directory.
 * @param {string} options.fakeOdwFilename - Name of the fake ODW executable in that repository.
 * @param {string} options.fakeOdwScript - Exact executable source used by the fixture.
 * @returns {{ targetRepo: string, runsRoot: string, xdgConfig: string, fakeOdw: string }}
 *   The isolated repository, run root, XDG config root, and executable paths.
 */
function makeCaptureRepo({ repoPrefix, fakeOdwFilename, fakeOdwScript }) {
  const targetRepo = mkdtempSync(join(tmpdir(), repoPrefix))
  const runsRoot = mkdtempSync(join(tmpdir(), 'dakar-cli-runs-'))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-empty-xdg-config-'))
  const fakeOdw = join(targetRepo, fakeOdwFilename)
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  execFileSync('git', ['-C', targetRepo, 'commit', '--allow-empty', '-m', 'initial'])
  writeFileSync(fakeOdw, fakeOdwScript)
  chmodSync(fakeOdw, 0o755)
  return { targetRepo, runsRoot, xdgConfig, fakeOdw }
}

// Builds a committed repository with a base commit and a distinct head commit so
// the host-side prepare step yields a non-skip review range whose headCommit,
// reviewBase, commitCount, and changedFiles a faithful fake ODW can echo back.
/** Creates a committed review range for preparation and recording tests. */
export function setUpRecordRepo() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-record-'))
  const targetRepo = join(tempRoot, 'repo')
  mkdirSync(targetRepo, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  writeFileSync(join(targetRepo, 'a.txt'), 'a\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'a.txt'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'base'])
  const base = execFileSync('git', ['-C', targetRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(join(targetRepo, 'b.txt'), 'b\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'b.txt'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'head'])
  const head = execFileSync('git', ['-C', targetRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return { tempRoot, targetRepo, base, head }
}

// A faithful fake ODW that echoes the prepared snapshot into both the result and
// recordInput, as the real workflow does. `recordInputOverride` is spread onto
// recordInput last (so a test can tamper with a single field), and `bodyPrefix`
// is inlined before the result is emitted (so a fake can append DAKAR_USAGE_LOG
// lines first).
/** Writes a faithful prepared-review echo executable. */
export function writePreparedEchoOdw(path, { recordInputOverride = '{}', bodyPrefix = '', captureArgs = false } = {}) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const values = process.argv.slice(2)
const input = JSON.parse(values[values.indexOf('--args') + 1])
const prepared = input.prepared
${bodyPrefix}
const result = {
  ok: true,
  verdict: 'pass',
  ${captureArgs ? 'receivedArgs: input,' : ''}
  reviewBase: prepared.reviewBase,
  headCommit: prepared.headCommit,
  commitCount: prepared.commitCount,
  changedFiles: prepared.changedFiles,
  findings: [],
  sarif: {
    version: '2.1.0',
    runs: [{ properties: { dakar: { pricingTableVersion: '2026-07-18' } } }],
  },
  reportMarkdown: '# Dakar review\\n\\nNo blocking findings were accepted.',
  metrics: { taskCount: 2 },
  recordInput: {
    reviewId: 'head-' + prepared.headCommit,
    baseCommit: prepared.reviewBase,
    headCommit: prepared.headCommit,
    commitCount: prepared.commitCount,
    changedFiles: prepared.changedFiles,
    models: ['gpt-5.5/high'],
    findingsTotal: 0,
    summary: 'No blocking findings were accepted.',
    metrics: { taskCount: 2 },
    ...${recordInputOverride},
  },
}
process.stdout.write(JSON.stringify(result))
`,
  )
  chmodSync(path, 0o755)
}

/** Creates a committed AGENTS.md fixture and an ODW that captures workflow args. */
export function setUpAgentInstructionRepo(t, content) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-agent-instructions-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const targetRepo = join(tempRoot, 'repo')
  mkdirSync(targetRepo, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  if (content !== undefined) {
    writeFileSync(join(targetRepo, 'AGENTS.md'), content)
    execFileSync('git', ['-C', targetRepo, 'add', 'AGENTS.md'])
  }
  execFileSync('git', ['-C', targetRepo, 'commit', '--allow-empty', '-m', 'trusted base'])
  const fakeOdw = join(tempRoot, 'capture-odw.mjs')
  writeFileSync(fakeOdw, `#!/usr/bin/env node
const values = process.argv.slice(2)
const input = JSON.parse(values[values.indexOf('--args') + 1])
process.stdout.write(JSON.stringify({ ok: true, receivedArgs: input }))
`)
  chmodSync(fakeOdw, 0o755)
  return { tempRoot, targetRepo, fakeOdw, runsRoot: join(tempRoot, 'runs') }
}
