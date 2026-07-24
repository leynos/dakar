#!/usr/bin/env node
/**
 * @file Resolve Dakar's CodeRabbit-compatible review configuration.
 *
 * The helper is shared by the installable CLI and the ODW workflow. It keeps
 * configuration precedence deterministic and reports the paths considered so a
 * review result can explain which policy file shaped the run.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

const DEFAULT_REPO_CONFIGS = ['.coderabbit.yaml', '.coderabbit.yml', 'coderabbit.yaml', 'coderabbit.yml']
const ROOT_KEYS = new Set(['language', 'pre_merge_checks', 'reviews', 'tone_instructions'])
const REVIEW_KEYS = new Set(['path_instructions', 'profile'])
const PRE_MERGE_KEYS = new Set(['custom_checks'])
const PATH_INSTRUCTION_KEYS = new Set(['instructions', 'path'])
const CUSTOM_CHECK_KEYS = new Set(['command', 'instructions', 'mode', 'name'])

/** Tests whether a parsed YAML value is a mapping rather than an array. */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Converts a human gate name into a stable identifier segment. */
function slug(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/gu, '') || 'check'
}

/** Builds an actionable configuration error naming both file and field. */
function policyError(configPath, field, detail) {
  return new Error(`${configPath}: invalid ${field}: ${detail}`)
}

/**
 * Describe malformed YAML without echoing source text into logs.
 *
 * js-yaml messages include the offending line, which may contain credentials.
 * Retain only one-based line and column coordinates when the parser supplies
 * them.
 */
function yamlErrorDetail(error) {
  const mark = isMapping(error) && isMapping(error.mark) ? error.mark : null
  return Number.isInteger(mark?.line) && Number.isInteger(mark?.column)
    ? `could not parse at line ${mark.line + 1}, column ${mark.column + 1}`
    : 'could not parse'
}

/** Requires a supported policy field to be a non-empty string. */
function requiredString(value, configPath, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw policyError(configPath, field, 'expected a non-empty string')
  }
  return value
}

/** Reads an optional supported policy string with field-aware diagnostics. */
function optionalString(mapping, key, configPath, field) {
  if (mapping[key] === undefined) return undefined
  return requiredString(mapping[key], configPath, field)
}

/** Adds unsupported mapping keys to the deterministic ignored-key report. */
function collectIgnoredKeys(mapping, supported, prefix, ignoredKeys) {
  for (const key of Object.keys(mapping)) {
    if (!supported.has(key)) ignoredKeys.push(prefix ? `${prefix}.${key}` : key)
  }
}

/**
 * Parse and normalize Dakar's supported CodeRabbit policy subset.
 *
 * The JSON YAML schema accepts ordinary mappings, sequences, and scalar values
 * without constructing custom tags or timestamp objects. Supported fields are
 * validated strictly; unsupported keys are retained only as auditable ignored
 * key paths and cannot influence routing or execution.
 *
 * @param {string} source - YAML source selected by configuration precedence.
 * @param {object} options - parse context.
 * @param {string} options.configPath - resolved path used in diagnostics.
 * @returns {object} normalized, serializable policy contract.
 * @throws {Error} malformed YAML or an invalid supported field.
 */
export function parseReviewPolicy(source, { configPath }) {
  let parsed
  try {
    parsed = loadYaml(source, { schema: JSON_SCHEMA })
  } catch (error) {
    throw policyError(configPath, 'YAML', yamlErrorDetail(error))
  }
  const root = parsed === undefined ? {} : parsed
  if (!isMapping(root)) throw policyError(configPath, 'document', 'expected a mapping')

  const ignoredKeys = []
  collectIgnoredKeys(root, ROOT_KEYS, '', ignoredKeys)
  const language = optionalString(root, 'language', configPath, 'language')
  const toneInstructions = optionalString(root, 'tone_instructions', configPath, 'tone_instructions')

  const reviews = root.reviews === undefined ? {} : root.reviews
  if (!isMapping(reviews)) throw policyError(configPath, 'reviews', 'expected a mapping')
  collectIgnoredKeys(reviews, REVIEW_KEYS, 'reviews', ignoredKeys)
  const profile = optionalString(reviews, 'profile', configPath, 'reviews.profile')
  const rawPathInstructions = reviews.path_instructions === undefined ? [] : reviews.path_instructions
  if (!Array.isArray(rawPathInstructions)) {
    throw policyError(configPath, 'reviews.path_instructions', 'expected a sequence')
  }
  const pathInstructions = rawPathInstructions.map((entry, index) => {
    const field = `reviews.path_instructions[${index}]`
    if (!isMapping(entry)) throw policyError(configPath, field, 'expected a mapping')
    collectIgnoredKeys(entry, PATH_INSTRUCTION_KEYS, field, ignoredKeys)
    return {
      policyRef: field,
      path: requiredString(entry.path, configPath, `${field}.path`),
      instructions: requiredString(entry.instructions, configPath, `${field}.instructions`),
    }
  })

  const preMergeChecks = root.pre_merge_checks === undefined ? {} : root.pre_merge_checks
  if (!isMapping(preMergeChecks)) throw policyError(configPath, 'pre_merge_checks', 'expected a mapping')
  collectIgnoredKeys(preMergeChecks, PRE_MERGE_KEYS, 'pre_merge_checks', ignoredKeys)
  const rawCustomChecks = preMergeChecks.custom_checks === undefined ? [] : preMergeChecks.custom_checks
  if (!Array.isArray(rawCustomChecks)) {
    throw policyError(configPath, 'pre_merge_checks.custom_checks', 'expected a sequence')
  }
  const customChecks = rawCustomChecks.map((entry, index) => {
    const field = `pre_merge_checks.custom_checks[${index}]`
    if (!isMapping(entry)) throw policyError(configPath, field, 'expected a mapping')
    collectIgnoredKeys(entry, CUSTOM_CHECK_KEYS, field, ignoredKeys)
    const name = optionalString(entry, 'name', configPath, `${field}.name`) || `Gate ${index + 1}`
    const mode = optionalString(entry, 'mode', configPath, `${field}.mode`) || 'error'
    if (mode !== 'error' && mode !== 'warning') {
      throw policyError(configPath, `${field}.mode`, 'expected "error" or "warning"')
    }
    const command = optionalString(entry, 'command', configPath, `${field}.command`)
    const instructions = optionalString(entry, 'instructions', configPath, `${field}.instructions`)
    if (command === undefined && instructions === undefined) {
      throw policyError(configPath, field, 'expected command or instructions')
    }
    return {
      gateId: `gate-${String(index + 1).padStart(3, '0')}-${slug(name)}`,
      name,
      blocking: mode === 'error',
      ...(command === undefined ? {} : { command }),
      ...(instructions === undefined ? {} : { instructions }),
    }
  })

  return {
    version: 1,
    ...(language === undefined ? {} : { language }),
    ...(toneInstructions === undefined ? {} : { toneInstructions }),
    ...(profile === undefined ? {} : { profile }),
    pathInstructions,
    customChecks,
    ignoredKeys: [...new Set(ignoredKeys)].sort(),
  }
}

/**
 * Read and normalize one resolved CodeRabbit-compatible policy file.
 *
 * @param {string} configPath - resolved YAML path.
 * @returns {object} normalized, serializable policy contract.
 * @throws {Error} file I/O, malformed YAML, or invalid supported fields.
 */
export function loadReviewPolicy(configPath) {
  return parseReviewPolicy(readFileSync(configPath, 'utf8'), { configPath })
}

/** Attaches parsed policy to a successful path-resolution result. */
function withPolicy(result) {
  try {
    return { ...result, policy: loadReviewPolicy(result.config) }
  } catch (error) {
    return { ...result, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve the CodeRabbit-compatible review config path, trying sources in priority order.
 *
 * Searches, in order: explicit `--config` argument, well-known repository filenames,
 * the user's XDG config directory, then the bundled example. Returns a result
 * object that records every path checked so the workflow output is auditable.
 *
 * @param {object} [opts] - options bag.
 * @param {string} [opts.repoRoot] - repository root to search (default: `process.cwd()`).
 * @param {string} [opts.config] - explicit config path supplied by the caller.
 * @param {string} [opts.packageRoot] - Dakar package root for the bundled example fallback.
 * @param {object} [opts.env] - environment variable map (default: `process.env`).
 * @returns {{ ok: boolean, config: string, source: string, checked: string[], policy?: object, error?: string }}
 * resolution result with normalized policy on success.
 */
export function resolveReviewConfig({
  repoRoot = process.cwd(),
  config,
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  env = process.env,
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot)
  const checked = []

  if (config) {
    const explicit = isAbsolute(config) ? config : resolve(resolvedRepoRoot, config)
    checked.push(explicit)
    if (existsSync(explicit)) {
      return withPolicy({ ok: true, config: explicit, source: 'explicit', checked })
    }
    return {
      ok: false,
      config: explicit,
      source: 'explicit',
      checked,
      error: `explicit config does not exist: ${explicit}`,
    }
  }

  for (const candidate of DEFAULT_REPO_CONFIGS) {
    const path = join(resolvedRepoRoot, candidate)
    checked.push(path)
    if (existsSync(path)) {
      return withPolicy({ ok: true, config: path, source: 'repository', checked })
    }
  }

  const userConfig = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'dakar', 'config.yaml')
  checked.push(userConfig)
  if (existsSync(userConfig)) {
    return withPolicy({ ok: true, config: userConfig, source: 'user', checked })
  }

  const bundledExample = join(resolve(packageRoot), 'examples', 'df12-code-review.yaml')
  checked.push(bundledExample)
  if (existsSync(bundledExample)) {
    return withPolicy({ ok: true, config: bundledExample, source: 'example', checked })
  }
  return {
    ok: false,
    config: bundledExample,
    source: 'example',
    checked,
    error: `bundled example config does not exist: ${bundledExample}`,
  }
}

/**
 * Parse key-value `--flag value` pairs from an argument vector.
 *
 * Kebab-case flag names are converted to camelCase keys in the returned object.
 *
 * @param {string[]} argv - argument tokens to parse.
 * @returns {object} map of camelCase option names to their string values.
 */
function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${token}`)
    }
    const key = token.slice(2)
    const value = argv[++index]
    if (!value || value.startsWith('--')) {
      throw new Error(`--${key} requires a value`)
    }
    parsed[key.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value
  }
  return parsed
}

/**
 * CLI entry point: run the `resolve` sub-command and print the JSON result.
 *
 * @param {string[]} argv - argument tokens starting with the sub-command name.
 */
function run(argv) {
  const [command, ...rest] = argv
  if (command !== 'resolve') {
    throw new Error('usage: review-config.mjs resolve --repo-root <path> [--config <path>] [--package-root <path>]')
  }
  const options = parseArgs(rest)
  const result = resolveReviewConfig(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`)
    process.exitCode = 1
  }
}
