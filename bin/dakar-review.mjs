#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function resolveConfig(repoRoot, config) {
  if (config) {
    return isAbsolute(config) ? config : resolve(repoRoot, config)
  }
  for (const candidate of ['.coderabbit.yaml', '.coderabbit.yml', 'coderabbit.yaml', 'coderabbit.yml']) {
    const path = join(repoRoot, candidate)
    if (existsSync(path)) {
      return path
    }
  }
  return join(packageRoot, 'examples', 'df12-code-review.yaml')
}

function extractJson(text) {
  const start = text.indexOf('{')
  if (start === -1) {
    throw new Error('ODW output did not contain a JSON object')
  }
  return JSON.parse(text.slice(start))
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
  --dry-run                   Return workflow contract without agents
  --help                      Show this help
`
}

function run(argv) {
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

  const workflowArgs = {
    config: resolveConfig(repoRoot, options.config),
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

  const odwArgs = [
    'run',
    workflowPath,
    '--source',
    packageRoot,
    '--config',
    odwConfigPath,
    '--wait',
    '--timeout',
    String(options.timeout || 900),
    '--args',
    JSON.stringify(workflowArgs),
  ]
  if (options.runsRoot) {
    odwArgs.splice(2, 0, '--runs-root', resolve(options.runsRoot))
  }

  const result = spawnSync(options.odwBin || 'odw', odwArgs, {
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
    return result.status || 1
  }

  const output = extractJson(result.stdout)
  if (format === 'markdown') {
    process.stdout.write(`${output.reportMarkdown || JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  }
  return output.ok === false ? 1 : 0
}

try {
  process.exitCode = run(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, stage: 'cli', error: error.message }, null, 2)}\n`)
  process.exitCode = 1
}
