/**
 * Prepare bounded CodeGraph and DeepWiki context for Dakar review runs.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { contextToolsBlock } from './context-tools.mjs'
import { isRepositoryRelativePath } from './repository-paths.mjs'

/** Bound Markdown indexing attempts even when every MCP call fails. */
const MAX_MARKDOWN_WARMUP_ATTEMPTS = 20

/** Human-readable completion text for each aggregate context warmup outcome. */
const CONTEXT_WARMUP_COMPLETION = Object.freeze({
  succeeded: 'complete',
  degraded: 'completed with failures',
  timed_out: 'timed out',
})

/** Fixed dimensions prevent warmup summaries from exposing unbounded categories. */
const CONTEXT_WARMUP_FAILURE_CATEGORIES = Object.freeze(['timeout', 'spawn_error', 'nonzero_exit', 'deadline', 'filesystem_error'])
const CONTEXT_WARMUP_OPERATIONS = Object.freeze(['mcp_list_probe', 'codegraph_index_directory', 'codegraph_index_markdown'])

/** Generate a W3C-compatible trace identifier. */
function newTraceId() {
  return randomUUID().replaceAll('-', '')
}

/** Generate a W3C-compatible span identifier. */
function newSpanId() {
  return randomUUID().replaceAll('-', '').slice(0, 16)
}

const CONTEXT_TRACE_ID = newTraceId()
const CONTEXT_ROOT_SPAN_ID = newSpanId()
const CONTEXT_WARMUP_TRACE = Object.freeze({
  traceId: CONTEXT_TRACE_ID,
  spanId: CONTEXT_ROOT_SPAN_ID,
  traceparent: `00-${CONTEXT_TRACE_ID}-${CONTEXT_ROOT_SPAN_ID}-01`,
})

/** Cap all advisory CodeGraph warmup work, including the CLI probe. */
const CONTEXT_WARMUP_TIMEOUT_MILLISECONDS = 30_000

/** Supply a monotonic clock to the bounded context-warmup operations. */
const CONTEXT_WARMUP_CLOCK = Object.freeze({ now: () => performance.now() })

/**
 * Injectable host boundary for warmup, environment access, and trace propagation.
 *
 * @internal Test seam for exercising filesystem, subprocess, environment, and
 * diagnostic behavior without changing the public CLI contract.
 */
export const CONTEXT_WARMUP_BOUNDARY = Object.freeze({
  clock: CONTEXT_WARMUP_CLOCK,
  runGit: (args, options) => spawnSync('git', args, options),
  runMcp: (args, options) => spawnSync('mcp', args, options),
  filesystem: Object.freeze({ realpath: realpathSync, stat: statSync }),
  environment: Object.freeze({
    shouldSkip: () => Boolean(process.env.DAKAR_SKIP_CONTEXT_WARMUP),
    variables: () => process.env,
  }),
  trace: CONTEXT_WARMUP_TRACE,
  report: (message) => process.stderr.write(message),
})

/**
 * Derive the `owner/name` GitHub slug from the origin remote, if any.
 *
 * The slug parameterizes finder-prompt DeepWiki lookups; a repository without
 * a GitHub origin simply reviews without DeepWiki guidance.
 *
 * @param {string} repoRoot - absolute path to the repository root.
 * @param {Function} runGit - Injected Git subprocess runner.
 * @returns {{ kind: 'slug', value: string } | { kind: 'unavailable' } | { kind: 'error', operation: string }}
 *   The resolved slug, ordinary absence, or a Git lookup failure.
 */
function deriveRepoSlug(repoRoot, runGit) {
  const result = runGit(['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.error) return { kind: 'error', operation: 'reading the origin URL' }
  if (result.status === 1) return { kind: 'unavailable' }
  if (result.status !== 0) return { kind: 'error', operation: 'reading the origin URL' }
  const match = /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/u.exec((result.stdout || '').trim())
  return match ? { kind: 'slug', value: `${match[1]}/${match[2]}` } : { kind: 'unavailable' }
}

/**
 * Translate origin-derived repository context into generic workflow guidance.
 *
 * @param {object} workflowArgs - Mutable workflow arguments assembled by the CLI.
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {object} [boundary] - Injected Git query and diagnostic ports.
 * @returns {void}
 */
export function addContextGuidance(workflowArgs, repoRoot, boundary = CONTEXT_WARMUP_BOUNDARY) {
  const result = deriveRepoSlug(repoRoot, boundary.runGit)
  if (result.kind === 'error') {
    boundary.report(`dakar-review: Git failed while ${result.operation}; DeepWiki context is unavailable.\n`)
  }
  workflowArgs.contextGuidance = contextToolsBlock(repoRoot, result.kind === 'slug' ? result.value : '')
}

/**
 * Determine whether the operator's MCP CLI is available for CodeGraph warmup.
 *
 * @param {number | null} timeout - Probe timeout, bounded by the shared deadline.
 * @param {Function} runMcp - Injected MCP subprocess runner.
 * @returns {{ available: boolean, outcome: string, deadlineExhausted: boolean }}
 *   The probe result without exposing process output or repository data.
 */
function isMcpCliAvailable(timeout, boundary, span) {
  if (timeout === null) {
    return { available: false, outcome: 'deadline_exhausted', deadlineExhausted: true, failureCategory: 'deadline' }
  }
  const probe = runWarmupMcp(['--list'], { encoding: 'utf8', timeout }, boundary, span)
  if (!probe.error && probe.status === 0) {
    return { available: true, outcome: 'succeeded', deadlineExhausted: false }
  }
  const deadlineExhausted = probe.error?.code === 'ETIMEDOUT'
  const outcome = deadlineExhausted ? 'timed_out' : 'failed'
  return { available: false, outcome, deadlineExhausted, failureCategory: warmupFailureCategory(probe.error) }
}

/**
 * Convert a subprocess failure into a bounded category without exposing stderr.
 *
 * @param {NodeJS.ErrnoException | undefined} error - Spawn or timeout error.
 * @returns {'timeout' | 'spawn_error' | 'nonzero_exit'} Stable failure category.
 */
function warmupFailureCategory(error) {
  if (!error) return 'nonzero_exit'
  return error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn_error'
}

/**
 * Record one bounded warmup operation on stderr without paths or payloads.
 *
 * @param {{ operation: string, outcome: string, startedAt: number, failureCategory?: string }} operationEvent - Bounded operation evidence.
 * @param {{ clock: { now: () => number }, failureCounts: object, report: Function }} context - Timing, failure evidence, and diagnostic port.
 * @returns {void}
 */
function reportContextWarmupOperation(
  { operation, outcome, startedAt, failureCategory },
  { clock, failureCounts, report },
  span,
) {
  const event = {
    event: 'context_warmup',
    type: 'operation',
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    operation,
    outcome,
    durationMs: Math.max(0, Math.round(clock.now() - startedAt)),
  }
  if (failureCategory) {
    event.failureCategory = failureCategory
    recordContextWarmupFailure(failureCounts, operation, failureCategory)
  }
  report(`dakar-review: warmup ${JSON.stringify(event)}\n`)
}

/**
 * Bound one warmup call to the remaining shared deadline.
 *
 * @param {number} deadline - Absolute monotonic-millisecond warmup deadline.
 * @param {{ now: () => number }} clock - Injected monotonic clock.
 * @returns {number | null} A positive bounded timeout, or null once time expires.
 */
function warmupTimeout(deadline, clock) {
  const remaining = Math.floor(deadline - clock.now())
  if (remaining <= 0) return null
  return remaining
}

/** Create one child span for an MCP operation without storing request data. */
function createWarmupSpan(trace) {
  const spanId = newSpanId()
  return {
    traceId: trace.traceId,
    spanId,
    parentSpanId: trace.spanId,
    traceparent: `00-${trace.traceId}-${spanId}-01`,
  }
}

/** Invoke the MCP process with the operation's W3C trace context. */
function runWarmupMcp(args, options, boundary, span) {
  const env = {
    ...boundary.environment.variables(),
    ...options.env,
    TRACEPARENT: span.traceparent,
  }
  return boundary.runMcp(args, { ...options, env })
}
/**
 * Invoke one advisory CodeGraph indexing tool and report failures on stderr.
 *
 * @param {string} tool - CodeGraph MCP tool name.
 * @param {object} payload - JSON-serializable tool payload.
 * @param {object} context - Shared budget, counters, and injected process/diagnostic ports.
 * @returns {{ succeeded: boolean, outcome: string, deadlineExhausted: boolean }}
 *   Whether the advisory invocation succeeded and consumed the deadline.
 */
function warmContextTool(tool, payload, context) {
  const { deadline, clock } = context
  const span = createWarmupSpan(context.trace)
  const boundedTimeout = warmupTimeout(deadline, clock)
  const startedAt = clock.now()
  if (boundedTimeout === null) {
    reportContextWarmupOperation({ operation: tool, outcome: 'deadline_exhausted', startedAt, failureCategory: 'deadline' }, context, span)
    return { succeeded: false, outcome: 'deadline_exhausted', deadlineExhausted: true }
  }
  const result = runWarmupMcp(['codegraph', tool, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: boundedTimeout,
  }, context, span)
  if (result.error || result.status !== 0) {
    context.report(`dakar-review: CodeGraph warmup call ${tool} failed; continuing without it.\n`)
    const deadlineExhausted = result.error?.code === 'ETIMEDOUT'
    const outcome = deadlineExhausted ? 'timed_out' : 'failed'
    reportContextWarmupOperation({ operation: tool, outcome, startedAt, failureCategory: warmupFailureCategory(result.error) }, context, span)
    return { succeeded: false, outcome, deadlineExhausted }
  }
  reportContextWarmupOperation({ operation: tool, outcome: 'succeeded', startedAt }, context, span)
  return { succeeded: true, outcome: 'succeeded', deadlineExhausted: false }
}

/**
 * Attempt to index one Markdown context path within the shared warmup budget.
 *
 * The deadline check intentionally precedes de-duplication and filesystem
 * checks so every candidate observes the same expiry boundary.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} relPath - Repository-relative candidate Markdown path.
 * @param {Set<string>} seen - Absolute paths already indexed or attempted.
 * @param {object} context - Shared budget, counters, and injected filesystem/process ports.
 * @returns {{ attempted: boolean, succeeded: boolean, deadlineExhausted: boolean }}
 *   Whether this candidate was attempted and its advisory indexing outcome.
 */
function indexMarkdownContextCandidate(repoRoot, relPath, seen, context) {
  const { deadline, clock } = context
  if (warmupTimeout(deadline, clock) === null) {
    return { attempted: false, succeeded: false, deadlineExhausted: true }
  }
  const candidatePath = resolve(repoRoot, relPath)
  if (seen.has(candidatePath)) {
    return { attempted: false, succeeded: false, deadlineExhausted: false }
  }
  const startedAt = clock.now()
  const markdown = repositoryMarkdownPath(repoRoot, relPath, context.filesystem)
  if (markdown.kind === 'error') {
    reportContextWarmupOperation(
      { operation: 'codegraph_index_markdown', outcome: 'failed', startedAt, failureCategory: 'filesystem_error' },
      context,
      createWarmupSpan(context.trace),
    )
  }
  if (markdown.kind !== 'present') return { attempted: false, succeeded: false, deadlineExhausted: false }
  seen.add(candidatePath)
  const result = warmContextTool('codegraph_index_markdown', { path: markdown.path }, context)
  return { attempted: true, succeeded: result.succeeded, deadlineExhausted: result.deadlineExhausted }
}

/**
 * Resolve an existing regular Markdown file without following it outside the repository.
 *
 * Canonical path validation keeps repository-controlled symlinks from making
 * CodeGraph index content outside the reviewed checkout. Filesystem failures
 * remain advisory skips, as missing context has never blocked a review.
 *
 * @param {string} repoRoot - Absolute path to the reviewed repository root.
 * @param {string} relPath - Repository-relative candidate Markdown path.
 * @param {{ realpath: Function, stat: Function }} filesystem - Narrow canonical-path queries.
 * @returns {{ kind: 'present', path: string } | { kind: 'absent' | 'outside' | 'error' }} Canonical eligibility or an explicit advisory outcome.
 */
function repositoryMarkdownPath(repoRoot, relPath, filesystem) {
  try {
    const realRepoRoot = filesystem.realpath(repoRoot)
    const markdownPath = filesystem.realpath(resolve(realRepoRoot, relPath))
    const relativePath = relative(realRepoRoot, markdownPath)
    if (!isRepositoryRelativePath(relativePath)) return { kind: 'outside' }
    if (!filesystem.stat(markdownPath).isFile()) return { kind: 'absent' }
    return { kind: 'present', path: markdownPath }
  } catch (error) {
    return { kind: error?.code === 'ENOENT' ? 'absent' : 'error' }
  }
}

/**
 * Report whether the Markdown warmup has reached its fixed attempt budget.
 *
 * @param {number} attempts - Number of MCP Markdown calls already attempted.
 * @returns {boolean} Whether another candidate must be skipped.
 */
function markdownWarmupLimitReached(attempts) {
  return attempts >= MAX_MARKDOWN_WARMUP_ATTEMPTS
}

/**
 * Add one candidate's outcome to the aggregate Markdown warmup counts.
 *
 * @param {{ attempts: number, successes: number, deadlineExhausted: boolean }} summary - Mutable aggregate counts.
 * @param {{ attempted: boolean, succeeded: boolean, deadlineExhausted: boolean }} result - Candidate indexing outcome.
 * @returns {boolean} Whether the deadline requires the candidate loop to stop.
 */
function recordMarkdownWarmupOutcome(summary, result) {
  if (result.attempted) summary.attempts += 1
  if (result.succeeded) summary.successes += 1
  if (result.deadlineExhausted) summary.deadlineExhausted = true
  return result.deadlineExhausted
}

/**
 * Index bounded, existing, unique Markdown context files and count successes.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string[]} changedFiles - Repository-relative changed paths for this review.
 * @param {object} context - Shared budget, counters, and injected boundary ports.
 * @returns {{ attempts: number, successes: number, deadlineExhausted: boolean }}
 *   Attempt and success counts plus whether the shared deadline stopped indexing.
 */
function warmMarkdownContext(repoRoot, changedFiles, context) {
  const candidates = ['AGENTS.md', 'README.md'].concat((changedFiles || []).filter((path) => path.endsWith('.md')))
  const seen = new Set()
  const summary = { attempts: 0, successes: 0, deadlineExhausted: false }
  for (const relPath of candidates) {
    if (markdownWarmupLimitReached(summary.attempts)) break
    const result = indexMarkdownContextCandidate(repoRoot, relPath, seen, context)
    if (recordMarkdownWarmupOutcome(summary, result)) break
  }
  return summary
}

/**
 * Classify the whole warmup from its directory and Markdown outcomes.
 *
 * @param {{ outcome: string, deadlineExhausted: boolean }} directory - Directory index result.
 * @param {{ attempts: number, successes: number, deadlineExhausted: boolean }} markdown - Markdown index counts and deadline state.
 * @param {object} failureCounts - Bounded operation/category failure counters.
 * @returns {'succeeded' | 'degraded' | 'timed_out'} Aggregate warmup outcome.
 */
function contextWarmupOutcome(directory, markdown, failureCounts) {
  if (directory.deadlineExhausted || markdown.deadlineExhausted) return 'timed_out'
  if (directory.outcome !== 'succeeded' || markdown.successes < markdown.attempts) return 'degraded'
  if (failureCounts.codegraph_index_markdown.filesystem_error > 0) return 'degraded'
  return 'succeeded'
}

/**
 * Emit a bounded summary of the advisory MCP warmup on stderr.
 *
 * @param {object} summary - Bounded warmup statuses, counts, and skip reason.
 * @param {{ now: () => number }} clock - Injected monotonic clock.
 * @param {Function} report - Injected stderr diagnostic port.
 * @returns {void}
 */
function reportContextWarmupSummary(summary, clock, report, trace = CONTEXT_WARMUP_TRACE) {
  const event = {
    event: 'context_warmup',
    type: 'summary',
    traceId: trace.traceId,
    spanId: trace.spanId,
    outcome: summary.outcome,
    durationMs: Math.max(0, Math.round(clock.now() - summary.startedAt)),
    probeOutcome: summary.probeOutcome,
    directoryOutcome: summary.directoryOutcome,
    markdownAttempts: summary.markdownAttempts,
    markdownSuccesses: summary.markdownSuccesses,
    deadlineExhausted: summary.deadlineExhausted,
    failureCounts: summary.failureCounts,
  }
  if (summary.skipReason) event.skipReason = summary.skipReason
  report(`dakar-review: warmup ${JSON.stringify(event)}\n`)
}

/**
 * Report that checkout validation prevented warmup without including checkout data.
 *
 * @param {'different_head' | 'dirty_checkout' | 'checkout_verification_failed'} skipReason - Bounded reason.
 * @param {object} boundary - Injected monotonic clock and diagnostic port.
 * @returns {void}
 */
function recordSkippedContextWarmup(skipReason, boundary) {
  const { clock, report } = boundary
  reportContextWarmupSummary({
    outcome: 'skipped',
    startedAt: clock.now(),
    probeOutcome: 'not_attempted',
    directoryOutcome: 'not_attempted',
    markdownAttempts: 0,
    markdownSuccesses: 0,
    deadlineExhausted: false,
    failureCounts: emptyContextWarmupFailureCounts(),
    skipReason,
  }, clock, report, boundary.trace)
}

/**
 * Build bounded aggregate failure counters for every supported operation/category pair.
 *
 * @returns {object} Fresh zeroed warmup failure counters.
 */
function emptyContextWarmupFailureCounts() {
  return Object.fromEntries(CONTEXT_WARMUP_OPERATIONS.map((operation) => [
    operation,
    Object.fromEntries(CONTEXT_WARMUP_FAILURE_CATEGORIES.map((category) => [category, 0])),
  ]))
}

/**
 * Increment a fixed operation/category warmup failure counter.
 *
 * @param {object} counts - Mutable bounded aggregate counts.
 * @param {string} operation - Stable warmup operation name.
 * @param {string} category - Stable failure category.
 * @returns {void}
 */
function recordContextWarmupFailure(counts, operation, category) {
  if (!counts[operation] || !Object.hasOwn(counts[operation], category)) return
  counts[operation][category] += 1
}

/**
 * Warm the CodeGraph MCP index for the reviewed checkout before finders run.
 *
 * Indexes the repository directory, then the markdown context finders are
 * most likely to consult: the root `AGENTS.md` and `README.md`, plus any
 * markdown files in the review's changed set (bounded). Warmup is advisory:
 * a missing `mcp` command or a failed call warns on stderr and never blocks
 * the review, matching the prompt's instruction to fall back to git when the
 * tools are unavailable.
 *
 * @param {string} repoRoot - absolute path to the repository root.
 * @param {string[]} changedFiles - repo-relative changed paths for this review.
 * @param {object} [boundary] - Injected MCP runner, filesystem, monotonic clock, and reporter.
 * @returns {void}
 */
function warmContextIndex(repoRoot, changedFiles, boundary = CONTEXT_WARMUP_BOUNDARY) {
  const { clock, report, filesystem, environment } = boundary
  const startedAt = clock.now()
  const failureCounts = emptyContextWarmupFailureCounts()
  if (environment.shouldSkip()) {
    report('dakar-review: CodeGraph warmup skipped (DAKAR_SKIP_CONTEXT_WARMUP is set).\n')
    reportContextWarmupSummary({
      outcome: 'skipped',
      startedAt,
      probeOutcome: 'not_attempted',
      directoryOutcome: 'not_attempted',
      markdownAttempts: 0,
      markdownSuccesses: 0,
      deadlineExhausted: false,
      failureCounts,
      skipReason: 'environment',
    }, clock, report, boundary.trace)
    return
  }
  const deadline = clock.now() + CONTEXT_WARMUP_TIMEOUT_MILLISECONDS
  const probeStartedAt = clock.now()
  const probeSpan = createWarmupSpan(boundary.trace)
  const probe = isMcpCliAvailable(
    warmupTimeout(deadline, clock),
    boundary,
    probeSpan,
  )
  const context = { ...boundary, deadline, failureCounts }
  reportContextWarmupOperation({ operation: 'mcp_list_probe', outcome: probe.outcome, startedAt: probeStartedAt, failureCategory: probe.failureCategory }, context, probeSpan)
  if (!probe.available) {
    report('dakar-review: mcp CLI unavailable; skipping CodeGraph warmup.\n')
    reportContextWarmupSummary({
      outcome: 'skipped',
      startedAt,
      probeOutcome: probe.outcome,
      directoryOutcome: 'not_attempted',
      markdownAttempts: 0,
      markdownSuccesses: 0,
      deadlineExhausted: probe.deadlineExhausted,
      failureCounts,
      skipReason: probe.deadlineExhausted ? 'deadline_exhausted' : 'mcp_unavailable',
    }, clock, report, boundary.trace)
    return
  }
  report('dakar-review: warming CodeGraph index for the reviewed checkout.\n')
  const directory = warmContextTool('codegraph_index_directory', { path: repoRoot }, context)
  const markdown = warmMarkdownContext(repoRoot, changedFiles, context)
  const outcome = contextWarmupOutcome(directory, markdown, failureCounts)
  report(
    `dakar-review: CodeGraph warmup ${CONTEXT_WARMUP_COMPLETION[outcome]} (${markdown.successes} markdown file(s) indexed).\n`,
  )
  reportContextWarmupSummary({
    outcome,
    startedAt,
    probeOutcome: probe.outcome,
    directoryOutcome: directory.outcome,
    markdownAttempts: markdown.attempts,
    markdownSuccesses: markdown.successes,
    deadlineExhausted: outcome === 'timed_out',
    failureCounts,
  }, clock, report, boundary.trace)
}

/**
 * Determine whether the mutable checkout exactly represents the reviewed head.
 *
 * @param {string} repoRoot - Absolute path to the reviewed repository root.
 * @param {string} headCommit - Immutable commit selected for review.
 * @param {Function} runGit - Injected Git subprocess runner.
 * @returns {{ kind: 'clean' | 'different-head' | 'dirty' } | { kind: 'error', operation: string }}
 *   Whether the checkout matches, is dirty, or could not be inspected.
 */
function isCheckedOutReviewHead(repoRoot, headCommit, runGit) {
  const head = runGit(['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.error || head.status !== 0) return { kind: 'error', operation: 'reading HEAD' }
  if (head.stdout.trim() !== headCommit) return { kind: 'different-head' }
  const status = runGit(['-C', repoRoot, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
  if (status.error || status.status !== 0) return { kind: 'error', operation: 'checking worktree status' }
  return status.stdout === '' ? { kind: 'clean' } : { kind: 'dirty' }
}

/**
 * Warm context tools only when the reviewed head is checked out cleanly.
 *
 * The environment override takes precedence over checkout inspection so a
 * deliberate warmup skip retains `warmContextIndex()`'s normal diagnostics.
 *
 * @param {string} repoRoot - Absolute path to the reviewed repository root.
 * @param {object} prepared - Prepared review details, including head and changed files.
 * @param {object} [boundary] - Injected warmup ports, including its monotonic clock.
 * @returns {void}
 */
export function warmReviewedContextIndex(repoRoot, prepared, boundary = CONTEXT_WARMUP_BOUNDARY) {
  const changedFiles = prepared.changedFiles || []
  if (boundary.environment.shouldSkip()) {
    warmContextIndex(repoRoot, changedFiles, boundary)
    return
  }

  const checkout = isCheckedOutReviewHead(repoRoot, prepared.headCommit, boundary.runGit)
  if (checkout.kind === 'clean') {
    warmContextIndex(repoRoot, changedFiles, boundary)
    return
  }
  if (checkout.kind === 'error') {
    boundary.report(`dakar-review: could not verify the reviewed checkout while ${checkout.operation}; skipping CodeGraph warmup.\n`)
    recordSkippedContextWarmup('checkout_verification_failed', boundary)
    return
  }

  boundary.report('dakar-review: reviewed head is not checked out cleanly; skipping CodeGraph warmup.\n')
  recordSkippedContextWarmup(checkout.kind === 'dirty' ? 'dirty_checkout' : 'different_head', boundary)
}
