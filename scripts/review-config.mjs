#!/usr/bin/env node
/**
 * Resolve Dakar's CodeRabbit-compatible review configuration.
 *
 * The helper is shared by the installable CLI and the ODW workflow. It keeps
 * configuration precedence deterministic and reports the paths considered so a
 * review result can explain which policy file shaped the run.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'
import * as z from 'zod'

const DEFAULT_REPO_CONFIGS = ['.coderabbit.yaml', '.coderabbit.yml', 'coderabbit.yaml', 'coderabbit.yml']
const ROOT_KEYS = new Set(['language', 'pre_merge_checks', 'reviews', 'tone_instructions'])
const REVIEW_KEYS = new Set(['path_instructions', 'profile'])
const PRE_MERGE_KEYS = new Set(['custom_checks'])
const PATH_INSTRUCTION_KEYS = new Set(['instructions', 'path'])
const CUSTOM_CHECK_KEYS = new Set(['command', 'instructions', 'mode', 'name'])
const mappingSchema = z.record(z.string(), z.json())
const yamlErrorSchema = z.looseObject({
  mark: z.looseObject({ line: z.number(), column: z.number() }).optional(),
})
/**
 * Serialise a value as two-space-indented JSON.
 *
 * @param {unknown} value - value to serialise.
 * @returns {string} the indented JSON text.
 */
const jsonIndent = (value) => JSON.stringify(value, (_key, nested) => nested, 2)

/** Tests whether a parsed YAML value is a mapping rather than an array. */
function parseMapping(value) {
  return mappingSchema.safeParse(value)
}

/** Converts a human gate name into a stable identifier segment. */
function slug(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replaceAll(/[^\p{L}\p{N}]+/gu, '-')
    .replaceAll(/^-|-$/gu, '') || 'check'
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
  const parsed = yamlErrorSchema.safeParse(error)
  const mark = parsed.success ? parsed.data.mark : undefined
  return mark !== undefined && Number.isInteger(mark.line) && Number.isInteger(mark.column)
    ? `could not parse at line ${mark.line + 1}, column ${mark.column + 1}`
    : 'could not parse'
}

/** Requires a supported policy field to be a non-empty string. */
function requiredString(value, configPath, field) {
  const parsed = z.string().safeParse(value)
  if (!parsed.success || parsed.data.trim() === '') {
    throw policyError(configPath, field, 'expected a non-empty string')
  }
  return parsed.data
}

/** Reads an optional supported policy string with field-aware diagnostics. */
function optionalString(mapping, key, configPath, field) {
  if (mapping[key] === undefined) return
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
  const rootResult = parseMapping(parsed === undefined ? {} : parsed)
  if (!rootResult.success) throw policyError(configPath, 'document', 'expected a mapping')
  /** @type {Partial<z.infer<typeof mappingSchema>>} */
  const root = rootResult.data

  const ignoredKeys = []
  collectIgnoredKeys(root, ROOT_KEYS, '', ignoredKeys)
  const language = optionalString(root, 'language', configPath, 'language')
  const toneInstructions = optionalString(root, 'tone_instructions', configPath, 'tone_instructions')

  const reviews = root.reviews === undefined ? {} : root.reviews
  const reviewsResult = parseMapping(reviews)
  if (!reviewsResult.success) throw policyError(configPath, 'reviews', 'expected a mapping')
  /** @type {Partial<z.infer<typeof mappingSchema>>} */
  const reviewMapping = reviewsResult.data
  collectIgnoredKeys(reviewMapping, REVIEW_KEYS, 'reviews', ignoredKeys)
  const profile = optionalString(reviewMapping, 'profile', configPath, 'reviews.profile')
  const rawPathInstructions = reviewMapping.path_instructions === undefined ? [] : reviewMapping.path_instructions
  if (!Array.isArray(rawPathInstructions)) {
    throw policyError(configPath, 'reviews.path_instructions', 'expected a sequence')
  }
  const pathInstructions = rawPathInstructions.map((entry, index) => {
    const field = `reviews.path_instructions[${index}]`
    const entryResult = parseMapping(entry)
    if (!entryResult.success) throw policyError(configPath, field, 'expected a mapping')
    const entryMapping = entryResult.data
    collectIgnoredKeys(entryMapping, PATH_INSTRUCTION_KEYS, field, ignoredKeys)
    return {
      policyRef: field,
      path: requiredString(entryMapping.path, configPath, `${field}.path`),
      instructions: requiredString(entryMapping.instructions, configPath, `${field}.instructions`),
    }
  })

  const preMergeChecks = root.pre_merge_checks === undefined ? {} : root.pre_merge_checks
  const checksResult = parseMapping(preMergeChecks)
  if (!checksResult.success) throw policyError(configPath, 'pre_merge_checks', 'expected a mapping')
  /** @type {Partial<z.infer<typeof mappingSchema>>} */
  const checksMapping = checksResult.data
  collectIgnoredKeys(checksMapping, PRE_MERGE_KEYS, 'pre_merge_checks', ignoredKeys)
  const rawCustomChecks = checksMapping.custom_checks === undefined ? [] : checksMapping.custom_checks
  if (!Array.isArray(rawCustomChecks)) {
    throw policyError(configPath, 'pre_merge_checks.custom_checks', 'expected a sequence')
  }
  const customChecks = rawCustomChecks.map((entry, index) => {
    const field = `pre_merge_checks.custom_checks[${index}]`
    const entryResult = parseMapping(entry)
    if (!entryResult.success) throw policyError(configPath, field, 'expected a mapping')
    const entryMapping = entryResult.data
    collectIgnoredKeys(entryMapping, CUSTOM_CHECK_KEYS, field, ignoredKeys)
    const name = optionalString(entryMapping, 'name', configPath, `${field}.name`) || `Gate ${index + 1}`
    const mode = optionalString(entryMapping, 'mode', configPath, `${field}.mode`) || 'error'
    if (mode !== 'error' && mode !== 'warning') {
      throw policyError(configPath, `${field}.mode`, 'expected "error" or "warning"')
    }
    const command = optionalString(entryMapping, 'command', configPath, `${field}.command`)
    const instructions = optionalString(entryMapping, 'instructions', configPath, `${field}.instructions`)
    if (command === undefined && instructions === undefined) {
      throw policyError(configPath, field, 'expected command or instructions')
    }
    return Object.fromEntries([
      ['gateId', `gate-${String(index + 1).padStart(3, '0')}-${slug(name)}`],
      ['name', name],
      ['blocking', mode === 'error'],
      ['command', command],
      ['instructions', instructions],
    ].filter(([, value]) => value !== undefined))
  })

  return Object.fromEntries([
    ['version', 1],
    ['language', language],
    ['toneInstructions', toneInstructions],
    ['profile', profile],
    ['pathInstructions', pathInstructions],
    ['customChecks', customChecks],
    ['ignoredKeys', [...new Set(ignoredKeys)].toSorted()],
  ].filter(([, value]) => value !== undefined))
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
 * @typedef {object} ReviewConfigResolution Outcome of a review-configuration
 * search, retaining the full search trail so the workflow output stays
 * auditable.
 * @property {boolean} ok Whether a configuration file was found.
 * @property {string} config Path of the resolved configuration file, or the path that was attempted when `ok` is false.
 * @property {string} source Search stage that supplied the file: one of `explicit`, `repository`, `user`, or `example`.
 * @property {string[]} checked Every path probed, in search order, including the winner.
 * @property {object} [policy] Normalized review policy parsed from the resolved config; present only when `ok` is true.
 * @property {string} [error] Reason the search failed; present only when `ok` is false.
 */
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
 * @returns {ReviewConfigResolution} resolution result with normalized policy on success.
 */
export function resolveReviewConfig({
  repoRoot = process.cwd(),
  config,
  packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  env = process.env,
} = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot)
  const checked = []

  if (config) {
    const explicit = path.isAbsolute(config) ? config : path.resolve(resolvedRepoRoot, config)
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
    const configPath = path.join(resolvedRepoRoot, candidate)
    checked.push(configPath)
    if (existsSync(configPath)) {
      return withPolicy({ ok: true, config: configPath, source: 'repository', checked })
    }
  }

  const userConfig = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config'), 'dakar', 'config.yaml')
  checked.push(userConfig)
  if (existsSync(userConfig)) {
    return withPolicy({ ok: true, config: userConfig, source: 'user', checked })
  }

  const bundledExample = path.join(path.resolve(packageRoot), 'examples', 'df12-code-review.yaml')
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
    parsed[key.replaceAll(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value
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
  process.stdout.write(`${jsonIndent(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${jsonIndent({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
