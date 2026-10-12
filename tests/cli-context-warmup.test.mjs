/**
 * Verifies advisory CLI context warmup.
 *
 * @module
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { repoRoot, cliPath, contextWarmupEvents, initFixtureRepo, runCliWithMcp, writeFakeMcp, writeFakeOdw } from './cli-test-support.mjs'

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
  const base = initFixtureRepo(targetRepo, {
    'AGENTS.md': '# Agent instructions\n',
    'README.md': '# Base README\n',
  })
  writeFileSync(join(targetRepo, 'README.md'), '# Changed README\n')
  execFileSync('git', ['-C', targetRepo, 'commit', '-am', 'review markdown change'])
  writeFakeMcp(mcpDir, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const invocation = process.argv.slice(2)
appendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(invocation) + '\\n')
const supported = invocation[0] === '--list' || (
  invocation[0] === 'codegraph' &&
  ['codegraph_index_directory', 'codegraph_index_markdown'].includes(invocation[1])
)
process.exitCode = supported ? 0 : 1
`)
  writeFakeOdw(fakeOdw, "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'\nappendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(['odw_launch']) + '\\n')\nprocess.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))\n")

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
  const result = runCliWithMcp({ targetRepo, base, mcpDir, mcpLog, fakeOdw, runsRoot, stateRoot })

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

test('live CLI warmup skips Markdown symlinks that escape the repository or are not files', (t) => {
  const { tempRoot, targetRepo, runsRoot, stateRoot, mcpDir, mcpLog, fakeOdw, base } = makeSuccessfulWarmupFixture(t)
  const outsideMarkdown = join(tempRoot, 'outside.md')
  const outsideDirectory = join(tempRoot, 'outside-directory')
  const docs = join(targetRepo, 'docs')
  mkdirSync(docs)
  mkdirSync(outsideDirectory)
  writeFileSync(outsideMarkdown, '# Outside repository\n')
  symlinkSync(outsideMarkdown, join(docs, 'external.md'))
  symlinkSync(outsideDirectory, join(docs, 'directory.md'))
  execFileSync('git', ['-C', targetRepo, 'add', 'docs'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'add Markdown symlink candidates'])

  const result = runCliWithMcp({ targetRepo, base, mcpDir, mcpLog, fakeOdw, runsRoot, stateRoot })

  assert.equal(result.status, 0, result.stderr)
  const invocations = readFileSync(mcpLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const markdownPaths = invocations
    .filter((entry) => entry[1] === 'codegraph_index_markdown')
    .map((entry) => JSON.parse(entry[2]).path)
  assert.deepEqual(markdownPaths, [join(targetRepo, 'AGENTS.md'), join(targetRepo, 'README.md')],
    'only in-repository regular Markdown files may be indexed')
  assert.equal(markdownPaths.includes(outsideMarkdown), false, 'external symlink targets must not be indexed')
  assert.match(result.stderr, /CodeGraph warmup complete \(2 markdown file\(s\) indexed\)\./u,
    'the completion count must include only successful safe Markdown calls')
})

test('live CLI reports Markdown filesystem errors without blocking review launch', (t) => {
  const { targetRepo, runsRoot, stateRoot, mcpDir, mcpLog, fakeOdw, base } = makeSuccessfulWarmupFixture(t)
  symlinkSync('loop.md', join(targetRepo, 'loop.md'))
  execFileSync('git', ['-C', targetRepo, 'add', 'loop.md'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'add cyclic Markdown symlink'])
  const result = runCliWithMcp({ targetRepo, base, mcpDir, mcpLog, fakeOdw, runsRoot, stateRoot })
  assert.equal(result.status, 0, result.stderr || 'filesystem inspection failure must remain advisory')
  assert.equal(JSON.parse(result.stdout).ok, true, 'filesystem inspection failures must not block ODW')
  const events = contextWarmupEvents(result.stderr)
  assert.equal(events.filter((event) => event.failureCategory === 'filesystem_error').length, 1,
    'a cyclic symlink must emit one bounded filesystem-error operation')
  const summary = events.find((event) => event.type === 'summary')
  assert.equal(summary.outcome, 'degraded', 'filesystem inspection failure must degrade the warmup summary')
  assert.equal(summary.failureCounts.codegraph_index_markdown.filesystem_error, 1,
    'filesystem inspection failures must reach aggregate failure counts')
  assert.equal(summary.markdownAttempts, 2, 'filesystem errors must not count as attempted MCP calls')
  assert.ok(events.every((event) => !('path' in event) && !('payload' in event)),
    'filesystem diagnostics must not expose repository paths or payloads')
})

test('the environment warmup override skips checkout inspection and still launches ODW', (t) => {
  const { tempRoot, targetRepo, runsRoot, stateRoot, mcpDir, mcpLog, fakeOdw, base } = makeSuccessfulWarmupFixture(t)
  writeFileSync(join(targetRepo, 'dirty.txt'), 'dirty checkout must not override the explicit skip\n')

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
        DAKAR_SKIP_CONTEXT_WARMUP: '1',
        DAKAR_MCP_LOG: mcpLog,
        PATH: `${mcpDir}:${process.env.PATH}`,
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true, 'an explicit warmup skip must not block review launch')
  assert.deepEqual(readFileSync(mcpLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [['odw_launch']],
    'the fake MCP executable must not be invoked when the environment override is set')
  assert.match(result.stderr, /CodeGraph warmup skipped \(DAKAR_SKIP_CONTEXT_WARMUP is set\)\./u,
    'the existing environment skip diagnostic must be preserved')
  const events = contextWarmupEvents(result.stderr)
  const summary = events.find((event) => event.type === 'summary')
  assert.equal(summary?.skipReason, 'environment', 'the structured summary must identify the environment skip')
  assert.deepEqual(events.filter((event) => event.type === 'operation'), [],
    'an environment skip must report no attempted MCP operations')
})

test('live CLI warns and continues when the MCP availability probe fails', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-mcp-probe-failure-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const targetRepo = join(tempRoot, 'repo')
  const base = initFixtureRepo(targetRepo, { 'README.md': '# Base README\n' })
  writeFileSync(join(targetRepo, 'changed.txt'), 'changed\n')
  execFileSync('git', ['-C', targetRepo, 'add', 'changed.txt'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'review change'])
  const mcpDir = join(tempRoot, 'mcp-bin')
  const mcpLog = join(tempRoot, 'mcp.jsonl')
  const fakeOdw = join(tempRoot, 'odw.mjs')
  writeFakeMcp(mcpDir, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.exitCode = 1
`)
  writeFakeOdw(fakeOdw, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))\n")

  const result = runCliWithMcp({ targetRepo, base, mcpDir, mcpLog, fakeOdw,
    runsRoot: join(tempRoot, 'runs'), stateRoot: join(tempRoot, 'state') })

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
  const base = initFixtureRepo(targetRepo, {
    'AGENTS.md': '# Agent instructions\n',
    'README.md': '# Base README\n',
  })
  for (let index = 0; index < 25; index += 1) {
    const docs = join(targetRepo, 'docs')
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, `changed-${index}.md`), `# Changed ${index}\n`)
  }
  execFileSync('git', ['-C', targetRepo, 'add', 'docs'])
  execFileSync('git', ['-C', targetRepo, 'commit', '-m', 'many changed markdown files'])
  writeFakeMcp(mcpDir, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.DAKAR_MCP_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.exitCode = process.argv[2] === '--list' ? 0 : 1
`)
  writeFakeOdw(fakeOdw, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, recordWithheld: { reason: 'fixture' } }))\n")

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
  const result = runCliWithMcp({ targetRepo, base, mcpDir, mcpLog, fakeOdw,
    runsRoot: join(tempRoot, 'runs') })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true, 'the review must continue after advisory Markdown failures')
  const invocations = readFileSync(mcpLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(invocations[0], ['--list'], 'the MCP availability probe must run before warmup calls')
  assert.equal(invocations.filter((entry) => entry[1] === 'codegraph_index_directory').length, 1, 'the directory index must be attempted once')
  assert.equal(invocations.filter((entry) => entry[1] === 'codegraph_index_markdown').length, 20, 'failed Markdown calls must still count against the attempt cap')
  assert.match(result.stderr, /CodeGraph warmup call codegraph_index_directory failed; continuing without it\./u,
    'a failed directory index must remain advisory')
  assert.match(result.stderr, /CodeGraph warmup completed with failures \(0 markdown file\(s\) indexed\)\./u,
    'the completion message must report zero successful Markdown indexes')
  assertFailedWarmupTelemetry(result)
})
