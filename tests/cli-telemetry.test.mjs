/**
 * Verifies CLI streaming and timeout recovery.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { repoRoot, cliPath, spawnCli, setUpRecordRepo, writePreparedEchoOdw } from './cli-test-support.mjs'

process.env.DAKAR_SKIP_CONTEXT_WARMUP = '1'

test('a hung log follow still fetches and records the completed result', () => {
  const { tempRoot, targetRepo, base, head } = setUpRecordRepo()
  const stateRoot = join(tempRoot, 'trusted-state')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  // `odw run` emits a run id; `odw logs --follow` hangs forever; `odw result`
  // returns a completed, recordable review. A follow timeout must not abandon
  // the billed result: the CLI fetches and records it in the grace window.
  writeFileSync(
    fakeOdw,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const values = process.argv.slice(2)
const mode = values[0]
if (mode === 'run') {
  const input = JSON.parse(values[values.indexOf('--args') + 1])
  writeFileSync(process.env.DAKAR_FAKE_PREPARED, JSON.stringify(input.prepared))
  process.stdout.write('started run 20260719-000000-abcdef\\n')
} else if (mode === 'logs') {
  // A genuine hang: the interval keeps the event loop alive until SIGTERM.
  setInterval(() => {}, 1000)
} else if (mode === 'result') {
  const prepared = JSON.parse(readFileSync(process.env.DAKAR_FAKE_PREPARED, 'utf8'))
  process.stdout.write(JSON.stringify({
    ok: true, verdict: 'pass',
    reviewBase: prepared.reviewBase, headCommit: prepared.headCommit,
    commitCount: prepared.commitCount, changedFiles: prepared.changedFiles,
    findings: [], reportMarkdown: 'x', metrics: {},
    recordInput: {
      reviewId: 'head-' + prepared.headCommit, baseCommit: prepared.reviewBase,
      headCommit: prepared.headCommit, commitCount: prepared.commitCount,
      changedFiles: prepared.changedFiles, models: ['gpt-5.6-luna'],
      findingsTotal: 0, summary: 'clean', metrics: {},
    },
  }))
}
`,
  )
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--state-root', stateRoot,
     '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs'), '--telemetry', '--timeout', '1'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DAKAR_FAKE_PREPARED: join(tempRoot, 'prepared.json') } },
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.recorded.ok, true, 'the completed result must be recorded despite the hung follow')
  assert.equal(output.recorded.headCommit, head)
  assert.match(result.stderr, /log follow timed out after 1s; attempting one result fetch/u)
})
test('a failed grace fetch reports the result error in the log envelope', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFileSync(
    fakeOdw,
    `#!/usr/bin/env node
const mode = process.argv[2]
if (mode === 'run') {
  process.stdout.write('started run 20260719-000000-fedcba\\n')
} else if (mode === 'logs') {
  setInterval(() => {}, 1000)
} else if (mode === 'result') {
  process.stderr.write('grace fetch exploded\\n')
  process.exitCode = 42
}
`,
  )
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base,
     '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs'), '--telemetry', '--timeout', '1'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /log follow timed out after 1s; attempting one result fetch/u)
  assert.match(result.stderr, /"stage":\s*"odw-logs"/u)
  assert.match(result.stderr, /"error":\s*"grace fetch exploded"/u)
})

test('a timed-out log follow polls again when its first result fetch is unavailable', (t) => {
  const { tempRoot, targetRepo, base, head } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  const preparedPath = join(tempRoot, 'prepared.json')
  const resultCallsPath = join(tempRoot, 'result-calls')
  writeFileSync(fakeOdw, `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const values = process.argv.slice(2)
if (values[0] === 'run') {
  const input = JSON.parse(values[values.indexOf('--args') + 1])
  writeFileSync(${JSON.stringify(preparedPath)}, JSON.stringify(input.prepared))
  process.stdout.write('started run 20260719-000000-abcdef\\n')
} else if (values[0] === 'logs') {
  setInterval(() => {}, 1000)
} else if (values[0] === 'result') {
  const calls = existsSync(${JSON.stringify(resultCallsPath)}) ? Number(readFileSync(${JSON.stringify(resultCallsPath)}, 'utf8')) : 0
  writeFileSync(${JSON.stringify(resultCallsPath)}, String(calls + 1))
  if (calls === 0) {
    process.stderr.write('result not available yet\\n')
    process.exitCode = 3
  } else {
    const prepared = JSON.parse(readFileSync(${JSON.stringify(preparedPath)}, 'utf8'))
    process.stdout.write(JSON.stringify({ ok: true, verdict: 'pass', findings: [], reportMarkdown: 'x', metrics: {},
      recordInput: { reviewId: 'head-' + prepared.headCommit, baseCommit: prepared.reviewBase,
        headCommit: prepared.headCommit, commitCount: prepared.commitCount,
        changedFiles: prepared.changedFiles, models: ['gpt-5.6-luna'], findingsTotal: 0,
        summary: 'clean', metrics: {} } }))
  }
}
`)
  chmodSync(fakeOdw, 0o755)
  const completed = spawnCli(['--repo-root', targetRepo, '--base', base, '--state-root', join(tempRoot, 'state'),
    '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs'), '--telemetry', '--timeout', '1'])
  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stderr, /log follow timed out after 1s; attempting one result fetch/u)
  assert.equal(Number(readFileSync(resultCallsPath, 'utf8')), 2, 'grace recovery retries an unavailable result')
  const output = JSON.parse(completed.stdout)
  assert.equal(output.recorded.ok, true)
  assert.equal(output.recorded.headCommit, head)
})

test('a non-timeout log failure warns and still fetches a successful result', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFileSync(fakeOdw, `#!/usr/bin/env node
const mode = process.argv[2]
if (mode === 'run') process.stdout.write('started run 20260719-000000-fedcba\\n')
if (mode === 'logs') process.exitCode = 7
if (mode === 'result') process.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))
`)
  chmodSync(fakeOdw, 0o755)
  const completed = spawnCli(['--repo-root', targetRepo, '--base', base, '--odw-bin', fakeOdw,
    '--runs-root', join(tempRoot, 'runs'), '--telemetry', '--timeout', '2'])
  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stderr, /ODW log stream exited with status 7; fetching result anyway/u)
  assert.equal(JSON.parse(completed.stdout).ok, true)
})

test('a normal log exit with failed result retrieval reports the odw-result envelope', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFileSync(fakeOdw, `#!/usr/bin/env node
const mode = process.argv[2]
if (mode === 'run') process.stdout.write('started run 20260719-000000-fedcba\\n')
if (mode === 'result') { process.stderr.write('result fetch failed\\n'); process.exitCode = 42 }
`)
  chmodSync(fakeOdw, 0o755)
  const completed = spawnCli(['--repo-root', targetRepo, '--base', base, '--odw-bin', fakeOdw,
    '--runs-root', join(tempRoot, 'runs'), '--telemetry', '--timeout', '1'])
  assert.equal(completed.status, 1)
  assert.equal(completed.stdout, '')
  assert.match(completed.stderr, /"stage":\s*"odw-result"/u)
  assert.match(completed.stderr, /"error":\s*"result fetch failed"/u)
})

test('an outer timeout below the retry worst case warns on stderr', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const stateRoot = join(tempRoot, 'trusted-state')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writePreparedEchoOdw(fakeOdw)
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--state-root', stateRoot,
     '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs'), '--timeout', '600'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )

  assert.equal(result.status, 0)
  assert.match(result.stderr, /below the retry schedule's worst case/u)
})
