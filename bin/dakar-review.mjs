#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { resolveReviewConfig } from '../scripts/review-config.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = join(packageRoot, 'workflows', 'coderabbit-code-review.js')
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

function numberValue(name, value) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new Error(`--${name} must be a number`)
  }
  return number
}

function extractJson(text) {
  const start = text.indexOf('{')
  if (start === -1) {
    throw new Error('ODW output did not contain a JSON object')
  }
  return JSON.parse(text.slice(start))
}

function extractRunId(text) {
  const match = text.match(/\b\d{8}-\d{6}-[0-9a-f]+\b/u)
  if (!match) {
    throw new Error('ODW output did not contain a run id')
  }
  return match[0]
}

function buildWorkflowArgs(options, repoRoot) {
  const workflowArgs = {
    config: resolveReviewConfig({ repoRoot, config: options.config, packageRoot }).config,
    repoRoot,
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

function buildRunScopedArgs(command, options, runId, extraArgs = []) {
  const args = [command, runId]
  if (options.runsRoot) {
    args.push('--runs-root', resolve(options.runsRoot))
  }
  args.push(...extraArgs)
  return args
}

function printWorkflowOutput(output, format) {
  if (format === 'markdown') {
    process.stdout.write(`${output.reportMarkdown || JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  }
}

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

  return { output: extractJson(result.stdout) }
}

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
      return extractJson(result.stdout)
    }
    lastError = result.stderr.trim() || result.stdout.trim()
    if (Date.now() >= deadline) {
      break
    }
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())))
  }

  throw new Error(lastError || `timed out waiting for ODW run ${runId} after ${options.timeout || 900}s`)
}

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

function usage() {
  return `Usage: dakar-review [options]

Run Dakar's routed CodeRabbit review workflow and print the workflow result.

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
