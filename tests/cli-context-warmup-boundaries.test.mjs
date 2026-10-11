/**
 * Verifies context warmup deadlines and reviewed-checkout boundaries.
 *
 * @module
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { CONTEXT_WARMUP_BOUNDARY, warmReviewedContextIndex } from '../scripts/context-warmup.mjs'
import { repoRoot, cliPath, contextWarmupEvents } from './cli-test-support.mjs'

test('all MCP indexing calls use the remaining shared deadline', () => {
  let now = 0
  const calls = []
  const reports = []
  const traceId = '1'.repeat(32)
  const rootSpanId = '2'.repeat(16)
  const boundary = {
    ...CONTEXT_WARMUP_BOUNDARY,
    clock: { now: () => now },
    runGit: (args) => args.at(-1) === 'HEAD'
      ? { status: 0, stdout: 'reviewed-head\n' }
      : { status: 0, stdout: '' },
    runMcp: (args, options) => {
      calls.push({ args, timeout: options.timeout, traceparent: options.env.TRACEPARENT })
      if (args[0] === '--list') now += 7_500
      else if (args[1] === 'codegraph_index_directory') now += 12_000
      else if (calls.filter((call) => call.args[1] === 'codegraph_index_markdown').length === 1) now += 4_000
      return { status: 0 }
    },
    filesystem: { realpath: (path) => path, stat: () => ({ isFile: () => true }) },
    environment: { shouldSkip: () => false, variables: () => ({}) },
    trace: { traceId, spanId: rootSpanId, traceparent: `00-${traceId}-${rootSpanId}-01` },
    report: (message) => reports.push(message),
  }

  warmReviewedContextIndex('/reviewed/repo', { headCommit: 'reviewed-head', changedFiles: [] }, boundary)

  assert.deepEqual(calls.map(({ timeout }) => timeout), [30_000, 22_500, 10_500, 6_500],
    'each MCP process receives only the time remaining from the original 30-second budget')
  assert.ok(calls.every((call) => call.traceparent.startsWith(`00-${traceId}-`)),
    'probe and index subprocesses share the review trace identifier')
  const events = reports.filter((line) => line.startsWith('dakar-review: warmup '))
    .map((line) => JSON.parse(line.slice('dakar-review: warmup '.length)))
  assert.equal(events.find((event) => event.type === 'summary')?.outcome, 'succeeded',
    'the aggregate result reflects successful bounded indexing')
})

test('the environment skip is injectable and avoids checkout and MCP processes', () => {
  const reports = []
  const boundary = {
    ...CONTEXT_WARMUP_BOUNDARY,
    environment: { shouldSkip: () => true, variables: () => ({}) },
    runGit: () => assert.fail('environment skip must precede checkout inspection'),
    runMcp: () => assert.fail('environment skip must avoid MCP calls'),
    report: (message) => reports.push(message),
  }

  warmReviewedContextIndex('/reviewed/repo', { headCommit: 'reviewed-head', changedFiles: [] }, boundary)

  const events = reports.filter((line) => line.startsWith('dakar-review: warmup '))
    .map((line) => JSON.parse(line.slice('dakar-review: warmup '.length)))
  assert.equal(events.find((event) => event.type === 'summary')?.skipReason, 'environment',
    'the summary records the explicit warmup override')
})

test('live reviews skip CodeGraph warmup unless the reviewed head is cleanly checked out', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-mcp-snapshot-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const targetRepo = join(tempRoot, 'repo')
  const mcpDir = join(tempRoot, 'mcp-bin')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  mkdirSync(targetRepo, { recursive: true })
  mkdirSync(mcpDir, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  writeFileSync(join(targetRepo, 'base.txt'), 'base\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'base.txt'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'base'])
  const base = execFileSync('git', ['-C', targetRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(join(targetRepo, 'reviewed.txt'), 'reviewed\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'reviewed.txt'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'reviewed head'])
  const reviewedHead = execFileSync('git', ['-C', targetRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(join(targetRepo, 'later.txt'), 'later\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'later.txt'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'later checkout'])
  writeFileSync(
    join(mcpDir, 'mcp'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.DAKAR_MCP_LOG, 'called\\n')
`,
  )
  chmodSync(join(mcpDir, 'mcp'), 0o755)
  writeFileSync(
    fakeOdw,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))\n",
  )
  chmodSync(fakeOdw, 0o755)

  const run = (scenario) => {
    const {
      suffix,
      checkoutDescription,
      expectedSkipReason,
      expectedDiagnostic = /reviewed head is not checked out cleanly; skipping CodeGraph warmup\./u,
    } = scenario
    const mcpLog = join(tempRoot, `${suffix}.mcp.log`)
    const result = spawnSync(
      process.execPath,
      [cliPath, '--repo-root', targetRepo, '--base', base, '--head', reviewedHead, '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, `${suffix}-runs`)],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DAKAR_SKIP_CONTEXT_WARMUP: '', DAKAR_MCP_LOG: mcpLog,
          DAKAR_GIT_FAIL_HEAD: suffix === 'git-head-failure' ? '1' : '', PATH: `${mcpDir}:${process.env.PATH}` },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).ok, true, `the review must continue for ${checkoutDescription}`)
    assert.equal(existsSync(mcpLog), false, `the MCP CLI must not run for ${checkoutDescription}`)
    assert.match(result.stderr, expectedDiagnostic, `warmup skip output must explain ${checkoutDescription}`)
    const events = contextWarmupEvents(result.stderr)
    const summary = events.find((event) => event.type === 'summary')
    assert.equal(summary?.outcome, 'skipped', `the warmup summary must mark ${checkoutDescription} as skipped`)
    assert.equal(summary?.skipReason, expectedSkipReason, `the warmup summary must identify ${checkoutDescription}`)
    assert.equal(summary?.probeOutcome, 'not_attempted', `the MCP probe must not run for ${checkoutDescription}`)
    assert.equal(summary?.directoryOutcome, 'not_attempted', `the directory index must not run for ${checkoutDescription}`)
    assert.equal(summary?.markdownAttempts, 0, `no Markdown indexing must be attempted for ${checkoutDescription}`)
    assert.equal(summary?.markdownSuccesses, 0, `no Markdown indexing must succeed for ${checkoutDescription}`)
    assert.deepEqual(
      events.filter((event) => event.type === 'operation'),
      [],
      `no MCP operations must be reported for ${checkoutDescription}`,
    )
  }

  run({ suffix: 'different-head', checkoutDescription: 'a different checked-out head', expectedSkipReason: 'different_head' })
  execFileSync('git', ['-C', targetRepo, 'checkout', '--detach', reviewedHead])
  writeFileSync(join(targetRepo, 'dirty.txt'), 'dirty\n')
  run({ suffix: 'dirty-checkout', checkoutDescription: 'a dirty worktree at the reviewed head', expectedSkipReason: 'dirty_checkout' })
  rmSync(join(targetRepo, 'dirty.txt'))
  writeFileSync(
    join(mcpDir, 'git'),
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (process.env.DAKAR_GIT_FAIL_HEAD && args[0] === '-C' && args[1] === ${JSON.stringify(targetRepo)} && args[2] === 'rev-parse' && args[3] === 'HEAD') {
  process.stderr.write('simulated HEAD lookup failure\\n')
  process.exitCode = 128
} else if (args[0] === '-C' && args[1] === ${JSON.stringify(targetRepo)} && args[2] === 'status' && args[3] === '--porcelain' && args[4] === '--untracked-files=all') {
  process.stderr.write('simulated worktree status failure\\n')
  process.exitCode = 128
} else {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  process.exitCode = result.status ?? 1
}
`,
  )
  chmodSync(join(mcpDir, 'git'), 0o755)
  run({
    suffix: 'git-status-failure',
    checkoutDescription: 'a Git worktree-status failure',
    expectedSkipReason: 'checkout_verification_failed',
    expectedDiagnostic: /could not verify the reviewed checkout while checking worktree status; skipping CodeGraph warmup\./u,
  })
  run({
    suffix: 'git-head-failure',
    checkoutDescription: 'a Git checked-out-head lookup failure',
    expectedSkipReason: 'checkout_verification_failed',
    expectedDiagnostic: /could not verify the reviewed checkout while reading HEAD; skipping CodeGraph warmup\./u,
  })
})
