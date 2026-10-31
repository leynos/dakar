/**
 * Verifies CLI streaming and timeout recovery.
 *
 * @module
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { repoRoot, cliPath, spawnCli, spawnCliSync as spawnSync, setUpRecordRepo, writePreparedEchoOdw } from './cli-test-support.mjs'

/** Parse the single bounded result-poll event the CLI reports on stderr. */
function pollEvent(stderr) {
  const line = stderr.split('\n').find((candidate) => candidate.includes('"event":"odw_result_poll"'))
  assert.ok(line, 'the CLI must report a bounded result-poll event')
  return JSON.parse(line)
}

test('a hung log follow still fetches and records the completed result', (t) => {
  const { tempRoot, targetRepo, base, head } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const stateRoot = join(tempRoot, 'trusted-state')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  const traceCapture = join(tempRoot, 'traceparent')
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
  writeFileSync(process.env.DAKAR_TRACE_CAPTURE, process.env.TRACEPARENT)
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
      env: { ...process.env, DAKAR_FAKE_PREPARED: join(tempRoot, 'prepared.json'), DAKAR_TRACE_CAPTURE: traceCapture } },
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.recorded.ok, true, 'the completed result must be recorded despite the hung follow')
  assert.equal(output.recorded.headCommit, head)
  assert.match(result.stderr, /log follow timed out after 1s; attempting one result fetch/u)
  const traceLinkLine = result.stderr.split('\n').find((line) => line.includes('"event":"dakar_trace_link"'))
  const traceLink = JSON.parse(traceLinkLine)
  const [version, traceId] = readFileSync(traceCapture, 'utf8').trim().split('-')
  assert.equal(version, '00', 'the ODW subprocess receives W3C trace context')
  assert.equal(traceId, traceLink.traceId, 'the ODW run ID is linked to the propagated trace')
  assert.match(traceLink.runId, /^20260719-000000-/u, 'the trace link identifies the launched ODW run')
})
test('a failed grace fetch reports the result error in the log envelope', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
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
  assert.match(result.stderr, /"terminal": "failed"/u, 'the failure envelope carries the terminal poll state')
  assert.match(result.stderr, /"category": "nonzero_exit"/u, 'the failure envelope carries a bounded category')
  const poll = pollEvent(result.stderr)
  assert.equal(poll.terminal, 'failed')
  assert.equal(poll.category, 'nonzero_exit')
  assert.ok(poll.attempts >= 2, 'the grace window retries the result fetch')
  assert.equal(poll.failures, poll.attempts)
  assert.match(result.stderr, new RegExp(`"attempts": ${poll.attempts}\\b`, 'u'),
    'the failure envelope carries the attempt count')
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
  const poll = pollEvent(completed.stderr)
  assert.equal(poll.attempts, 2, 'the successful poll reports every attempt')
  assert.equal(poll.failures, 1, 'the successful poll reports the retried failure')
  assert.equal(poll.terminal, 'completed')
  assert.equal(poll.category, 'none')
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
  assert.match(completed.stderr, /"terminal": "failed"/u, 'the failure envelope carries the terminal poll state')
  assert.match(completed.stderr, /"category": "nonzero_exit"/u, 'the failure envelope carries a bounded category')
  const poll = pollEvent(completed.stderr)
  assert.equal(poll.terminal, 'failed')
  assert.equal(poll.category, 'nonzero_exit')
  assert.ok(poll.attempts >= 2, 'the poll retries until its deadline')
  assert.equal(poll.failures, poll.attempts)
  assert.match(completed.stderr, new RegExp(`"attempts": ${poll.attempts}\\b`, 'u'),
    'the failure envelope reports the same attempt count as the event')
})

test('a missing ODW executable during result retrieval reports the spawn error', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFileSync(fakeOdw, `#!/usr/bin/env node
import { unlinkSync } from 'node:fs'
const mode = process.argv[2]
if (mode === 'run') process.stdout.write('started run 20260719-000000-fedcba\\n')
if (mode === 'logs') unlinkSync(process.argv[1])
`)
  chmodSync(fakeOdw, 0o755)
  const completed = spawnCli(['--repo-root', targetRepo, '--base', base, '--odw-bin', fakeOdw,
    '--runs-root', join(tempRoot, 'runs'), '--telemetry', '--timeout', '1'])
  assert.equal(completed.status, 1, 'a missing result executable must fail the CLI')
  assert.equal(completed.stdout, '', 'a failed result fetch must not write a result')
  assert.match(completed.stderr, /"stage":\s*"odw-result"/u, 'the failure must retain the result-stage envelope')
  assert.match(completed.stderr, /ENOENT/u, 'the envelope must explain the missing executable')
  assert.doesNotMatch(completed.stderr, /Cannot read properties of (?:null|undefined)/u, 'missing spawn streams must not mask the actual failure')
  assert.match(completed.stderr, /"category": "spawn_error"/u, 'a missing executable is classified as a spawn error')
  const poll = pollEvent(completed.stderr)
  assert.equal(poll.category, 'spawn_error')
  assert.ok(poll.attempts >= 2, 'the spawn error is retried until its deadline')
  assert.equal(poll.failures, poll.attempts)
})

test('a zero-exit result with malformed JSON reports one failed outcome', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFileSync(fakeOdw, `#!/usr/bin/env node
const mode = process.argv[2]
if (mode === 'run') process.stdout.write('started run 20260719-000000-fedcba\\n')
if (mode === 'result') process.stdout.write('this is not the result JSON\\n')
`)
  chmodSync(fakeOdw, 0o755)
  const completed = spawnCli(['--repo-root', targetRepo, '--base', base, '--odw-bin', fakeOdw,
    '--runs-root', join(tempRoot, 'runs'), '--telemetry', '--timeout', '1'])
  assert.equal(completed.status, 1, 'an unusable result payload must fail the CLI')
  assert.equal(completed.stdout, '', 'an unusable result payload must not write a result')
  assert.match(completed.stderr, /"stage":\s*"odw-result"/u)
  assert.match(completed.stderr, /"error":\s*"invalid ODW result:/u,
    'the envelope explains that the payload could not be parsed')
  assert.match(completed.stderr, /"terminal": "failed"/u, 'the envelope carries the failed poll state')
  assert.match(completed.stderr, /"category": "invalid_output"/u, 'a malformed payload is its own category')
  const poll = pollEvent(completed.stderr)
  assert.equal(poll.terminal, 'failed', 'the event must not claim a completed poll')
  assert.equal(poll.category, 'invalid_output')
  assert.equal(poll.attempts, 1, 'a zero-exit fetch is not retried')
  assert.equal(poll.failures, 1, 'the parse failure counts as one failed retrieval')
  assert.match(completed.stderr, new RegExp(`"attempts": ${poll.attempts}\\b`, 'u'),
    'the failure envelope reports the same attempt count as the event')
  assert.match(completed.stderr, new RegExp(`"failures": ${poll.failures}\\b`, 'u'),
    'the failure envelope reports the same failure count as the event')
})

test('a zero-exit result without a boolean ok reports one failed outcome', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFileSync(fakeOdw, `#!/usr/bin/env node
const mode = process.argv[2]
if (mode === 'run') process.stdout.write('started run 20260719-000000-fedcba\\n')
if (mode === 'result') process.stdout.write('{}\\n')
`)
  chmodSync(fakeOdw, 0o755)
  const completed = spawnCli(['--repo-root', targetRepo, '--base', base, '--odw-bin', fakeOdw,
    '--runs-root', join(tempRoot, 'runs'), '--telemetry', '--timeout', '1'])
  assert.equal(completed.status, 1, 'a payload without a boolean ok must fail the CLI')
  assert.equal(completed.stdout, '', 'a payload without a boolean ok must not write a result')
  assert.match(completed.stderr, /"stage":\s*"odw-result"/u)
  assert.match(completed.stderr, /"error":\s*"invalid ODW result: ODW result must contain a boolean/u,
    'the envelope explains that the payload carries no usable verdict')
  assert.match(completed.stderr, /"terminal": "failed"/u, 'the envelope carries the failed poll state')
  assert.match(completed.stderr, /"category": "invalid_output"/u, 'a shapeless payload is its own category')
  const poll = pollEvent(completed.stderr)
  assert.equal(poll.terminal, 'failed', 'the event must not claim a completed poll')
  assert.equal(poll.category, 'invalid_output')
  assert.equal(poll.attempts, 1, 'a zero-exit fetch is not retried')
  assert.equal(poll.failures, 1, 'the shape failure counts as one failed retrieval')
})

test('an outer timeout below the retry worst case warns on stderr', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
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
