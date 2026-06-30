#!/usr/bin/env node
/**
 * @file Resolve Dakar's CodeRabbit-compatible review configuration.
 *
 * The helper is shared by the installable CLI and the ODW workflow. It keeps
 * configuration precedence deterministic and reports the paths considered so a
 * review result can explain which policy file shaped the run.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPO_CONFIGS = ['.coderabbit.yaml', '.coderabbit.yml', 'coderabbit.yaml', 'coderabbit.yml']

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
      return { ok: true, config: explicit, source: 'explicit', checked }
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
      return { ok: true, config: path, source: 'repository', checked }
    }
  }

  const userConfig = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'dakar', 'config.yaml')
  checked.push(userConfig)
  if (existsSync(userConfig)) {
    return { ok: true, config: userConfig, source: 'user', checked }
  }

  const bundledExample = join(resolve(packageRoot), 'examples', 'df12-code-review.yaml')
  checked.push(bundledExample)
  return { ok: true, config: bundledExample, source: 'example', checked }
}

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
