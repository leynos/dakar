#!/usr/bin/env node
/**
 * Run Dakar's ODW review workflow from an installable CLI.
 *
 * The command preserves a parseable stdout result for automation while handling
 * repository-local configuration, AGENTS.md context, live ODW telemetry, and
 * deterministic review-history recording around the workflow runtime.
 *
 * @module
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { deriveOdwConfig } from '../scripts/odw-config.mjs'
import { addContextGuidance, CONTEXT_WARMUP_BOUNDARY, warmReviewedContextIndex } from '../scripts/context-warmup.mjs'
import { isRepositoryRelativePath } from '../scripts/repository-paths.mjs'
import { runDeterministicGates } from '../scripts/deterministic-gates.mjs'
import { pollOdwResult } from '../scripts/odw-result-poll.mjs'
import { parseReviewPolicy, resolveReviewConfig } from '../scripts/review-config.mjs'
import { DEFAULT_PRICING_TABLE } from '../src/workflows/dakar-review/pricing.ts'
import { worstCaseReviewSeconds } from '../src/workflows/dakar-review/retry.ts'
import {
  assembleSarif,
  projectDiscardedFromSarif,
  projectFindingsFromSarif,
  renderSarifMarkdown,
} from '../src/workflows/dakar-review/sarif.ts'
import { appendReview, prepare } from '../scripts/review-state.mjs'
import * as z from 'zod'

/** ODW's documented default per-model-call timeout in seconds. */
const DEFAULT_PER_CALL_TIMEOUT_SECONDS = 300
/** JSON replacer that leaves every value unchanged. */
const jsonReplacer = (_key, value) => value

/**
 * Serialise a value as two-space-indented JSON.
 *
 * @param {unknown} value - value to serialise.
 * @returns {string} the indented JSON text.
 */
const prettyJson = (value) => JSON.stringify(value, jsonReplacer, 2)
const jsonRecordSchema = z.record(z.string(), z.json())
const recordInputSchema = z.object({ metrics: jsonRecordSchema.optional() }).loose()
const dakarRunSchema = z.object({
  properties: z.object({ dakar: jsonRecordSchema.optional() }).loose().optional(),
}).loose()
const sarifOutputSchema = z.object({ runs: z.array(dakarRunSchema).optional() }).loose()

/** Require the workflow's boolean verdict flag at the result boundary. */
const workflowVerdictSchema = z.object({ ok: z.boolean() }).loose()
const workflowOutputSchema = z.object({
  metrics: jsonRecordSchema.optional(),
  recordInput: recordInputSchema.optional(),
}).loose()
const preparedSnapshotSchema = z.object({
  headCommit: z.string(),
  reviewBase: z.string(),
  commitCount: z.number(),
  changedFiles: z.array(z.string()),
}).loose()

/** Keep usage-log effects at the CLI boundary rather than inside parsing. */
const REPORTED_USAGE_BOUNDARY = Object.freeze({
  read: (path) => readFileSync(path, 'utf8'),
  remove: (path) => rmSync(path, { force: true }),
  report: (message) => process.stderr.write(message),
})

/**
 * Clamp a per-call timeout to the same default and bounds the workflow applies.
 *
 * `resolveWorkflowConfig` bounds `perCallTimeoutSeconds` with
 * `boundedInteger(value, 300, 30, 900)` (src/workflows/dakar-review/config.ts),
 * the source of truth for the default (300) and the inclusive range [30, 900].
 * The CLI applies the same default and range before deriving the run-local ODW
 * config so the stamped pi Flex adapter timeout and the workflow's
 * `worstCaseReviewSeconds` reason about one bounded value rather than diverging
 * (e.g. `--per-call-timeout 5000` stamping 5000 while the workflow caps at 900).
 *
 * Mirrors `resolveWorkflowConfig`'s `boundedInteger` semantics exactly
 * (src/workflows/dakar-review/config.ts): a sub-minimum or invalid value
 * falls back to the default rather than clamping up, and an over-maximum
 * value clamps down — so the derived adapter timeout and the workflow's
 * own `perCallTimeoutSeconds` can never diverge.
 *
 * @param {number} [value] - the parsed `--per-call-timeout` value, if any.
 * @returns {number} the bounded value: floor(value) in [30, 900] capped at
 * 900, or the 300 default when invalid or below 30.
 */
function clampPerCallTimeout(value = DEFAULT_PER_CALL_TIMEOUT_SECONDS) {
  const floored = Math.floor(Number(value))
  return Number.isFinite(floored) && floored >= 30 ? Math.min(floored, 900) : DEFAULT_PER_CALL_TIMEOUT_SECONDS
}

/**
 * Bound an optional numeric option the way `resolveWorkflowConfig` does.
 *
 * Mirrors `boundedInteger` (src/workflows/dakar-review/config.ts): invalid
 * or sub-minimum values fall back to the default, over-maximum values clamp
 * down. Used only for the advisory worst-case timeout warning, so the CLI
 * reasons about the same effective knobs as the workflow.
 *
 * @param {number} [value] - the parsed option value, if any.
 * @param {number} fallback - default used for invalid or sub-minimum values.
 * @param {number} min - inclusive lower bound for a valid value.
 * @param {number} max - inclusive upper bound; larger values clamp to it.
 * @returns {number} the bounded value.
 */
function clampLikeConfig(value, fallback, min, max) {
  const floored = Math.floor(Number(value))
  return Number.isFinite(floored) && floored >= min ? Math.min(floored, max) : fallback
}

const packageRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = nodePath.join(packageRoot, 'workflows', 'dakar-review.js')
const odwConfigPath = nodePath.join(packageRoot, 'odw.config.json')
const piAgentDir = nodePath.join(packageRoot, 'adapters', 'pi')

/**
 * Write a per-run ODW config that stamps the per-call timeout on the pi Flex
 * adapters, returning the temp file path for the CLI's own ODW spawns.
 *
 * The packaged config leaves each adapter call unbounded, so a run-local copy
 * carries the `--per-call-timeout` value (or the documented default) on every
 * pi Flex adapters only. The file lives under the OS temp directory and is
 * removed after the run, exactly like the usage-log file.
 *
 * @param {number} [perCallTimeoutSeconds] - per-model-call timeout in seconds.
 * @returns {string} absolute path to the derived config temp file.
 */
function writeDerivedOdwConfig(perCallTimeoutSeconds = DEFAULT_PER_CALL_TIMEOUT_SECONDS) {
  const baseConfig = JSON.parse(readFileSync(odwConfigPath, 'utf8'))
  const derived = deriveOdwConfig(baseConfig, perCallTimeoutSeconds)
  const path = nodePath.join(tmpdir(), `dakar-odw-config-${process.pid}-${Date.now()}.json`)
  writeFileSync(path, prettyJson(derived))
  return path
}

/**
 * Build the environment for spawned ODW processes.
 *
 * The pi Flex adapters need Dakar's own pi configuration directory (custom
 * `openai-flex` provider catalogue and the auto-loaded service-tier
 * extension under `extensions/`) and must skip pi's interactive version
 * check. When a usage-log path is given, the extension appends one JSON
 * line per model call there — the ODW runtime does not forward adapter
 * stderr, so this file is the only reported-usage channel. All variables
 * inherit through ODW to the adapter subprocesses it spawns.
 *
 * @param {string} [usageLogPath] - file the pi extension appends usage lines to.
 * @returns {NodeJS.ProcessEnv} the parent environment plus the pi variables.
 */
function odwEnv(usageLogPath = usageLogFile) {
  return Object.fromEntries([
    ...Object.entries(process.env),
    ['PI_CODING_AGENT_DIR', piAgentDir],
    ['PI_SKIP_VERSION_CHECK', '1'],
    ['TRACEPARENT', CONTEXT_WARMUP_BOUNDARY.trace.traceparent],
    ['DAKAR_USAGE_LOG', usageLogPath],
  ].filter(([, value]) => value !== undefined))
}

const usageLogFile = nodePath.join(tmpdir(), `dakar-usage-${process.pid}-${Date.now()}.jsonl`)

/**
 * Read and consume the pi extension's JSON-lines usage log.
 *
 * @param {string} logPath - path supplied to the pi extension.
 * @param {{ read: Function, remove: Function }} boundary - Narrow filesystem effects.
 * @returns {{ lines: unknown[], readOutcome: string, parseOutcome: string, cleanupOutcome: string, invalidLines: number }} Explicit read, parse, and cleanup evidence.
 */
function consumeReportedUsageLog(logPath, boundary) {
  let raw
  try {
    raw = boundary.read(logPath)
  } catch (error) {
    return { lines: [], readOutcome: error?.code === 'ENOENT' ? 'absent' : 'failed', parseOutcome: 'not_attempted', cleanupOutcome: 'not_attempted', invalidLines: 0 }
  }
  let cleanupOutcome = 'succeeded'
  try {
    boundary.remove(logPath)
  } catch {
    cleanupOutcome = 'failed'
  }
  return { ...parseReportedUsage(raw), readOutcome: 'succeeded', cleanupOutcome }
}

/** Parse usage records in order without imposing a schema on valid JSON. */
function parseReportedUsage(raw) {
  const lines = []
  let invalidLines = 0
  let parseOutcome = 'succeeded'
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      lines.push(JSON.parse(line))
    } catch {
      invalidLines += 1
      parseOutcome = 'degraded'
    }
  }
  return { lines, invalidLines, parseOutcome }
}

/** Expose advisory usage-log failures without disclosing paths or records. */
function reportUsageLogOutcome(result, report) {
  if (result.readOutcome !== 'failed' && result.cleanupOutcome !== 'failed' && result.invalidLines === 0) return
  const event = {
    event: 'reported_usage_log',
    readOutcome: result.readOutcome,
    parseOutcome: result.parseOutcome,
    cleanupOutcome: result.cleanupOutcome,
    invalidLines: result.invalidLines,
  }
  report(`dakar-review: usage log ${JSON.stringify(event)}\n`)
}

/**
 * Sum the four reported token fields without changing their numeric coercion.
 *
 * @param {unknown[]} lines - parsed usage-log records.
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number }} reported totals.
 */
function sumReportedTokens(lines) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const line of lines) {
    for (const key of Object.keys(totals)) {
      totals[key] += Number(line.usage?.[key]) || 0
    }
  }
  return totals
}

/** Reports a bounded usage-boundary failure without exposing workflow data. */
function reportUsageValidation(operation) {
  const event = { event: 'reported_usage_validation', operation, category: 'schema_validation' }
  REPORTED_USAGE_BOUNDARY.report(`dakar-review: usage validation ${JSON.stringify(event)}\n`)
}

/** Refuses to record a review whose usage metrics cannot be safely attached. */
function failUsageValidation(output, operation) {
  reportUsageValidation(operation)
  return { ...output, ok: false, stage: 'reported_usage', error: 'workflow output failed reported usage validation' }
}

/** Adds usage to SARIF when its optional metadata is well formed. */
function annotateSarifUsage(output, lines, totals) {
  if (output.sarif === undefined) return
  const parsed = sarifOutputSchema.safeParse(output.sarif)
  if (!parsed.success) {
    reportUsageValidation('reported_usage_sarif')
    return
  }
  output.sarif = parsed.data
  const sarifDakar = output.sarif.runs?.[0]?.properties?.dakar
  if (sarifDakar !== undefined) {
    sarifDakar.reportedUsage = lines
    sarifDakar.reportedTokens = totals
  }
}

/**
 * Stamp reported usage and totals onto workflow metrics and its first SARIF run.
 *
 * @param {object} output - parsed workflow result to annotate in place.
 * @param {unknown[]} lines - parsed usage records retained on the result.
 * @param {{ input: number, output: number, cacheRead: number, cacheWrite: number }} totals - summed token counts.
 * @returns {{ output: object, ok: boolean }} annotated output or a validation failure.
 */
function annotateReportedUsage(output, lines, totals) {
  const parsed = workflowOutputSchema.safeParse(output)
  if (!parsed.success) return { output: failUsageValidation(output, 'reported_usage_annotation'), ok: false }
  const annotated = parsed.data
  annotated.metrics = annotated.metrics || {}
  annotated.metrics.reportedUsage = lines
  annotated.metrics.reportedTokens = totals
  annotateSarifUsage(annotated, lines, totals)
  return { output: annotated, ok: true }
}

/**
 * Attach the pi extension's reported usage lines to the workflow output.
 *
 * The extension appends one JSON line per model call to `DAKAR_USAGE_LOG`
 * (`{ model, usage: { input, output, cacheRead, cacheWrite, … } }`). The
 * lines and their token totals are stamped additively onto
 * `output.metrics` so both successful and deferred results carry the
 * provider-reported usage; pricing them stays with the caller (the ledger's
 * estimates remain separate by design). The log file is removed afterwards.
 *
 * @param {object} output - the parsed workflow result to annotate.
 * @returns {{ output: object, ok: boolean }} annotated output or a validation failure.
 */
function attachReportedUsage(output) {
  const result = consumeReportedUsageLog(usageLogFile, REPORTED_USAGE_BOUNDARY)
  reportUsageLogOutcome(result, REPORTED_USAGE_BOUNDARY.report)
  const { lines } = result
  if (lines.length === 0) return { output, ok: true }
  const totals = sumReportedTokens(lines)
  return annotateReportedUsage(output, lines, totals)
}

const OPTION_SPECS = new Map([
  ['repo-root', { key: 'repoRoot', value: true }],
  ['config', { key: 'config', value: true }],
  ['base', { key: 'base', value: true }],
  ['head', { key: 'head', value: true }],
  ['state-root', { key: 'stateRoot', value: true }],
  ['max-tasks', { key: 'maxTasks', value: true, number: true }],
  ['max-candidates', { key: 'maxCandidates', value: true, number: true }],
  ['max-findings', { key: 'maxFindings', value: true, number: true }],
  ['synthesis-model', { key: 'synthesisModel', value: true }],
  ['synthesis-reasoning', { key: 'synthesisReasoning', value: true }],
  // Review-tuning knobs (ADR 002 admission and retry envelope). The CLI only
  // forwards these to their WorkflowArgs keys; resolveWorkflowConfig owns the
  // bounds, so no validation is duplicated here beyond the numeric parse.
  ['budget-gbp', { key: 'budgetGbp', value: true, number: true }],
  ['max-luna-calls', { key: 'maxLunaFlexCalls', value: true, number: true }],
  ['transaction-max-files', { key: 'transactionMaxFiles', value: true, number: true }],
  ['transaction-max-input-tokens', { key: 'transactionMaxInputTokens', value: true, number: true }],
  ['transaction-max-output-tokens', { key: 'transactionMaxOutputTokens', value: true, number: true }],
  ['terra-max-input-tokens', { key: 'terraMaxInputTokens', value: true, number: true }],
  ['terra-max-output-tokens', { key: 'terraMaxOutputTokens', value: true, number: true }],
  ['adapter-overhead-tokens', { key: 'adapterOverheadTokens', value: true, number: true }],
  ['max-audit-candidates', { key: 'maxAuditCandidates', value: true, number: true }],
  ['luna-reasoning', { key: 'lunaReasoning', value: true }],
  ['routing-policy', { key: 'routingPolicy', value: true }],
  ['flex-attempts', { key: 'flexAttempts', value: true, number: true }],
  ['per-call-timeout', { key: 'perCallTimeoutSeconds', value: true, number: true }],
  ['timeout', { key: 'timeout', value: true, number: true }],
  ['runs-root', { key: 'runsRoot', value: true }],
  ['format', { key: 'format', value: true }],
  ['odw-bin', { key: 'odwBin', value: true }],
  ['telemetry', { key: 'telemetry', value: false }],
  ['dry-run', { key: 'dryRun', value: false }],
  ['help', { key: 'help', value: false }],
  ['version', { key: 'version', value: false }],
])

/**
 * Resolve one CLI token to its option name, inline value, and specification.
 *
 * @param {string} token - argument token to parse.
 * @returns {{ name: string, inlineValue: string | undefined, spec: { key: string, value: boolean, number?: boolean } }} parsed option details.
 */
function readOptionToken(token) {
  if (!token.startsWith('--')) {
    throw new Error(`unexpected positional argument: ${token}`)
  }
  const [name, inlineValue] = token.slice(2).split(/=(.*)/su, 2)
  const spec = OPTION_SPECS.get(name)
  if (!spec) {
    throw new Error(`unknown option: --${name}`)
  }
  return { name, inlineValue, spec }
}

/**
 * Validate that a value option has a value which is not another option token.
 *
 * @param {string} name - option name used in the existing diagnostic.
 * @param {string | undefined} value - inline or following argument value.
 * @returns {string} validated option value.
 */
function requireOptionValue(name, value) {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`)
  }
  return value
}

/**
 * Consume the value associated with a resolved CLI option.
 *
 * @param {string[]} argv - argument tokens, excluding the node/script prefix.
 * @param {number} index - index of the option token in `argv`.
 * @param {{ name: string, inlineValue: string | undefined, spec: { key: string, value: boolean, number?: boolean } }} option - resolved option token.
 * @returns {{ value: string | number | boolean, nextIndex: number }} converted value and next unconsumed token index.
 */
function consumeOptionValue(argv, index, option) {
  const { name, inlineValue, spec } = option
  if (!spec.value) {
    if (inlineValue !== undefined) {
      throw new Error(`--${name} does not take a value`)
    }
    return { value: true, nextIndex: index + 1 }
  }
  const value = requireOptionValue(name, inlineValue === undefined ? argv[index + 1] : inlineValue)
  return {
    value: spec.number ? numberValue(name, value) : value,
    nextIndex: inlineValue === undefined ? index + 2 : index + 1,
  }
}

/**
 * Parse the CLI argument vector into a plain options object.
 *
 * @param {string[]} argv - argument tokens, excluding the node/script prefix.
 * @returns {object} key-value map of resolved option values.
 */
function parseArgs(argv) {
  const parsed = {}
  let index = 0
  while (index < argv.length) {
    const option = readOptionToken(argv[index])
    const consumed = consumeOptionValue(argv, index, option)
    parsed[option.spec.key] = consumed.value
    index = consumed.nextIndex
  }
  return parsed
}

/**
 * Parse a CLI option value as a finite number, throwing on invalid input.
 *
 * @param {string} name - option name used in the error message.
 * @param {string} value - raw string value from the argument vector.
 * @returns {number} the parsed numeric value.
 */
function numberValue(name, value) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new TypeError(`--${name} must be a number`)
  }
  return number
}

/**
 * Extract and parse the first JSON object found in a string of text.
 *
 * @param {string} text - raw text, typically ODW stdout.
 * @returns {object} the parsed JSON object.
 */
function extractJson(text) {
  const start = text.indexOf('{')
  if (start === -1) {
    throw new Error('ODW output did not contain a JSON object')
  }
  return JSON.parse(text.slice(start))
}

/**
 * Extract the ODW run identifier from the output of a non-waiting `odw run` call.
 *
 * @param {string} text - raw stdout from ODW.
 * @returns {string} the run id in `YYYYMMDD-HHMMSS-<hex>` format.
 */
function extractRunId(text) {
  const match = text.match(/\b\d{8}-\d{6}-[0-9a-f]+\b/u)
  if (!match) {
    throw new Error('ODW output did not contain a run id')
  }
  return match[0]
}

/**
 * Run a Git command against a trusted instruction commit and contextualise failures.
 *
 * @param {string} repoRoot - absolute path to the repository root.
 * @param {string[]} args - Git arguments following `-C <repoRoot>`.
 * @param {{ prefix: string, fallback: string }} failureContext - operation-specific diagnostic details.
 * @returns {string} unmodified stdout from the successful Git command.
 */
function runTrustedInstructionGit(repoRoot, args, failureContext) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${failureContext.prefix}: ${result.stderr.trim() || failureContext.fallback}`)
  }
  return result.stdout
}

/**
 * Read `AGENTS.md` from the trusted review base, returning undefined when absent.
 *
 * Content is truncated to 24,000 characters so large files do not overflow
 * the workflow argument budget.
 *
 * @param {string} repoRoot - absolute path to the repository root.
 * @param {string} baseRef - trusted Git revision preceding the reviewed range.
 * @returns {{ source: string, content: string, truncated: boolean } | undefined} parsed instructions, or undefined.
 */
function readAgentInstructions(repoRoot, baseRef) {
  const resolvedCommit = runTrustedInstructionGit(
    repoRoot,
    ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
    { prefix: `cannot resolve trusted review base ${baseRef}`, fallback: 'git rev-parse failed' },
  ).trim()
  const entries = runTrustedInstructionGit(
    repoRoot,
    ['ls-tree', '-z', resolvedCommit, '--', 'AGENTS.md'],
    { prefix: `cannot inspect ${resolvedCommit}:AGENTS.md`, fallback: 'git ls-tree failed' },
  )
  if (entries === '') return
  const content = runTrustedInstructionGit(
    repoRoot,
    ['show', `${resolvedCommit}:AGENTS.md`],
    { prefix: `cannot read ${resolvedCommit}:AGENTS.md`, fallback: 'git show failed' },
  )
  return {
    source: `${resolvedCommit}:AGENTS.md`,
    content: content.slice(0, 24_000),
    truncated: content.length > 24_000,
  }
}

/**
 * Resolve configuration and assemble the `--args` object passed to the ODW workflow.
 *
 * @param {object} options - parsed CLI options from `parseArgs`.
 * @param {string} repoRoot - absolute path to the repository root.
 * @returns {object} workflow arguments ready to be JSON-serialized.
 */
function buildWorkflowArgs(options, repoRoot) {
  const resolvedConfig = resolveReviewConfig({ repoRoot, config: options.config, packageRoot })
  if (resolvedConfig.ok === false) {
    throw new Error(resolvedConfig.error || `could not resolve review config: ${resolvedConfig.config}`)
  }
  const agentInstructions = readAgentInstructions(repoRoot, options.base || 'origin/main')
  const workflowArgs = {
    config: resolvedConfig.config,
    policy: resolvedConfig.policy,
    repoRoot,
  }
  addContextGuidance(workflowArgs, repoRoot)
  if (agentInstructions) {
    workflowArgs.agentInstructions = agentInstructions
  }
  for (const [optionKey, workflowKey] of [
    ['base', 'base'],
    ['head', 'head'],
    ['stateRoot', 'stateRoot'],
    ['maxTasks', 'maxTasks'],
    ['maxCandidates', 'maxCandidates'],
    ['maxFindings', 'maxFindings'],
    ['synthesisModel', 'synthesisModel'],
    ['synthesisReasoning', 'synthesisReasoning'],
    ['budgetGbp', 'budgetGbp'],
    ['maxLunaFlexCalls', 'maxLunaFlexCalls'],
    ['transactionMaxFiles', 'transactionMaxFiles'],
    ['transactionMaxInputTokens', 'transactionMaxInputTokens'],
    ['transactionMaxOutputTokens', 'transactionMaxOutputTokens'],
    ['terraMaxInputTokens', 'terraMaxInputTokens'],
    ['terraMaxOutputTokens', 'terraMaxOutputTokens'],
    ['adapterOverheadTokens', 'adapterOverheadTokens'],
    ['maxAuditCandidates', 'maxAuditCandidates'],
    ['lunaReasoning', 'lunaReasoning'],
    ['routingPolicy', 'routingPolicy'],
    ['flexAttempts', 'flexAttempts'],
    ['perCallTimeoutSeconds', 'perCallTimeoutSeconds'],
  ]) {
    if (options[optionKey] !== undefined) {
      workflowArgs[workflowKey] = options[optionKey]
    }
  }
  if (options.dryRun) {
    workflowArgs.dryRun = true
  }
  return workflowArgs
}

/**
 * Build the `odw run` argument array for launching the workflow.
 *
 * @param {object} options - parsed CLI options.
 * @param {object} workflowArgs - serializable workflow arguments.
 * @param {boolean} wait - when true, appends `--wait` and `--timeout` flags.
 * @returns {string[]} argument array suitable for passing to `spawnSync`.
 */
function buildOdwRunArgs(options, workflowArgs, wait) {
  const odwArgs = [
    'run',
    workflowPath,
    '--source',
    packageRoot,
    '--config',
    // The CLI's own spawns use a run-local config that bounds the pi Flex calls
    // with the per-call timeout; it falls back to the packaged path only if the
    // derivation was skipped.
    options.odwConfigPath || odwConfigPath,
  ]
  if (wait) {
    odwArgs.push('--wait', '--timeout', String(options.timeout || 3600))
  }
  odwArgs.push('--args', JSON.stringify(workflowArgs))
  if (options.runsRoot) {
    odwArgs.splice(2, 0, '--runs-root', nodePath.resolve(options.runsRoot))
  }
  return odwArgs
}

/**
 * Build an `odw <command> <runId>` argument array, optionally including `--runs-root`.
 *
 * @param {string} command - ODW sub-command (e.g. `'result'` or `'logs'`).
 * @param {object} options - parsed CLI options.
 * @param {string} runId - ODW run identifier.
 * @param {string[]} [extraArgs] - additional arguments appended after the run id.
 * @returns {string[]} argument array suitable for passing to `spawnSync`.
 */
function buildRunScopedArgs(command, options, runId, extraArgs = []) {
  const args = [command, runId]
  if (options.runsRoot) {
    args.push('--runs-root', nodePath.resolve(options.runsRoot))
  }
  args.push(...extraArgs)
  return args
}

/**
 * Write the workflow result to stdout in the requested format.
 *
 * @param {object} output - the ODW workflow result object.
 * @param {string} format - `'json'` or `'markdown'`.
 */
function printWorkflowOutput(output, format) {
  if (format === 'markdown') {
    process.stdout.write(`${output.reportMarkdown || prettyJson(output)}\n`)
  } else {
    process.stdout.write(`${prettyJson(output)}\n`)
  }
}

/**
 * Compare two changed-file arrays element by element.
 *
 * @param {unknown} left - candidate changed-file list.
 * @param {unknown} right - trusted changed-file list.
 * @returns {boolean} whether both are arrays of identical length and order.
 */
function changedFilesEqual(left, right) {
  if (!Array.isArray(left)) return false
  if (!Array.isArray(right)) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/**
 * Validate a workflow-supplied recordInput against the CLI's own prepared
 * review snapshot before it is appended to history. This closes the seam where
 * a compromised or buggy workflow could record a head, base, commit count, or
 * file set the CLI never prepared.
 *
 * @param {object} recordInput - the workflow-supplied snapshot to append.
 * @param {object} [prepared] - the CLI's trusted prepared review range.
 * @returns {string | undefined} a message naming the mismatched field, or undefined when consistent.
 */
function snapshotMismatch(recordInput, prepared) {
  if (prepared === undefined) return
  const parsed = preparedSnapshotSchema.safeParse(prepared)
  if (!parsed.success) return 'prepared review snapshot is invalid; refusing to record'
  const preparedSnapshot = parsed.data
  const scalarChecks = [
    ['headCommit', recordInput.headCommit, preparedSnapshot.headCommit],
    ['baseCommit', recordInput.baseCommit, preparedSnapshot.reviewBase],
    ['commitCount', recordInput.commitCount, preparedSnapshot.commitCount],
  ]
  for (const [field, actual, expected] of scalarChecks) {
    if (actual !== expected) {
      return `recordInput.${field} (${JSON.stringify(actual)}) does not match the prepared review snapshot (${JSON.stringify(expected)}); refusing to record`
    }
  }
  if (!changedFilesEqual(recordInput.changedFiles, preparedSnapshot.changedFiles)) {
    return 'recordInput.changedFiles does not match the prepared review snapshot; refusing to record'
  }
  return
}

/**
 * Record a successful review in Dakar's history via the trusted state helper.
 *
 * This is the primary recording path: the workflow no longer records itself, so
 * after a successful, non-skipped, non-dry-run result the CLI appends the
 * completed head through {@link appendReview}. The state file is always derived
 * from the trusted `{repoRoot, stateRoot}` location, never from any
 * workflow-supplied path. The result is validated fail-closed first: an absent
 * recordInput, or a recordInput contradicting the CLI's prepared snapshot, is
 * refused with `stage: "record"` and never recorded. On success the result
 * gains a `recorded` stamp with `recordedBy: "dakar-review"`; on failure it is
 * marked `stage: "record"` with `recordInput` preserved for manual retry so the
 * caller exits non-zero. Dry-run, skipped, and already-failed results are
 * returned untouched.
 *
 * @param {object} output - the ODW workflow result to record in place.
 * @param {object} trustedLocation - trusted `repo-root`/`state-root` used to derive the state file.
 * @param {object} [prepared] - the CLI's trusted prepared review range for snapshot validation.
 * @returns {object} the (possibly updated) workflow result.
 */
function recordReview(output, trustedLocation, prepared) {
  if (output.dryRun || output.skipped || output.ok !== true) {
    return output
  }
  // A review that completed with partial planned coverage legitimately
  // withholds recordInput (recordWithheld carries the reason and counts);
  // the head must stay unrecorded, and that is not an error.
  if (output.recordWithheld && !output.recordInput) {
    return output
  }
  // Fail closed: an ok result with no recordInput and no recordWithheld
  // marker must never be treated as a complete review, so refuse rather
  // than silently return it unrecorded.
  if (!output.recordInput) {
    const error = 'workflow result lacked recordInput; refusing to treat an unrecorded review as complete'
    output.ok = false
    output.stage = 'record'
    output.error = error
    output.recorded = { ok: false, error, recordedBy: 'dakar-review' }
    return output
  }
  const mismatch = snapshotMismatch(output.recordInput, prepared)
  if (mismatch) {
    output.ok = false
    output.stage = 'record'
    output.error = mismatch
    output.recorded = { ok: false, error: mismatch, recordedBy: 'dakar-review' }
    // recordInput is left in place so the review can be recorded manually later.
    return output
  }
  try {
    const recorded = appendReview(output.recordInput, trustedLocation)
    output.recorded = {
      ok: true,
      stateFile: recorded.stateFile,
      headCommit: recorded.headCommit,
      recordedBy: 'dakar-review',
    }
    output.stateFile = recorded.stateFile
  } catch (error) {
    output.ok = false
    output.stage = 'record'
    output.error = error.message
    output.recorded = { ok: false, error: error.message, recordedBy: 'dakar-review' }
    // recordInput is left in place so the review can be recorded manually later.
  }
  return output
}

/**
 * Copy provider-reported metrics into the recordable result when present.
 *
 * @param {object} output - the parsed ODW workflow result.
 */
function copyReportedMetricsToRecordInput(output) {
  if (!output.recordInput) return output
  const parsed = workflowOutputSchema.safeParse(output)
  if (!parsed.success) return failUsageValidation(output, 'reported_usage_recording')
  const recordable = parsed.data
  if (!recordable.recordInput) return recordable
  const metrics = recordable.recordInput.metrics || {}
  if (recordable.metrics?.reportedUsage !== undefined) metrics.reportedUsage = recordable.metrics.reportedUsage
  if (recordable.metrics?.reportedTokens !== undefined) metrics.reportedTokens = recordable.metrics.reportedTokens
  recordable.recordInput.metrics = metrics
  return recordable
}

/**
 * Attach reported usage, fold it into recordInput, then record the review.
 *
 * The reported-usage lines are attached (and their token totals folded into
 * `recordInput.metrics`) BEFORE recording, so the persisted `reviews.toml`
 * carries the provider-reported usage rather than only the printed result. The
 * snapshot is then validated and appended through the trusted state root.
 *
 * @param {object} output - the parsed ODW workflow result.
 * @param {object} workflowArgs - the CLI's workflow arguments, carrying repoRoot, stateRoot, and prepared.
 * @returns {object} the annotated and (on success) recorded workflow result.
 */
function finalizeWorkflowResult(output, workflowArgs) {
  const usage = attachReportedUsage(output)
  output = usage.output
  // A dry run never records: there is no prepared snapshot to validate against
  // and no completed head to append.
  if (!usage.ok || workflowArgs.dryRun) return output
  output = copyReportedMetricsToRecordInput(output)
  return recordReview(
    output,
    { 'repo-root': workflowArgs.repoRoot, 'state-root': workflowArgs.stateRoot },
    workflowArgs.prepared,
  )
}

/**
 * Run ODW synchronously with `--wait`, suppressing all log output to stderr.
 *
 * @param {object} options - parsed CLI options.
 * @param {object} workflowArgs - workflow arguments to pass via `--args`.
 * @returns {{ output?: object, status?: number }} parsed result or an exit status on failure.
 */
function runOdwQuiet(options, workflowArgs) {
  const result = spawnSync(options.odwBin || 'odw', buildOdwRunArgs(options, workflowArgs, true), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: odwEnv(),
  })

  if (result.status !== 0) {
    const error = {
      ok: false,
      stage: 'odw',
      status: result.status,
      error: result.stderr.trim() || result.stdout.trim() || 'ODW failed',
    }
    process.stderr.write(`${prettyJson(error)}\n`)
    return { status: result.status || 1 }
  }

  return { output: finalizeWorkflowResult(extractJson(result.stdout), workflowArgs) }
}

/**
 * Spawn `odw logs --follow` and stream its output to stderr, resolving when it exits.
 *
 * Kills the child process and resolves with exit code 124 if `timeoutMs` elapses
 * before the log stream closes naturally.
 *
 * @param {string} odwBin - path or name of the ODW executable.
 * @param {string[]} args - argument array for the `odw logs` sub-command.
 * @param {number} timeoutMs - maximum milliseconds to follow before killing.
 * @returns {Promise<number>} exit code of the child, or 124 on timeout.
 */
function followOdwLogs(odwBin, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(odwBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: odwEnv() })
    let timedOut = false
    const timer = globalThis.setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => process.stderr.write(chunk))
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.on('error', (error) => {
      globalThis.clearTimeout(timer)
      process.stderr.write(`dakar-review: failed to follow ODW logs: ${error.message}\n`)
      resolvePromise(1)
    })
    child.on('close', (code) => {
      globalThis.clearTimeout(timer)
      resolvePromise(timedOut ? 124 : code || 0)
    })
  })
}

/**
 * A failure to retrieve an ODW result within its polling deadline.
 *
 * Carries the bounded poll metrics the CLI reports in its structured failure
 * envelope, so a failed retrieval stays measurable without unbounded labels.
 */
class OdwResultError extends Error {
  /**
   * @param {string} message - human-readable failure description.
   * @param {{ attempts: number, failures: number, elapsedMs: number, terminal: string, category: string }} poll - bounded poll metrics.
   */
  constructor(message, poll) {
    super(message)
    /** Always `'OdwResultError'`, distinguishing it from other retrieval failures. */
    this.name = 'OdwResultError'
    /** Bounded poll metrics for the failure envelope. */
    this.poll = poll
  }
}

/**
 * Classify a failed result fetch into one bounded telemetry category.
 *
 * @param {import('node:child_process').SpawnSyncReturns<string>} result - the final fetch result.
 * @returns {'spawn_error' | 'terminated' | 'nonzero_exit'} the failure category.
 */
function resultFailureCategory(result) {
  if (result.error) return 'spawn_error'
  if (result.signal) return 'terminated'
  return 'nonzero_exit'
}

/**
 * Emit one bounded structured event for a finished result poll.
 *
 * @param {string} runId - ODW run identifier.
 * @param {object} metrics - the outcome's poll metrics, already built once.
 * @returns {void}
 */
function reportResultPoll(runId, metrics) {
  process.stderr.write(`${JSON.stringify({ event: 'odw_result_poll', runId, ...metrics })}\n`)
}

/**
 * Describe why the final result fetch failed.
 *
 * @param {import('node:child_process').SpawnSyncReturns<string>} result - the final fetch result.
 * @param {object} options - parsed CLI options.
 * @param {string} runId - ODW run identifier.
 * @returns {string} the most specific available failure explanation.
 */
function resultFailureMessage(result, options, runId) {
  return result.error?.message || result.stderr.trim() || result.stdout.trim() ||
    `timed out waiting for ODW run ${runId} after ${options.timeout || 3600}s`
}

/**
 * Build one outcome's bounded poll metrics.
 *
 * The caller builds these once per terminal outcome and reuses the same object
 * for the poll event and any failure envelope, so the two outputs cannot
 * disagree about `elapsedMs` or the counters.
 *
 * @param {{ attempts: number, failures: number, startedAt: number }} poll - poll counters.
 * @param {number} elapsedMs - elapsed time measured by the poller's injected clock.
 * @param {'completed' | 'failed'} terminal - terminal state of the poll.
 * @param {string} category - fixed failure category, or `none` on success.
 * @returns {{ attempts: number, failures: number, elapsedMs: number, terminal: string, category: string }} the outcome metrics.
 */
function pollMetrics(poll, elapsedMs, terminal, category) {
  return {
    attempts: poll.attempts,
    failures: poll.failures,
    elapsedMs,
    terminal,
    category,
  }
}

/**
 * Retrieve, finalize and record the ODW result, reporting one bounded poll event.
 *
 * The command unit owns finalization, telemetry and the failure envelope, while
 * {@link pollOdwResult} stays a read-only polling seam. A zero exit status does
 * not guarantee a usable payload, so malformed JSON or an invalid result shape
 * fails the retrieval and reports the same `invalid_output` outcome in the poll
 * event and the failure envelope.
 *
 * @param {object} options - parsed CLI options.
 * @param {object} workflowArgs - workflow arguments to pass via `--args`.
 * @param {string} runId - ODW run identifier to query.
 * @param {number} [timeoutMs] - polling deadline in milliseconds (default: `timeout` option × 1000).
 * @returns {Promise<object>} the parsed and (on success) recorded workflow result.
 * @throws {OdwResultError} when no usable result is available within the deadline.
 */
async function waitForOdwResult(options, workflowArgs, runId, timeoutMs = (options.timeout || 3600) * 1000) {
  const odwBin = options.odwBin || 'odw'
  const { result, poll, elapsedMs } = await pollOdwResult({
    fetchResult: () => spawnSync(odwBin, buildRunScopedArgs('result', options, runId), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: odwEnv(),
    }),
    now: Date.now,
    sleepFn: sleep,
    timeoutMs,
  })
  if (result.status !== 0) {
    const metrics = pollMetrics(poll, elapsedMs, 'failed', resultFailureCategory(result))
    reportResultPoll(runId, metrics)
    throw new OdwResultError(resultFailureMessage(result, options, runId), metrics)
  }
  let output
  try {
    // Validate the raw payload: finalisation normalizes unusable results (for
    // example a malformed `recordInput`) into an `ok: false` envelope and
    // consumes the usage log, so checking afterwards would both accept a
    // shapeless result and discard the only reported-usage channel.
    const rawOutput = extractJson(result.stdout)
    if (!workflowVerdictSchema.safeParse(rawOutput).success) {
      throw new Error('ODW result must contain a boolean `ok`')
    }
    output = finalizeWorkflowResult(rawOutput, workflowArgs)
  } catch (error) {
    poll.failures += 1
    const metrics = pollMetrics(poll, elapsedMs, 'failed', 'invalid_output')
    reportResultPoll(runId, metrics)
    throw new OdwResultError(`invalid ODW result: ${error.message}`, metrics)
  }
  reportResultPoll(runId, pollMetrics(poll, elapsedMs, 'completed', 'none'))
  return output
}

/**
 * Build the structured result-retrieval failure envelope.
 *
 * @param {string} stage - CLI stage reporting the failure.
 * @param {string} runId - ODW run identifier.
 * @param {Error} error - the caught result-retrieval failure.
 * @returns {object} the JSON-serialisable failure envelope.
 */
function resultFailureEnvelope(stage, runId, error) {
  const poll = error instanceof OdwResultError ? error.poll : {}
  return { ok: false, stage, runId, ...poll, error: error.message }
}

/**
 * Give a timed-out log follow a separate five-second result-recovery window.
 *
 * @param {object} options - parsed CLI options.
 * @param {object} workflowArgs - workflow arguments to pass via `--args`.
 * @param {string} runId - ODW run identifier to recover.
 * @returns {Promise<{ output?: object, status?: number }>} recovered result or failure status.
 */
async function recoverOdwResultAfterLogTimeout(options, workflowArgs, runId) {
  // A hung or outlasted log stream must not abandon a possibly-completed
  // (and already billed) review: give the result one short grace fetch so
  // a run that finished while the follow was stuck is still recorded.
  process.stderr.write(
    `dakar-review: log follow timed out after ${options.timeout || 3600}s; attempting one result fetch\n`,
  )
  try {
    return { output: await waitForOdwResult(options, workflowArgs, runId, 5000) }
  } catch (error) {
    process.stderr.write(`${prettyJson(resultFailureEnvelope('odw-logs', runId, error))}\n`)
    return { status: 1 }
  }
}

/**
 * Report an unsuccessful ODW launch using the CLI's established error envelope.
 *
 * @param {object} result - synchronous ODW launch result.
 * @returns {{ status: number }} non-zero command status for the caller.
 */
function reportOdwLaunchFailure(result) {
  const error = {
    ok: false,
    stage: 'odw',
    status: result.status,
    error: result.stderr.trim() || result.stdout.trim() || 'ODW failed',
  }
  process.stderr.write(`${prettyJson(error)}\n`)
  return { status: result.status || 1 }
}

/**
 * Run ODW asynchronously, streaming live log output to stderr while preserving a clean stdout result.
 *
 * Launches a non-waiting `odw run`, follows logs via {@link followOdwLogs}, then
 * fetches the final result via {@link waitForOdwResult}.
 *
 * @param {object} options - parsed CLI options.
 * @param {object} workflowArgs - workflow arguments to pass via `--args`.
 * @returns {Promise<{ output?: object, status?: number }>} parsed result or an exit status on failure.
 */
async function runOdwWithTelemetry(options, workflowArgs) {
  const odwBin = options.odwBin || 'odw'
  const result = spawnSync(odwBin, buildOdwRunArgs(options, workflowArgs, false), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: odwEnv(),
  })

  if (result.status !== 0) {
    return reportOdwLaunchFailure(result)
  }

  if (result.stderr.trim()) {
    process.stderr.write(`${result.stderr.trim()}\n`)
  }
  const runId = extractRunId(result.stdout)
  const timeoutMs = (options.timeout || 3600) * 1000
  const resultDeadline = Date.now() + timeoutMs
  process.stderr.write(`dakar-review: following ODW run ${runId}\n`)
  process.stderr.write(`${JSON.stringify({
    event: 'dakar_trace_link',
    traceId: CONTEXT_WARMUP_BOUNDARY.trace.traceId,
    spanId: CONTEXT_WARMUP_BOUNDARY.trace.spanId,
    runId,
  })}\n`)
  const logStatus = await followOdwLogs(odwBin, buildRunScopedArgs('logs', options, runId, ['--follow']), timeoutMs)
  if (logStatus === 124) {
    return recoverOdwResultAfterLogTimeout(options, workflowArgs, runId)
  }
  if (logStatus !== 0) {
    process.stderr.write(`dakar-review: ODW log stream exited with status ${logStatus}; fetching result anyway\n`)
  }

  try {
    return { output: await waitForOdwResult(options, workflowArgs, runId, Math.max(0, resultDeadline - Date.now())) }
  } catch (error) {
    process.stderr.write(`${prettyJson(resultFailureEnvelope('odw-result', runId, error))}\n`)
    return { status: 1 }
  }
}

/**
 * Return the CLI help string describing all available options.
 *
 * @returns {string} formatted usage text.
 */
function usage() {
  return `Usage: dakar-review [options]

Run Dakar's routed review workflow and print the workflow result.

Options:
  --repo-root <path>          Git checkout to review (default: cwd)
  --config <path>             CodeRabbit YAML path, relative to repo root
  --base <ref>                Base ref for first review (default: origin/main)
  --head <ref>                Head ref to review (default: HEAD)
  --state-root <path>         Isolated review-history root
  --max-tasks <n>             Maximum planned review tasks
  --max-candidates <n>        Maximum candidates sent to verification
  --max-findings <n>          Maximum accepted findings
  --synthesis-model <model>   Synthesis model (default: gpt-5.5)
  --synthesis-reasoning <r>   Synthesis reasoning: low, medium, or high
  --timeout <seconds>         ODW wait timeout (default: 3600)
  --runs-root <path>          ODW runs directory
  --format <json|markdown>    Output format (default: json)
  --odw-bin <path>            ODW executable (default: odw)
  --telemetry                 Stream ODW logs to stderr while preserving final stdout
  --dry-run                   Return workflow contract without agents
  --help                      Show this help

Review tuning (bounds enforced by the workflow; the CLI only forwards):
  --budget-gbp <n>                   Hard admission budget in GBP (default: 0.15)
  --max-luna-calls <n>               Maximum Luna Flex finder calls (default: 4)
  --transaction-max-files <n>        Maximum files per finder pack (default: 5)
  --transaction-max-input-tokens <n> Finder input-token estimate (default: 12000)
  --transaction-max-output-tokens <n> Finder output-token estimate (default: 2000)
  --terra-max-input-tokens <n>       Audit input-token estimate (default: 48000)
  --terra-max-output-tokens <n>      Audit output-token estimate (default: 5000)
  --adapter-overhead-tokens <n>      Per-call adapter overhead tokens (default: 13000)
  --max-audit-candidates <n>         Maximum candidates sent to the audit (default: 30)
  --luna-reasoning <low|medium|high> Luna finder reasoning effort (default: high)
  --routing-policy <policy>          Routing policy (default: deterministic-flex-v1)
  --flex-attempts <n>                Flex retry attempts per call (default: 3)
  --per-call-timeout <seconds>       Per-model-call timeout (default: 300)
`
}

/**
 * Prepare the deterministic review range host-side before ODW is invoked.
 *
 * Runs `prepare` from the review-state helper in-process with the same trusted
 * repository, refs, and state-root the workflow prompt used to pass. On failure
 * the structured `stage: 'prepare'` envelope is written to stderr. When nothing
 * remains unreviewed, a skip result is returned for the caller to emit on stdout
 * without launching ODW. Otherwise the full prepared review is returned for the
 * caller to thread through as `workflowArgs.prepared`.
 *
 * @param {object} options - parsed CLI options supplying refs and the state root.
 * @param {string} repoRoot - absolute path to the repository root.
 * @param {string} resolvedConfig - the host-resolved CodeRabbit YAML path.
 * @returns {{ prepared?: object, skip?: object, status?: number }} preparation outcome.
 */
function prepareReview(options, repoRoot, resolvedConfig) {
  const prepareArgs = {
    'repo-root': repoRoot,
    base: options.base || 'origin/main',
    head: options.head || 'HEAD',
  }
  if (options.stateRoot) {
    prepareArgs['state-root'] = options.stateRoot
  }
  let prepared
  try {
    prepared = prepare(prepareArgs)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: 'prepare', error: error.message }, jsonReplacer, 2)}\n`)
    return { status: 1 }
  }
  if (prepared.alreadyReviewed || prepared.commitCount === 0) {
    return {
      skip: {
        ok: true,
        skipped: true,
        reason: 'No unreviewed commits remain for this branch.',
        config: resolvedConfig,
        stateFile: prepared.stateFile,
        headCommit: prepared.headCommit,
      },
    }
  }
  return { prepared }
}

/**
 * Builds the zero-spend result returned for a blocking deterministic gate.
 *
 * The canonical SARIF document owns gate evidence and every compatibility
 * projection. No record input is produced because the reviewed head remains
 * eligible after remediation.
 *
 * @param {object[]} gates - host-executed deterministic gate outcomes.
 * @param {string} config - resolved review configuration path.
 * @param {object} prepared - trusted prepared review range.
 * @returns {object} structured failure with an empty model ledger.
 */
function blockingGateResult(gates, config, prepared) {
  const blocking = gates.filter((gate) => gate.blocking && gate.status !== 'passed')
  const sarif = assembleSarif({ gates, pricingTableVersion: DEFAULT_PRICING_TABLE.version })
  return {
    ok: false,
    stage: 'deterministic-gates',
    error: `${blocking.length} blocking deterministic gate${blocking.length === 1 ? '' : 's'} failed`,
    config,
    reviewBase: prepared.reviewBase,
    headCommit: prepared.headCommit,
    commitCount: prepared.commitCount,
    changedFiles: prepared.changedFiles,
    sarif,
    findings: projectFindingsFromSarif(sarif),
    discarded: projectDiscardedFromSarif(sarif),
    reportMarkdown: renderSarifMarkdown(sarif),
    metrics: {
      routingPolicy: 'deterministic-flex-v1',
      ledger: [],
      ledgerTotalEstimatedUsd: 0,
      spentUsd: 0,
      reservedAuditUsd: 0,
      pricingTableVersion: DEFAULT_PRICING_TABLE.version,
      deterministicGateCount: gates.length,
      blockingGateFailureCount: blocking.length,
    },
  }
}

/**
 * Read executable gate policy from the trusted review base when repository-local.
 *
 * A pull request may edit its own working-tree configuration, so executing that
 * text would grant the reviewed head command execution. Repository-local gate
 * policy is therefore loaded from `prepared.reviewBase`. A failed trusted-base
 * lookup aborts the review so repository gates cannot disappear silently.
 * User-level and bundled configurations live outside the reviewed repository
 * and are read from their resolved paths.
 *
 * @param {string} configPath - resolved review configuration path.
 * @param {string} repoRoot - absolute reviewed repository root.
 * @param {string} reviewBase - trusted prepared base commit.
 * @returns {string} trusted configuration text for deterministic gate parsing.
 */
function readTrustedGateConfig(configPath, repoRoot, reviewBase) {
  const relativePath = nodePath.relative(repoRoot, configPath)
  if (isRepositoryRelativePath(relativePath)) {
    const revisionPath = relativePath.replaceAll('\\', '/')
    const revision = `${reviewBase}:${revisionPath}`
    const result = spawnSync('git', ['-C', repoRoot, 'show', revision], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error) throw new Error(`cannot read trusted review configuration ${revision}: ${result.error.message}`)
    if (result.status !== 0) {
      const detail = result.stderr.trim() || `git show exited with status ${result.status ?? 'unknown'}`
      throw new Error(`cannot read trusted review configuration ${revision}: ${detail}`)
    }
    return result.stdout
  }
  return readFileSync(configPath, 'utf8')
}

/**
 * Complete the host-side preflight required before a live ODW review.
 *
 * This preserves the CLI boundary: preparation and deterministic failures emit
 * their terminal result before ODW starts, while advisory authentication,
 * context-index, and timeout warnings remain on stderr.
 *
 * @param {object} options - Parsed CLI options.
 * @param {string} repoRoot - Absolute path to the reviewed repository root.
 * @param {object} workflowArgs - Mutable workflow arguments for the ODW run.
 * @param {string} format - Requested final output format.
 * @returns {number | undefined} terminal exit code, or undefined after successful preflight.
 */
function prepareLiveReview(options, repoRoot, workflowArgs, format) {
  const preparation = prepareReview(options, repoRoot, workflowArgs.config)
  if (preparation.status !== undefined) return preparation.status
  if (preparation.skip) {
    // Route the skip result through the shared printer so it honours --format;
    // a skip has no reportMarkdown, so markdown falls back to the JSON dump.
    printWorkflowOutput(preparation.skip, format)
    return 0
  }
  workflowArgs.prepared = preparation.prepared
  const gateConfig = readTrustedGateConfig(workflowArgs.config, repoRoot, workflowArgs.prepared.reviewBase)
  const trustedPolicy = parseReviewPolicy(gateConfig, {
    configPath: `${workflowArgs.config} (trusted review base ${workflowArgs.prepared.reviewBase})`,
  })
  workflowArgs.policy = trustedPolicy
  const deterministicGates = runDeterministicGates(trustedPolicy, repoRoot)
  workflowArgs.prepared.deterministicGates = deterministicGates
  if (deterministicGates.some((gate) => gate.blocking && gate.status !== 'passed')) {
    printWorkflowOutput(blockingGateResult(deterministicGates, workflowArgs.config, workflowArgs.prepared), format)
    return 1
  }
  // Every routing policy clamps to the live deterministic-flex-v1 lane
  // (config.ts), which dispatches through the pi Flex adapters that resolve the
  // API key from OPENAI_API_KEY. An unknown policy must not suppress this
  // warning, so the gate keys off the key alone. Warn rather than fail so a
  // mocked ODW binary still runs.
  if (!process.env.OPENAI_API_KEY) {
    process.stderr.write('dakar-review: OPENAI_API_KEY is not set; the pi Flex adapters will fail to authenticate.\n')
  }
  warmReviewedContextIndex(repoRoot, workflowArgs.prepared, CONTEXT_WARMUP_BOUNDARY)
  // Advisory guard: an outer wait shorter than the retry schedule's worst
  // case can kill a healthy run before the workflow's own deferral logic
  // fires. The knob bounds mirror resolveWorkflowConfig's defaults.
  const worstCase = worstCaseReviewSeconds(
    {
      flexAttempts: clampLikeConfig(options.flexAttempts, 3, 1, 6),
      flexInitialBackoffSeconds: clampLikeConfig(options.flexInitialBackoffSeconds, 30, 1, 300),
      flexMaxBackoffSeconds: clampLikeConfig(options.flexMaxBackoffSeconds, 120, 1, 900),
      flexJitterSeconds: clampLikeConfig(options.flexJitterSeconds, 10, 0, 60),
    },
    clampPerCallTimeout(options.perCallTimeoutSeconds),
  )
  if ((options.timeout || 3600) < worstCase) {
    process.stderr.write(
      `dakar-review: --timeout ${options.timeout || 3600}s is below the retry schedule's worst case (${worstCase}s); the run may be killed before the workflow can defer.\n`,
    )
  }
  return
}

/**
 * Print a terminal meta-option response when the CLI should not start a review.
 *
 * @param {object} options - Parsed CLI options.
 * @returns {number | undefined} terminal exit code, or undefined when review work continues.
 */
function metaOptionExitCode(options) {
  if (options.help) {
    process.stdout.write(usage())
    return 0
  }
  if (options.version) {
    process.stdout.write('0.1.0\n')
    return 0
  }
  return
}

/**
 * Resolve and validate the requested final output format.
 *
 * @param {object} options - Parsed CLI options.
 * @returns {string} the supported JSON or Markdown output format.
 * @throws {Error} When the requested format is unsupported.
 */
function outputFormat(options) {
  const format = options.format || 'json'
  if (!['json', 'markdown'].includes(format)) throw new Error('--format must be json or markdown')
  return format
}

/**
 * Launch ODW after preflight and emit its final workflow result.
 *
 * @param {object} options - Parsed CLI options, mutated only with the run-local config path.
 * @param {object} workflowArgs - Prepared workflow arguments for the ODW run.
 * @param {string} format - Requested final output format.
 * @returns {Promise<number>} process exit code for the completed ODW result.
 */
async function launchOdw(options, workflowArgs, format) {
  // Derive a run-local ODW config that bounds the pi Flex calls with the per-call
  // timeout, then remove it after the run like the usage-log file.
  options.odwConfigPath = writeDerivedOdwConfig(clampPerCallTimeout(options.perCallTimeoutSeconds))
  let outcome
  try {
    outcome = options.telemetry
      ? await runOdwWithTelemetry(options, workflowArgs)
      : runOdwQuiet(options, workflowArgs)
  } finally {
    try {
      rmSync(options.odwConfigPath, { force: true })
    } catch {
      // A leftover temp file is harmless.
    }
  }
  if (outcome.status !== undefined) return outcome.status
  // Reported usage is attached and folded into recordInput before recording by
  // finalizeWorkflowResult; nothing further to enrich here.
  const output = outcome.output
  printWorkflowOutput(output, format)
  return output.ok === false ? 1 : 0
}
/**
 * Entry point: parse arguments, invoke ODW, print results, and return an exit code.
 *
 * @param {string[]} argv - raw argument tokens (typically `process.argv.slice(2)`).
 * @returns {Promise<number>} process exit code; 0 on success, 1 on failure.
 */
async function run(argv) {
  const options = parseArgs(argv)
  const metaExitCode = metaOptionExitCode(options)
  if (metaExitCode !== undefined) return metaExitCode

  const repoRoot = nodePath.resolve(options.repoRoot || process.cwd())
  const format = outputFormat(options)

  const workflowArgs = buildWorkflowArgs(options, repoRoot)
  if (!options.dryRun) {
    const preflightStatus = prepareLiveReview(options, repoRoot, workflowArgs, format)
    if (preflightStatus !== undefined) return preflightStatus
  }
  return launchOdw(options, workflowArgs, format)
}

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, stage: 'cli', error: error.message }, jsonReplacer, 2)}\n`)
  process.exitCode = 1
}
