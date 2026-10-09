/**
 * Verifies CLI snapshot validation, usage, and recording.
 *
 * @module
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { repoRoot, cliPath, runCli, spawnCli, setUpArgsCaptureRepo, setUpRecordRepo, writePreparedEchoOdw } from './cli-test-support.mjs'

process.env.DAKAR_SKIP_CONTEXT_WARMUP = '1'

test('CLI records a successful workflow result via appendReview through the trusted state root', () => {
  const { tempRoot, targetRepo, base, head } = setUpRecordRepo()
  const fakeOdw = join(tempRoot, 'odw.mjs')
  // A successful workflow result no longer records itself; it emits recordInput
  // echoing the prepared snapshot, and the CLI records it, deriving the state
  // path from the trusted repo-root/state-root, never a workflow-supplied path.
  writePreparedEchoOdw(fakeOdw)

  const output = runCli([
    '--repo-root',
    targetRepo,
    '--base',
    base,
    '--state-root',
    join(tempRoot, 'trusted-state'),
    '--odw-bin',
    fakeOdw,
    '--runs-root',
    join(tempRoot, 'runs'),
  ])
  const result = JSON.parse(output)
  const stateText = readFileSync(result.stateFile, 'utf8')

  assert.equal(result.ok, true)
  assert.equal(result.recorded.ok, true)
  assert.equal(result.recorded.recordedBy, 'dakar-review')
  // The CLI derives the path from the trusted roots.
  assert.ok(result.stateFile.startsWith(`${join(tempRoot, 'trusted-state')}/`))
  // The recorded head is the prepared head, validated against the snapshot.
  assert.ok(stateText.includes(`head_commit = "${head}"`))
  assert.match(stateText, /taskCount/u)
  // The retired recovery marker must not reappear on the primary path.
  assert.doesNotMatch(stateText, /recordRecoveredByCli/u)
  assert.equal(result.recorded.recoveredBy, undefined)
})

test('CLI fails closed with a record stage when a successful result lacks recordInput', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const stateRoot = join(tempRoot, 'trusted-state')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  // An ok result with no recordInput must never be treated as a complete review;
  // the CLI refuses to record and exits non-zero.
  writeFileSync(
    fakeOdw,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, verdict: 'pass', findings: [], reportMarkdown: 'x', metrics: {} }))
`,
  )
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--state-root', stateRoot, '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const output = JSON.parse(result.stdout)

  assert.equal(result.status, 1)
  assert.equal(output.ok, false)
  assert.equal(output.stage, 'record')
  assert.match(output.error, /lacked recordInput/u)
  assert.equal(output.recorded.ok, false)
  assert.equal(existsSync(join(stateRoot, 'reviews.toml')), false)
})

test('CLI refuses to record when recordInput contradicts the prepared snapshot', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const stateRoot = join(tempRoot, 'trusted-state')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  // recordInput carries a valid-shaped but different headCommit; the CLI must
  // refuse to record it, keep recordInput for retry, and append nothing.
  writePreparedEchoOdw(fakeOdw, { recordInputOverride: `{ headCommit: 'c'.repeat(40) }` })

  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--state-root', stateRoot, '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const output = JSON.parse(result.stdout)

  assert.equal(result.status, 1)
  assert.equal(output.ok, false)
  assert.equal(output.stage, 'record')
  assert.match(output.error, /headCommit/u)
  assert.ok(output.recordInput, 'recordInput is preserved for manual retry')
  assert.equal(output.recordInput.headCommit, 'c'.repeat(40))
  assert.equal(existsSync(join(stateRoot, 'reviews.toml')), false)
})

test('CLI refuses malformed, incomplete, and reordered changed-file snapshots', async (t) => {
  const cases = [
    { name: 'null changedFiles', override: '{ changedFiles: null }', expected: () => null },
    { name: 'string changedFiles', override: "{ changedFiles: 'b.txt' }", expected: () => 'b.txt' },
    { name: 'shorter changedFiles', override: '{ changedFiles: [] }', expected: () => [] },
    { name: 'different path at the same length', override: "{ changedFiles: ['other.txt'] }", expected: () => ['other.txt'] },
    {
      name: 'reversed changed-file order',
      override: '{ changedFiles: [...prepared.changedFiles].reverse() }',
      expected: (output) => [...output.changedFiles].reverse(),
      addSecondFile: true,
    },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, (subtest) => {
      const { tempRoot, targetRepo, base } = setUpRecordRepo()
      subtest.after(() => rmSync(tempRoot, { recursive: true, force: true }))
      const stateRoot = join(tempRoot, 'trusted-state')
      const fakeOdw = join(tempRoot, 'odw.mjs')
      if (scenario.addSecondFile) {
        writeFileSync(join(targetRepo, 'c.txt'), 'c\n')
        execFileSync('git', ['-C', targetRepo, 'add', 'c.txt'])
        execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'second changed file'])
      }
      writePreparedEchoOdw(fakeOdw, { recordInputOverride: scenario.override })

      const result = spawnSync(
        process.execPath,
        [cliPath, '--repo-root', targetRepo, '--base', base, '--state-root', stateRoot,
          '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, DAKAR_SKIP_CONTEXT_WARMUP: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const output = JSON.parse(result.stdout)

      assert.equal(result.status, 1, 'a changedFiles mismatch exits non-zero')
      assert.equal(output.ok, false, 'a changedFiles mismatch marks the result unsuccessful')
      assert.equal(output.stage, 'record', 'a changedFiles mismatch is reported at the record stage')
      assert.match(output.error, /recordInput\.changedFiles does not match the prepared review snapshot/u, 'the mismatch diagnostic identifies changedFiles')
      assert.ok(output.recordInput, 'the mismatched recordInput is preserved for manual retry')
      assert.deepEqual(output.recordInput.changedFiles, scenario.expected(output), 'the original changedFiles value is preserved')
      if (scenario.addSecondFile) {
        assert.equal(output.changedFiles.length, 2, 'the order fixture contains two changed files')
      }
      assert.equal(existsSync(join(stateRoot, 'reviews.toml')), false, 'a mismatch never appends review history')
    })
  }
})

test('CLI attaches reported usage before recording so reviews.toml carries the tokens', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const stateRoot = join(tempRoot, 'trusted-state')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  // The fake writes two usage lines to the CLI-provided DAKAR_USAGE_LOG before
  // emitting its result; the CLI must attach them before recording so the tokens
  // land in the persisted metrics_json, not just the printed result.
  writePreparedEchoOdw(fakeOdw, {
    bodyPrefix: `const usageLog = process.env.DAKAR_USAGE_LOG
appendFileSync(usageLog, JSON.stringify({ model: 'gpt-5.6-luna', usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 12000 } }) + '\\n')
appendFileSync(usageLog, JSON.stringify({ model: 'gpt-5.6-terra', usage: { input: 40000, output: 2000, cacheRead: 8000, cacheWrite: 0 } }) + '\\n')`,
  })

  const output = JSON.parse(
    runCli(['--repo-root', targetRepo, '--base', base, '--state-root', stateRoot, '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')]),
  )

  assert.equal(output.ok, true, 'usage-bearing ODW output completes successfully')
  assert.equal(Array.isArray(output.metrics.reportedUsage), true, 'reported usage is attached as an ordered array')
  assert.equal(output.metrics.reportedUsage.length, 2, 'both model usage records are retained')
  assert.deepEqual(output.metrics.reportedTokens, { input: 41000, output: 2500, cacheRead: 8000, cacheWrite: 12000 }, 'reported tokens sum across model records')
  assert.equal(output.sarif.runs[0].properties.dakar.reportedUsage.length, 2, 'SARIF carries the same usage records')
  assert.deepEqual(
    output.sarif.runs[0].properties.dakar.reportedTokens,
    { input: 41000, output: 2500, cacheRead: 8000, cacheWrite: 12000 },
    'SARIF carries the same reported token totals',
  )
  const stateText = readFileSync(output.stateFile, 'utf8')
  assert.match(stateText, /reportedTokens/u, 'persisted review history contains reported token metrics')
  assert.match(stateText, /41000/u, 'persisted review history contains the summed input token count')
})

test('CLI consumes usage logs and preserves record metrics across absent, empty, invalid, and mixed records', async (t) => {
  const usage = { model: 'fixture', usage: { input: '10', output: 4, cacheRead: '3' } }
  const cases = [
    { name: 'no log', content: null, records: [] },
    { name: 'empty log', content: '', records: [] },
    { name: 'blank and invalid JSON only', content: '\nnot-json\n', records: [] },
    { name: 'valid records among blanks and invalid JSON', content: `\nnot-json\n${JSON.stringify(usage)}\n${JSON.stringify({ model: 'missing-usage' })}\n`, records: [usage, { model: 'missing-usage' }] },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, (subtest) => {
      const { tempRoot, targetRepo, base } = setUpRecordRepo()
      subtest.after(() => rmSync(tempRoot, { recursive: true, force: true }))
      const stateRoot = join(tempRoot, 'state')
      const fakeOdw = join(tempRoot, 'odw.mjs')
      const logPathCapture = join(tempRoot, 'log-path')
      writePreparedEchoOdw(fakeOdw, {
        recordInputOverride: "{ metrics: { existing: 'retained', reportedTokens: { input: 99 }, reportedUsage: ['prior'] } }",
        bodyPrefix: `appendFileSync(${JSON.stringify(logPathCapture)}, process.env.DAKAR_USAGE_LOG)\n` +
          `if (${JSON.stringify(scenario.content)} !== null) appendFileSync(process.env.DAKAR_USAGE_LOG, ${JSON.stringify(scenario.content)})`,
      })
      const completed = spawnCli(['--repo-root', targetRepo, '--base', base, '--state-root', stateRoot,
        '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')])
      assert.equal(completed.status, 0, completed.stderr || 'a valid usage log must not fail the CLI')
      const output = JSON.parse(completed.stdout)
      assert.equal(output.ok, true, 'a well-formed usage-log fixture completes successfully')
      assert.equal(output.recordInput.metrics.existing, 'retained', 'existing record metrics remain intact')
      assert.equal(output.metrics.taskCount, 2, 'existing output metrics remain intact')
      const usageLogPath = readFileSync(logPathCapture, 'utf8')
      assert.equal(existsSync(usageLogPath), false, 'a successfully read usage log is removed')
      if (scenario.records.length === 0) {
        assert.equal(output.metrics.reportedUsage, undefined, 'no valid records leave the result unannotated')
        assert.deepEqual(output.recordInput.metrics.reportedTokens, { input: 99 }, 'absent usage preserves prior token metrics')
        assert.deepEqual(output.recordInput.metrics.reportedUsage, ['prior'], 'absent usage preserves prior usage metrics')
      } else {
        assert.deepEqual(output.metrics.reportedUsage, scenario.records, 'valid records retain their original order')
        assert.deepEqual(output.metrics.reportedTokens, { input: 10, output: 4, cacheRead: 3, cacheWrite: 0 }, 'numeric strings and missing token fields aggregate with existing conversion rules')
        assert.deepEqual(output.recordInput.metrics.reportedTokens, output.metrics.reportedTokens, 'recordInput receives the same reported token totals')
        assert.deepEqual(output.sarif.runs[0].properties.dakar.reportedTokens, output.metrics.reportedTokens, 'SARIF receives the same reported token totals')
        assert.match(readFileSync(output.stateFile, 'utf8'), /reportedTokens/u, 'persisted history carries reported totals')
        assert.match(readFileSync(output.stateFile, 'utf8'), /cacheRead/u, 'persisted history carries the same token fields')
      }
    })
  }
})

test('CLI initializes absent record metrics before copying reported usage', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writePreparedEchoOdw(fakeOdw, {
    recordInputOverride: '{ metrics: undefined }',
    bodyPrefix: "appendFileSync(process.env.DAKAR_USAGE_LOG, JSON.stringify({ usage: { input: 5 } }) + '\\n')",
  })
  const completed = spawnCli(['--repo-root', targetRepo, '--base', base, '--state-root', join(tempRoot, 'state'),
    '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')])
  assert.equal(completed.status, 0, completed.stderr || 'reported usage must not prevent recording')
  const output = JSON.parse(completed.stdout)
  assert.deepEqual(output.recordInput.metrics.reportedTokens, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, 'reported tokens initialize absent record metrics')
})

test('CLI dry-run does not copy reported metrics into recordInput or write history', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFileSync(fakeOdw, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, dryRun: true,
  metrics: { reportedTokens: { input: 7 } }, recordInput: { metrics: { existing: 'retained' } } }))\n`)
  chmodSync(fakeOdw, 0o755)
  const stateRoot = join(tempRoot, 'state')
  const completed = spawnCli(['--dry-run', '--repo-root', targetRepo, '--base', base, '--state-root', stateRoot,
    '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')])
  assert.equal(completed.status, 0, completed.stderr || 'dry-run result must complete successfully')
  const output = JSON.parse(completed.stdout)
  assert.deepEqual(output.recordInput.metrics, { existing: 'retained' }, 'dry-run leaves recordInput metrics unchanged')
  assert.equal(existsSync(join(stateRoot, 'reviews.toml')), false, 'dry-run does not append review history')
})

test('CLI defaults the ODW wait timeout to 3600 seconds when --timeout is omitted', () => {
  const { targetRepo, runsRoot, xdgConfig } = setUpArgsCaptureRepo()
  const fakeOdw = join(targetRepo, 'argv-odw.mjs')
  writeFileSync(
    fakeOdw,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, dryRun: true, receivedArgv: process.argv.slice(2) }))
`,
  )
  chmodSync(fakeOdw, 0o755)

  const result = JSON.parse(
    runCli(['--dry-run', '--repo-root', targetRepo, '--base', 'HEAD', '--runs-root', runsRoot, '--odw-bin', fakeOdw], {
      env: { XDG_CONFIG_HOME: xdgConfig },
    }),
  )
  const argv = result.receivedArgv
  const timeoutIndex = argv.indexOf('--timeout')

  assert.notEqual(timeoutIndex, -1, 'the ODW run carries a --timeout flag')
  assert.equal(argv[timeoutIndex + 1], '3600', 'the default wait timeout exceeds worstCaseReviewSeconds')
})

test('CLI warns about a missing OPENAI_API_KEY even for an unknown routing policy', () => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-empty-xdg-config-'))
  const fakeOdw = join(tempRoot, 'odw.mjs')
  // An unknown routing policy clamps to deterministic-flex-v1, which still needs
  // the pi Flex key, so the missing-key warning must not be suppressed.
  writePreparedEchoOdw(fakeOdw)

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--repo-root', targetRepo,
      '--base', base,
      '--state-root', join(tempRoot, 'state'),
      '--odw-bin', fakeOdw,
      '--runs-root', join(tempRoot, 'runs'),
      '--routing-policy', 'bogus',
    ],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: xdgConfig, OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  assert.match(result.stderr, /OPENAI_API_KEY is not set/u)
})

test('CLI fails closed with a record stage when appendReview rejects the review', (t) => {
  // Scenario: a review completes, but the record input it carries is invalid.
  // Invariant: the CLI fails closed. It reports stage 'record', keeps
  // recordInput so the operator can retry by hand, claims no recorded entry,
  // and exits non-zero.
  //
  // The review runs against a purpose-built fixture repository with a commit
  // ahead of an explicit base, never the checkout under test. Pointed at its
  // own checkout the CLI finds no unreviewed commits, short-circuits with
  // `skipped: true` before the fake ODW is ever spawned, and exits 0, so the
  // case silently stopped testing anything it claims to.
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-record-failure-xdg-'))
  t.after(() => rmSync(xdgConfig, { recursive: true, force: true }))
  const fakeOdw = join(tempRoot, 'odw')
  // recordInput carries an invalid headCommit so appendReview throws; the CLI
  // must surface stage: 'record', keep recordInput for manual retry, and exit
  // non-zero without claiming a recorded entry.
  const fakeResult = {
    ok: true,
    verdict: 'pass',
    reviewBase: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    commitCount: 1,
    changedFiles: ['src/example.js'],
    findings: [],
    reportMarkdown: '# Dakar review\n\nNo blocking findings were accepted.',
    metrics: {},
    recordInput: {
      reviewId: 'head-bbbb',
      baseCommit: 'a'.repeat(40),
      headCommit: 'not-a-real-commit',
      commitCount: 1,
      changedFiles: ['src/example.js'],
      models: ['gpt-5.5/high'],
      findingsTotal: 0,
      summary: 'No blocking findings were accepted.',
      metrics: { taskCount: 2 },
    },
  }
  writeFileSync(
    fakeOdw,
    `#!/bin/sh\nprintf 'running fake-run ...\\n%s\\n' '${JSON.stringify(fakeResult).replace(/'/g, "'\"'\"'")}'\n`,
  )
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--repo-root',
      targetRepo,
      '--base',
      base,
      '--state-root',
      join(tempRoot, 'trusted-state'),
      '--odw-bin',
      fakeOdw,
      '--runs-root',
      join(tempRoot, 'runs'),
    ],
    {
      cwd: targetRepo,
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: xdgConfig },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const output = JSON.parse(result.stdout)

  assert.equal(result.status, 1)
  assert.equal(output.ok, false)
  assert.equal(output.stage, 'record')
  assert.equal(output.recorded.ok, false)
  assert.ok(output.recordInput, 'recordInput is preserved for manual retry')
  assert.equal(output.recordInput.headCommit, 'not-a-real-commit')
})

test('CLI leaves reviews.toml untouched and exits non-zero for a deferred result', (t) => {
  // Scenario: the workflow defers instead of producing a verdict.
  // Invariant: nothing is recorded. The deferred JSON goes to stdout, no
  // reviews.toml appears under the trusted state root, and the exit status is
  // non-zero, so the head stays unreviewed and a later run picks it up again.
  //
  // As above, the review runs against a purpose-built fixture repository so the
  // case cannot depend on whether the checkout under test happens to have
  // commits ahead of its review base.
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const xdgConfig = mkdtempSync(join(tmpdir(), 'dakar-record-deferred-xdg-'))
  t.after(() => rmSync(xdgConfig, { recursive: true, force: true }))
  const stateRoot = join(tempRoot, 'trusted-state')
  const fakeOdw = join(tempRoot, 'odw')
  // A deferred workflow result carries ok:false, stage:'deferred', and crucially
  // no recordInput, so the recordReview guard cannot append history. The CLI must
  // print the deferred JSON on stdout and exit non-zero.
  const fakeResult = {
    ok: false,
    stage: 'deferred',
    deferred: true,
    reason: 'flex capacity exhausted for the required audit',
    attempts: 3,
    reviewBase: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    commitCount: 1,
    changedFiles: ['src/example.js'],
    metrics: { ledger: [] },
  }
  writeFileSync(
    fakeOdw,
    `#!/bin/sh\nprintf 'running fake-run ...\\n%s\\n' '${JSON.stringify(fakeResult).replace(/'/g, "'\"'\"'")}'\n`,
  )
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--repo-root',
      targetRepo,
      '--base',
      base,
      '--state-root',
      stateRoot,
      '--odw-bin',
      fakeOdw,
      '--runs-root',
      join(tempRoot, 'runs'),
    ],
    {
      cwd: targetRepo,
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: xdgConfig },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const output = JSON.parse(result.stdout)

  assert.equal(result.status, 1)
  assert.equal(output.ok, false)
  assert.equal(output.stage, 'deferred')
  assert.equal(output.deferred, true)
  assert.equal(output.recordInput, undefined)
  assert.equal(output.recorded, undefined, 'no recording is attempted for a deferred review')
  // No reviews.toml under the trusted state root: the head stays unrecorded.
  assert.equal(existsSync(join(stateRoot, 'reviews.toml')), false)
})
