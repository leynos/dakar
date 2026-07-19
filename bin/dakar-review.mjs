#!/usr/bin/env node
/**
 * @file Run Dakar's ODW review workflow from an installable CLI.
 *
 * The command preserves a parseable stdout result for automation while handling
 * repository-local configuration, AGENTS.md context, live ODW telemetry, and
 * deterministic review-history recording around the workflow runtime.
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { deriveOdwConfig } from '../scripts/odw-config.mjs'
import { resolveReviewConfig } from '../scripts/review-config.mjs'
import { appendReview, prepare } from '../scripts/review-state.mjs'

/** ODW's documented default per-model-call timeout in seconds. */
const DEFAULT_PER_CALL_TIMEOUT_SECONDS = 300

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
 * @param {number} [value] - the parsed `--per-call-timeout` value, if any.
 * @returns {number} the value clamped to [30, 900], defaulting to 300.
 */
function clampPerCallTimeout(value = DEFAULT_PER_CALL_TIMEOUT_SECONDS) {
  if (!Number.isFinite(value)) return DEFAULT_PER_CALL_TIMEOUT_SECONDS
  return Math.min(900, Math.max(30, Math.trunc(value)))
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = join(packageRoot, 'workflows', 'dakar-review.js')
const odwConfigPath = join(packageRoot, 'odw.config.json')
const piAgentDir = join(packageRoot, 'adapters', 'pi')

/**
 * Write a per-run ODW config that stamps the per-call timeout on the pi Flex
 * adapters, returning the temp file path for the CLI's own ODW spawns.
 *
 * The packaged config leaves each adapter call unbounded, so a run-local copy
 * carries the `--per-call-timeout` value (or the documented default) on the three
 * pi Flex adapters only. The file lives under the OS temp directory and is
 * removed after the run, exactly like the usage-log file.
 *
 * @param {number} [perCallTimeoutSeconds] - per-model-call timeout in seconds.
 * @returns {string} absolute path to the derived config temp file.
 */
function writeDerivedOdwConfig(perCallTimeoutSeconds = DEFAULT_PER_CALL_TIMEOUT_SECONDS) {
  const baseConfig = JSON.parse(readFileSync(odwConfigPath, 'utf8'))
  const derived = deriveOdwConfig(baseConfig, perCallTimeoutSeconds)
  const path = join(tmpdir(), `dakar-odw-config-${process.pid}-${Date.now()}.json`)
  writeFileSync(path, JSON.stringify(derived, null, 2))
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
  const env = { ...process.env, PI_CODING_AGENT_DIR: piAgentDir, PI_SKIP_VERSION_CHECK: '1' }
  if (usageLogPath) env.DAKAR_USAGE_LOG = usageLogPath
  return env
}

const usageLogFile = join(tmpdir(), `dakar-usage-${process.pid}-${Date.now()}.jsonl`)

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
 * @returns {object} the same output, annotated when usage lines exist.
 */
function attachReportedUsage(output) {
  let raw
  try {
    raw = readFileSync(usageLogFile, 'utf8')
  } catch {
    return output
  }
  try {
    rmSync(usageLogFile, { force: true })
  } catch {
    // A leftover temp file is harmless.
  }
  const lines = raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  if (lines.length === 0 || typeof output !== 'object' || output === null) return output
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const line of lines) {
    for (const key of Object.keys(totals)) {
      totals[key] += Number(line.usage?.[key]) || 0
    }
  }
  output.metrics = output.metrics || {}
  output.metrics.reportedUsage = lines
  output.metrics.reportedTokens = totals
  return output
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
 * Parse the CLI argument vector into a plain options object.
 *
 * @param {string[]} argv - argument tokens, excluding the node/script prefix.
 * @returns {object} key-value map of resolved option values.
 */
function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${token}`)
    }
    const [name, inlineValue] = token.slice(2).split(/=(.*)/su, 2)
    const spec = OPTION_SPECS.get(name)
    if (!spec) {
      throw new Error(`unknown option: --${name}`)
    }
    if (!spec.value) {
      if (inlineValue !== undefined) {
        throw new Error(`--${name} does not take a value`)
      }
      parsed[spec.key] = true
      continue
    }
    const value = inlineValue ?? argv[++index]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`)
    }
    parsed[spec.key] = spec.number ? numberValue(name, value) : value
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
    throw new Error(`--${name} must be a number`)
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
 * Read `AGENTS.md` from the trusted review base, returning null when absent.
 *
 * Content is truncated to 24,000 characters so large files do not overflow
 * the workflow argument budget.
 *
 * @param {string} repoRoot - absolute path to the repository root.
 * @param {string} baseRef - trusted Git revision preceding the reviewed range.
 * @returns {{ source: string, content: string, truncated: boolean } | null} parsed instructions, or null.
 */
function readAgentInstructions(repoRoot, baseRef) {
  const revision = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (revision.error) throw revision.error
  if (revision.status !== 0) {
    throw new Error(`cannot resolve trusted review base ${baseRef}: ${revision.stderr.trim() || 'git rev-parse failed'}`)
  }
  const resolvedCommit = revision.stdout.trim()
  const exists = spawnSync('git', ['-C', repoRoot, 'ls-tree', '-z', resolvedCommit, '--', 'AGENTS.md'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (exists.error) throw exists.error
  if (exists.status !== 0) {
    throw new Error(`cannot inspect ${resolvedCommit}:AGENTS.md: ${exists.stderr.trim() || 'git ls-tree failed'}`)
  }
  if (exists.stdout === '') return null
  const result = spawnSync('git', ['-C', repoRoot, 'show', `${resolvedCommit}:AGENTS.md`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`cannot read ${resolvedCommit}:AGENTS.md: ${result.stderr.trim() || 'git show failed'}`)
  }
  const content = result.stdout
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
    repoRoot,
  }
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
    odwArgs.splice(2, 0, '--runs-root', resolve(options.runsRoot))
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
    args.push('--runs-root', resolve(options.runsRoot))
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
    process.stdout.write(`${output.reportMarkdown || JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
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
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
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
 * @returns {string | null} a message naming the mismatched field, or null when consistent.
 */
function snapshotMismatch(recordInput, prepared) {
  if (!prepared || typeof prepared !== 'object') return null
  const scalarChecks = [
    ['headCommit', recordInput.headCommit, prepared.headCommit],
    ['baseCommit', recordInput.baseCommit, prepared.reviewBase],
    ['commitCount', recordInput.commitCount, prepared.commitCount],
  ]
  for (const [field, actual, expected] of scalarChecks) {
    if (actual !== expected) {
      return `recordInput.${field} (${JSON.stringify(actual)}) does not match the prepared review snapshot (${JSON.stringify(expected)}); refusing to record`
    }
  }
  if (!changedFilesEqual(recordInput.changedFiles, prepared.changedFiles)) {
    return 'recordInput.changedFiles does not match the prepared review snapshot; refusing to record'
  }
  return null
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
  if (!output || output.dryRun || output.skipped || output.ok !== true) {
    return output
  }
  // Fail closed: an ok result with no recordInput must never be treated as a
  // complete review, so refuse rather than silently return it unrecorded.
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
  attachReportedUsage(output)
  // A dry run never records: there is no prepared snapshot to validate against
  // and no completed head to append.
  if (workflowArgs.dryRun) return output
  if (output && typeof output === 'object' && output.recordInput) {
    const metrics = (output.recordInput.metrics = output.recordInput.metrics || {})
    if (output.metrics?.reportedUsage !== undefined) metrics.reportedUsage = output.metrics.reportedUsage
    if (output.metrics?.reportedTokens !== undefined) metrics.reportedTokens = output.metrics.reportedTokens
  }
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
    process.stderr.write(`${JSON.stringify(error, null, 2)}\n`)
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
 * Poll `odw result` until the run completes or the deadline is reached.
 *
 * @param {object} options - parsed CLI options.
 * @param {string} runId - ODW run identifier to query.
 * @param {number} [timeoutMs] - polling deadline in milliseconds (default: `timeout` option × 1000).
 * @returns {Promise<object>} the parsed and (on success) recorded workflow result.
 */
async function waitForOdwResult(options, workflowArgs, runId, timeoutMs = (options.timeout || 3600) * 1000) {
  const odwBin = options.odwBin || 'odw'
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (true) {
    const result = spawnSync(odwBin, buildRunScopedArgs('result', options, runId), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: odwEnv(),
    })
    if (result.status === 0) {
      return finalizeWorkflowResult(extractJson(result.stdout), workflowArgs)
    }
    lastError = result.stderr.trim() || result.stdout.trim()
    if (Date.now() >= deadline) {
      break
    }
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())))
  }

  throw new Error(lastError || `timed out waiting for ODW run ${runId} after ${options.timeout || 3600}s`)
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
    const error = {
      ok: false,
      stage: 'odw',
      status: result.status,
      error: result.stderr.trim() || result.stdout.trim() || 'ODW failed',
    }
    process.stderr.write(`${JSON.stringify(error, null, 2)}\n`)
    return { status: result.status || 1 }
  }

  if (result.stderr.trim()) {
    process.stderr.write(`${result.stderr.trim()}\n`)
  }
  const runId = extractRunId(result.stdout)
  const timeoutMs = (options.timeout || 3600) * 1000
  const resultDeadline = Date.now() + timeoutMs
  process.stderr.write(`dakar-review: following ODW run ${runId}\n`)
  const logStatus = await followOdwLogs(odwBin, buildRunScopedArgs('logs', options, runId, ['--follow']), timeoutMs)
  if (logStatus === 124) {
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          stage: 'odw-logs',
          runId,
          error: `timed out following ODW run after ${options.timeout || 3600}s`,
        },
        null,
        2,
      )}\n`,
    )
    return { status: 1 }
  }
  if (logStatus !== 0) {
    process.stderr.write(`dakar-review: ODW log stream exited with status ${logStatus}; fetching result anyway\n`)
  }

  try {
    return { output: await waitForOdwResult(options, workflowArgs, runId, Math.max(0, resultDeadline - Date.now())) }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, stage: 'odw-result', runId, error: error.message }, null, 2)}\n`,
    )
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
  --budget-gbp <n>                   Hard admission budget in GBP (default: 0.1)
  --max-luna-calls <n>               Maximum Luna Flex finder calls (default: 4)
  --transaction-max-files <n>        Maximum files per finder pack (default: 5)
  --transaction-max-input-tokens <n> Finder input-token estimate (default: 12000)
  --transaction-max-output-tokens <n> Finder output-token estimate (default: 750)
  --terra-max-input-tokens <n>       Audit input-token estimate (default: 48000)
  --terra-max-output-tokens <n>      Audit output-token estimate (default: 2500)
  --adapter-overhead-tokens <n>      Per-call adapter overhead tokens (default: 13000)
  --max-audit-candidates <n>         Maximum candidates sent to the audit (default: 30)
  --luna-reasoning <low|medium>      Luna finder reasoning effort (default: low)
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
    process.stderr.write(`${JSON.stringify({ ok: false, stage: 'prepare', error: error.message }, null, 2)}\n`)
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
 * Entry point: parse arguments, invoke ODW, print results, and return an exit code.
 *
 * @param {string[]} argv - raw argument tokens (typically `process.argv.slice(2)`).
 * @returns {Promise<number>} process exit code; 0 on success, 1 on failure.
 */
async function run(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(usage())
    return 0
  }
  if (options.version) {
    process.stdout.write('0.1.0\n')
    return 0
  }

  const repoRoot = resolve(options.repoRoot || process.cwd())
  const format = options.format || 'json'
  if (!['json', 'markdown'].includes(format)) {
    throw new Error('--format must be json or markdown')
  }

  const workflowArgs = buildWorkflowArgs(options, repoRoot)
  if (!options.dryRun) {
    const preparation = prepareReview(options, repoRoot, workflowArgs.config)
    if (preparation.status !== undefined) {
      return preparation.status
    }
    if (preparation.skip) {
      // Route the skip result through the shared printer so it honours --format;
      // a skip has no reportMarkdown, so markdown falls back to the JSON dump.
      printWorkflowOutput(preparation.skip, format)
      return 0
    }
    workflowArgs.prepared = preparation.prepared
    // Every routing policy clamps to the live deterministic-flex-v1 lane
    // (config.ts), which dispatches through the pi Flex adapters that resolve the
    // API key from OPENAI_API_KEY. An unknown policy must not suppress this
    // warning, so the gate keys off the key alone. Warn rather than fail so a
    // mocked ODW binary still runs.
    if (!process.env.OPENAI_API_KEY) {
      process.stderr.write('dakar-review: OPENAI_API_KEY is not set; the pi Flex adapters will fail to authenticate.\n')
    }
  }
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
  if (outcome.status !== undefined) {
    return outcome.status
  }
  // Reported usage is attached and folded into recordInput before recording by
  // finalizeWorkflowResult; nothing further to enrich here.
  const output = outcome.output
  printWorkflowOutput(output, format)
  return output.ok === false ? 1 : 0
}

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, stage: 'cli', error: error.message }, null, 2)}\n`)
  process.exitCode = 1
}
