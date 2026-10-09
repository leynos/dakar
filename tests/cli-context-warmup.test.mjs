/**
 * Verifies advisory CLI context warmup.
 *
 * @module
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { repoRoot, cliPath, contextWarmupEvents, setUpRecordRepo } from './cli-test-support.mjs'

process.env.DAKAR_SKIP_CONTEXT_WARMUP = '1'

/** Creates isolated Git and fake-MCP fixtures for successful indexing. */
function makeSuccessfulWarmupFixture(t) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-mcp-warmup-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const targetRepo = join(tempRoot, 'repo')
  const runsRoot = join(tempRoot, 'runs')
  const stateRoot = join(tempRoot, 'state')
  const mcpDir = join(tempRoot, 'mcp-bin')
  const mcpLog = join(tempRoot, 'mcp.jsonl')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  mkdirSync(targetRepo, { recursive: true })
  mkdirSync(mcpDir, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  writeFileSync(join(targetRepo, 'AGENTS.md'), '# Agent instructions\n')
  writeFileSync(join(targetRepo, 'README.md'), '# Base README\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'AGENTS.md', 'README.md'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'base context'])
  const base = execFileSync('git', ['-C', targetRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(join(targetRepo, 'README.md'), '# Changed README\n')
  execFileSync('git', ['-C', targetRepo, 'commit', '-am', 'review markdown change'])
  writeFileSync(
    join(mcpDir, 'mcp'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const invocation = process.argv.slice(2)
appendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(invocation) + '\\n')
const supported = invocation[0] === '--list' || (
  invocation[0] === 'codegraph' &&
  ['codegraph_index_directory', 'codegraph_index_markdown'].includes(invocation[1])
)
process.exitCode = supported ? 0 : 1
`,
  )
  chmodSync(join(mcpDir, 'mcp'), 0o755)
  writeFileSync(
    fakeOdw,
    "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'\nappendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(['odw_launch']) + '\\n')\nprocess.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))\n",
  )
  chmodSync(fakeOdw, 0o755)

  return { tempRoot, targetRepo, runsRoot, stateRoot, mcpDir, mcpLog, fakeOdw, base }
}

/** Verifies one warmup operation reports its expected successful outcome. */
function assertSuccessfulWarmupOperation(operations, operation, message) {
  assert.equal(operations.find((event) => event.operation === operation)?.outcome, 'succeeded', message)
}

/** Verifies that every operation event carries a valid duration. */
function assertWarmupOperationDurations(operations) {
  assert.ok(
    operations.every((event) => Number.isFinite(event.durationMs) && event.durationMs >= 0),
    'operation durations must be non-negative',
  )
}

/** Verifies aggregate fields emitted for a completed warmup. */
function assertSuccessfulWarmupSummary(events) {
  const summary = events.find((event) => event.type === 'summary')
  assert.equal(summary?.markdownAttempts, 2, 'the summary must report Markdown attempts')
  assert.equal(summary?.markdownSuccesses, 2, 'the summary must report Markdown successes')
  assert.equal(summary?.outcome, 'succeeded', 'the summary must report a successful aggregate warmup')
  assert.equal(summary?.deadlineExhausted, false, 'the summary must report that the shared deadline remained')
  assert.equal(summary?.failureCounts.codegraph_index_markdown.nonzero_exit, 0, 'successful indexing has no Markdown failures')
}

/** Verifies bounded operation records without sensitive repository data. */
function assertBoundedWarmupEvents(events) {
  const operations = events.filter((event) => event.type === 'operation')
  assertSuccessfulWarmupOperation(operations, 'mcp_list_probe', 'the MCP probe outcome must be observable')
  assertSuccessfulWarmupOperation(operations, 'codegraph_index_directory', 'the directory index outcome must be observable')
  assert.equal(operations.filter((event) => event.operation === 'codegraph_index_markdown').length, 2, 'each Markdown call must emit one operation event')
  assertWarmupOperationDurations(operations)
  assertSuccessfulWarmupSummary(events)
  assert.ok(events.every((event) => !('path' in event) && !('payload' in event)), 'telemetry must not expose paths or MCP payloads')
}

/** Checks bounded successful warmup operation and summary evidence. */
function assertSuccessfulWarmupTelemetry(result) {
  assertBoundedWarmupEvents(contextWarmupEvents(result.stderr))
}

test('live CLI warmup indexes unique Markdown context through the MCP CLI', (t) => {
  const { tempRoot, targetRepo, runsRoot, stateRoot, mcpDir, mcpLog, fakeOdw, base } = makeSuccessfulWarmupFixture(t)
  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--state-root', stateRoot,
      '--odw-bin', fakeOdw, '--runs-root', runsRoot],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DAKAR_SKIP_CONTEXT_WARMUP: '',
        DAKAR_MCP_LOG: mcpLog,
        PATH: `${mcpDir}:${process.env.PATH}`,
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  const invocations = readFileSync(mcpLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(invocations[0], ['--list'], 'the MCP availability probe must run before indexing')
  assert.equal(invocations.some((entry) => entry[1] === 'codegraph_index_directory'), true, 'the reviewed directory must be indexed')
  const directoryCall = invocations.find((entry) => entry[1] === 'codegraph_index_directory')
  assert.deepEqual(JSON.parse(directoryCall[2]), { path: targetRepo }, 'the directory index payload must identify the reviewed repository')
  assert.deepEqual(invocations.at(-1), ['odw_launch'], 'all MCP warmup calls must finish before ODW launches')
  const markdownCalls = invocations.filter((entry) => entry[1] === 'codegraph_index_markdown')
  assert.equal(markdownCalls.filter((entry) => JSON.parse(entry[2]).path.endsWith('README.md')).length, 1, 'duplicate README candidates must be indexed once')
  assert.equal(markdownCalls.length, 2, 'only the unique existing Markdown candidates must be indexed')
  assert.match(result.stderr, /CodeGraph warmup complete \(2 markdown file\(s\) indexed\)\./u, 'completion output must count successful Markdown calls')

  assertSuccessfulWarmupTelemetry(result)
})

test('live CLI warns and continues when the MCP availability probe fails', (t) => {
  const { tempRoot, targetRepo, base } = setUpRecordRepo()
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const mcpDir = join(tempRoot, 'mcp-bin')
  const mcpLog = join(tempRoot, 'mcp.jsonl')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  mkdirSync(mcpDir, { recursive: true })
  writeFileSync(
    join(mcpDir, 'mcp'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.exitCode = 1
`,
  )
  chmodSync(join(mcpDir, 'mcp'), 0o755)
  writeFileSync(
    fakeOdw,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))\n",
  )
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--state-root', join(tempRoot, 'state'), '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DAKAR_SKIP_CONTEXT_WARMUP: '',
        DAKAR_MCP_LOG: mcpLog,
        PATH: `${mcpDir}:${process.env.PATH}`,
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true, 'an unavailable MCP CLI must not block ODW review launch')
  const invocations = readFileSync(mcpLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(invocations, [['--list']], 'an unsuccessful availability probe must stop MCP indexing')
  assert.match(result.stderr, /mcp CLI unavailable; skipping CodeGraph warmup\./u, 'the unavailable MCP advisory must be visible on stderr')
  const events = contextWarmupEvents(result.stderr)
  const probe = events.find((event) => event.type === 'operation' && event.operation === 'mcp_list_probe')
  assert.equal(probe?.outcome, 'failed', 'an unsuccessful MCP probe must be visible in telemetry')
  assert.equal(probe?.failureCategory, 'nonzero_exit', 'the probe failure must use a bounded category')
  const summary = events.find((event) => event.type === 'summary')
  assert.equal(summary?.skipReason, 'mcp_unavailable', 'the warmup summary must explain why indexing was skipped')
  assert.equal(summary?.failureCounts.mcp_list_probe.nonzero_exit, 1, 'the summary counts failed MCP probes by bounded operation and category')
})

/** Creates isolated Git and fake-MCP fixtures for failed indexing. */
function makeFailedWarmupFixture(t) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-mcp-failures-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const targetRepo = join(tempRoot, 'repo')
  const mcpDir = join(tempRoot, 'mcp-bin')
  const mcpLog = join(tempRoot, 'mcp.jsonl')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  mkdirSync(targetRepo, { recursive: true })
  mkdirSync(mcpDir, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  writeFileSync(join(targetRepo, 'AGENTS.md'), '# Agent instructions\n')
  writeFileSync(join(targetRepo, 'README.md'), '# Base README\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'AGENTS.md', 'README.md'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'base context'])
  const base = execFileSync('git', ['-C', targetRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  for (let index = 0; index < 25; index += 1) {
    const docs = join(targetRepo, 'docs')
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, `changed-${index}.md`), `# Changed ${index}\n`)
  }
  execFileSync('git', ['-C', targetRepo, 'add', 'docs'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'many changed markdown files'])
  writeFileSync(
    join(mcpDir, 'mcp'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.exitCode = process.argv[2] === '--list' ? 0 : 1
`,
  )
  chmodSync(join(mcpDir, 'mcp'), 0o755)
  writeFileSync(
    fakeOdw,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))\n",
  )
  chmodSync(fakeOdw, 0o755)

  return { tempRoot, targetRepo, mcpDir, mcpLog, fakeOdw, base }
}

/** Checks bounded failed warmup operation and summary evidence. */
function assertFailedWarmupTelemetry(result) {
  const events = contextWarmupEvents(result.stderr)
  const markdownEvents = events.filter((event) => event.type === 'operation' && event.operation === 'codegraph_index_markdown')
  assert.equal(markdownEvents.length, 20, 'failed Markdown invocations must each have an operation event')
  assert.ok(markdownEvents.every((event) => event.outcome === 'failed' && event.failureCategory === 'nonzero_exit'), 'failure events must expose only the bounded failure category')
  const summary = events.find((event) => event.type === 'summary')
  assert.equal(summary?.outcome, 'degraded', 'failed indexing calls must not be reported as completed successfully')
  assert.equal(summary?.markdownAttempts, 20, 'the summary must count failed attempts against the cap')
  assert.equal(summary?.markdownSuccesses, 0, 'the summary must count only successful Markdown calls')
  assert.equal(summary?.deadlineExhausted, false, 'the attempt cap must not be reported as deadline exhaustion')
  assert.equal(summary?.failureCounts.codegraph_index_directory.nonzero_exit, 1, 'directory failures are aggregated by operation and category')
  assert.equal(summary?.failureCounts.codegraph_index_markdown.nonzero_exit, 20, 'failed Markdown calls are counted by operation and category')
}

test('advisory warmup bounds failed Markdown attempts and still launches the review', (t) => {
  const { tempRoot, targetRepo, mcpDir, mcpLog, fakeOdw, base } = makeFailedWarmupFixture(t)
  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DAKAR_SKIP_CONTEXT_WARMUP: '', DAKAR_MCP_LOG: mcpLog, PATH: `${mcpDir}:${process.env.PATH}` },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true)
  const invocations = readFileSync(mcpLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(invocations[0], ['--list'], 'the MCP availability probe must run before warmup calls')
  assert.equal(invocations.filter((entry) => entry[1] === 'codegraph_index_directory').length, 1, 'the directory index must be attempted once')
  assert.equal(invocations.filter((entry) => entry[1] === 'codegraph_index_markdown').length, 20, 'failed Markdown calls must still count against the attempt cap')
  assert.match(result.stderr, /CodeGraph warmup call codegraph_index_directory failed; continuing without it\./u)
  assert.match(result.stderr, /CodeGraph warmup completed with failures \(0 markdown file\(s\) indexed\)\./u)
  assertFailedWarmupTelemetry(result)
})

test('a timed-out MCP directory call exhausts the shared deadline without blocking ODW', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-mcp-timeout-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const targetRepo = join(tempRoot, 'repo')
  const mcpDir = join(tempRoot, 'mcp-bin')
  const mcpLog = join(tempRoot, 'mcp.jsonl')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  mkdirSync(targetRepo, { recursive: true })
  mkdirSync(mcpDir, { recursive: true })
  execFileSync('git', ['-C', targetRepo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.name', 'Dakar test'])
  execFileSync('git', ['-C', targetRepo, 'config', 'user.email', 'dakar@example.invalid'])
  writeFileSync(join(targetRepo, 'AGENTS.md'), '# Agent instructions\n')
  writeFileSync(join(targetRepo, 'README.md'), '# Base README\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'AGENTS.md', 'README.md'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'base context'])
  const base = execFileSync('git', ['-C', targetRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(join(targetRepo, 'docs'), 'changed review context\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'docs'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'change review context'])
  writeFileSync(
    join(mcpDir, 'mcp'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const invocation = process.argv.slice(2)
appendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(invocation) + '\\n')
if (invocation[0] === '--list') process.exitCode = 0
else if (invocation[1] === 'codegraph_index_directory') setTimeout(() => {}, 60_000)
else process.exitCode = 0
`,
  )
  chmodSync(join(mcpDir, 'mcp'), 0o755)
  writeFileSync(
    fakeOdw,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))\n",
  )
  chmodSync(fakeOdw, 0o755)

  const result = spawnSync(
    process.execPath,
    [cliPath, '--repo-root', targetRepo, '--base', base, '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, 'runs')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DAKAR_SKIP_CONTEXT_WARMUP: '',
        DAKAR_MCP_LOG: mcpLog,
        PATH: `${mcpDir}:${process.env.PATH}`,
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true, 'a warmup timeout must not block the review')
  const invocations = readFileSync(mcpLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(invocations.map((entry) => entry.slice(0, 2)), [
    ['--list'],
    ['codegraph', 'codegraph_index_directory'],
  ], 'the timed-out directory call must prevent later Markdown calls')
  const events = contextWarmupEvents(result.stderr)
  const directory = events.find((event) => event.type === 'operation' && event.operation === 'codegraph_index_directory')
  assert.equal(directory?.outcome, 'timed_out', 'the directory operation must report its timeout')
  assert.equal(directory?.failureCategory, 'timeout', 'the operation must report a bounded timeout category')
  const summary = events.find((event) => event.type === 'summary')
  assert.equal(summary?.outcome, 'timed_out', 'the aggregate warmup must report its exhausted deadline')
  assert.equal(summary?.deadlineExhausted, true, 'the summary must mark the shared deadline as exhausted')
  assert.equal(summary?.markdownAttempts, 0, 'no Markdown work starts after the deadline expires')
  assert.equal(summary?.failureCounts.codegraph_index_directory.timeout, 1, 'a directory timeout is counted in the aggregate failure metrics')
  assert.match(result.stderr, /CodeGraph warmup timed out \(0 markdown file\(s\) indexed\)\./u)
})

test('live reviews skip CodeGraph warmup unless the reviewed head is cleanly checked out', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-mcp-snapshot-'))
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

  const run = (suffix, checkoutDescription, expectedSkipReason, expectedDiagnostic = /reviewed head is not checked out cleanly; skipping CodeGraph warmup\./u) => {
    const mcpLog = join(tempRoot, `${suffix}.mcp.log`)
    const result = spawnSync(
      process.execPath,
      [cliPath, '--repo-root', targetRepo, '--base', base, '--head', reviewedHead, '--odw-bin', fakeOdw, '--runs-root', join(tempRoot, `${suffix}-runs`)],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DAKAR_SKIP_CONTEXT_WARMUP: '', DAKAR_MCP_LOG: mcpLog, PATH: `${mcpDir}:${process.env.PATH}` },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).ok, true)
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

  run('different-head', 'a different checked-out head', 'different_head')
  execFileSync('git', ['-C', targetRepo, 'checkout', '--detach', reviewedHead])
  writeFileSync(join(targetRepo, 'dirty.txt'), 'dirty\n')
  run('dirty-checkout', 'a dirty worktree at the reviewed head', 'dirty_checkout')
  rmSync(join(targetRepo, 'dirty.txt'))
  writeFileSync(
    join(mcpDir, 'git'),
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === '-C' && args[1] === ${JSON.stringify(targetRepo)} && args[2] === 'status' && args[3] === '--porcelain' && args[4] === '--untracked-files=all') {
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
  run(
    'git-status-failure',
    'a Git worktree-status failure',
    'checkout_verification_failed',
    /could not verify the reviewed checkout while checking worktree status; skipping CodeGraph warmup\./u,
  )
})
