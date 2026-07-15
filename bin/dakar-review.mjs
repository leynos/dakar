#!/usr/bin/env node
/**
 * @file Run Dakar's ODW review workflow from an installable CLI.
 *
 * The command preserves a parseable stdout result for automation while handling
 * repository-local configuration, AGENTS.md context, live ODW telemetry, and
 * deterministic review-history recovery around the workflow runtime.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { resolveReviewConfig } from '../scripts/review-config.mjs'
import { appendReview } from '../scripts/review-state.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = join(packageRoot, 'workflows', 'dakar-review.js')
const odwConfigPath = join(packageRoot, 'odw.config.json')

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
 * Read `AGENTS.md` from the repository root, returning null when absent.
 *
 * Content is truncated to 24,000 characters so large files do not overflow
 * the workflow argument budget.
 *
 * @param {string} repoRoot - absolute path to the repository root.
 * @returns {{ source: string, content: string, truncated: boolean } | null} parsed instructions, or null.
 */
function readAgentInstructions(repoRoot) {
  const agentsPath = join(repoRoot, 'AGENTS.md')
  if (!existsSync(agentsPath)) {
    return null
  }
  const content = readFileSync(agentsPath, 'utf8')
  return {
    source: agentsPath,
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
  const agentInstructions = readAgentInstructions(repoRoot)
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
    odwConfigPath,
  ]
  if (wait) {
    odwArgs.push('--wait', '--timeout', String(options.timeout || 900))
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
 * Extract a single-line summary sentence from a workflow output object.
 *
 * Returns the first non-heading, non-empty line from `reportMarkdown`, or a
 * generic fallback when none is present.
 *
 * @param {object} output - the ODW workflow result object.
 * @returns {string} a one-line summary suitable for embedding in a TOML field.
 */
function summarizeReport(output) {
  const markdown = String(output.reportMarkdown || '').trim()
  if (!markdown) {
    return 'Dakar review completed.'
  }
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#')) || 'Dakar review completed.'
}

/**
 * Build the record input passed to `appendReview` during CLI recovery.
 *
 * Prefers the workflow-supplied `recordInput` when present and otherwise
 * reconstructs one from the workflow output. Either way, the returned metrics
 * are stamped with `recordRecoveredByCli: true` so the repaired reviews.toml
 * entry is auditable as a CLI recovery.
 *
 * @param {object} output - the ODW workflow result.
 * @returns {object} record input for `appendReview`.
 */
function recordInputFromOutput(output) {
  const base = output.recordInput || {
    stateFile: output.stateFile,
    reviewId: `${String(output.headCommit || 'unknown').slice(0, 12)}-${Date.now()}-cli`,
    baseCommit: output.reviewBase,
    headCommit: output.headCommit,
    commitCount: output.commitCount || 0,
    changedFiles: output.changedFiles || [],
    models: (output.metrics?.modelAssignments || []).map((assignment) => assignment.model).filter(Boolean),
    findingsTotal: Array.isArray(output.findings) ? output.findings.length : 0,
    summary: output.summary || summarizeReport(output),
    metrics: output.metrics || {},
  }
  // Always stamp the recovery marker onto the metrics that appendReview()
  // persists, whether the record input came from the workflow (output.recordInput)
  // or was reconstructed here. Merging preserves the workflow's existing metrics
  // fields while ensuring the repaired reviews.toml entry is marked recovered.
  return {
    ...base,
    metrics: {
      ...(base.metrics || {}),
      recordRecoveredByCli: true,
    },
  }
}

/**
 * Attempt one deterministic local recovery of a failed record phase.
 *
 * When ODW completed the review but its record phase failed, re-run the
 * review-history append directly through Dakar's state helper. On success the
 * result is marked `recorded.recoveredBy`; on failure it retains `stage:
 * "record"` so the caller still exits non-zero. Non-record failures and dry/
 * skipped runs are returned untouched.
 *
 * @param {object} output - the ODW workflow result to repair in place.
 * @returns {object} the (possibly repaired) workflow result.
 */
function recoverRecordFailure(output) {
  if (
    !output ||
    output.dryRun ||
    output.skipped ||
    output.recorded?.ok === true ||
    (output.stage !== 'record' && output.recorded?.ok !== false) ||
    !output.stateFile ||
    !output.headCommit ||
    (output.stage && output.stage !== 'record')
  ) {
    return output
  }
  try {
    const recorded = appendReview(recordInputFromOutput(output))
    output.recorded = { ...recorded, recoveredBy: 'dakar-review' }
    output.metrics = {
      ...(output.metrics || {}),
      recordRecoveredByCli: true,
    }
    output.ok = true
    delete output.stage
    delete output.error
  } catch (error) {
    output.ok = false
    output.stage = 'record'
    output.error = error.message
    output.recorded = {
      ...(output.recorded || {}),
      ok: false,
      error: error.message,
      recoveryAttemptedBy: 'dakar-review',
    }
  }
  return output
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

  return { output: recoverRecordFailure(extractJson(result.stdout)) }
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
    const child = spawn(odwBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
 * @returns {Promise<object>} the parsed and (if needed) record-recovered workflow result.
 */
async function waitForOdwResult(options, runId, timeoutMs = (options.timeout || 900) * 1000) {
  const odwBin = options.odwBin || 'odw'
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (true) {
    const result = spawnSync(odwBin, buildRunScopedArgs('result', options, runId), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.status === 0) {
      return recoverRecordFailure(extractJson(result.stdout))
    }
    lastError = result.stderr.trim() || result.stdout.trim()
    if (Date.now() >= deadline) {
      break
    }
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())))
  }

  throw new Error(lastError || `timed out waiting for ODW run ${runId} after ${options.timeout || 900}s`)
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
  const timeoutMs = (options.timeout || 900) * 1000
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
          error: `timed out following ODW run after ${options.timeout || 900}s`,
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
    return { output: await waitForOdwResult(options, runId, Math.max(0, resultDeadline - Date.now())) }
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
  --timeout <seconds>         ODW wait timeout (default: 900)
  --runs-root <path>          ODW runs directory
  --format <json|markdown>    Output format (default: json)
  --odw-bin <path>            ODW executable (default: odw)
  --telemetry                 Stream ODW logs to stderr while preserving final stdout
  --dry-run                   Return workflow contract without agents
  --help                      Show this help
`
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
  const outcome = options.telemetry
    ? await runOdwWithTelemetry(options, workflowArgs)
    : runOdwQuiet(options, workflowArgs)
  if (outcome.status !== undefined) {
    return outcome.status
  }
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
