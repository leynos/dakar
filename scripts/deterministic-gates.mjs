/**
 * @file Parse and execute explicit deterministic pre-merge checks.
 *
 * Dakar intentionally supports a small dependency-free YAML subset:
 * `pre_merge_checks.custom_checks[]` entries with scalar `name`, `mode`, and
 * `command` fields. Natural-language checks without a command remain policy
 * context and are not executed.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Maximum retained characters per redacted command-output stream. */
const MAX_EVIDENCE_CHARS = 4000

/** Returns the leading-space indentation of one YAML source line. */
function indentation(line) {
  return line.match(/^ */u)?.[0].length || 0
}

/** Decodes the plain, single-quoted, or double-quoted scalar subset Dakar accepts. */
function scalar(value) {
  const trimmed = value.trim()
  if (trimmed === '' || /^[>|]/u.test(trimmed)) return ''
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return ''
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'")
  }
  return trimmed.replace(/\s+#.*$/u, '').trim()
}

/** Parses one YAML mapping line into a supported scalar key and value. */
function mapping(line) {
  const match = line.trim().match(/^-?\s*([A-Za-z][\w-]*):\s*(.*)$/u)
  return match ? { key: match[1], value: scalar(match[2]) } : null
}

/** Converts a human gate name into a stable identifier segment. */
function slug(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/gu, '') || 'check'
}

/**
 * Parses explicit executable checks from a CodeRabbit-compatible YAML string.
 *
 * `mode: error` (or an omitted mode) is blocking; every other mode is
 * non-blocking. Entries without a scalar `command` remain model policy only.
 *
 * @param source - Resolved review configuration text.
 * @returns Stable executable gate definitions in configuration order.
 */
export function parseDeterministicGates(source) {
  const lines = source.split(/\r?\n/u)
  const preMergeIndex = lines.findIndex((line) => line.trim() === 'pre_merge_checks:')
  if (preMergeIndex === -1) return []
  const preMergeIndent = indentation(lines[preMergeIndex])
  let customIndex = -1
  for (let index = preMergeIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue
    if (indentation(lines[index]) <= preMergeIndent) break
    if (lines[index].trim() === 'custom_checks:') {
      customIndex = index
      break
    }
  }
  if (customIndex === -1) return []

  const customIndent = indentation(lines[customIndex])
  const entries = []
  let current = null
  const finish = () => {
    if (current) entries.push(current)
    current = null
  }
  for (let index = customIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = indentation(line)
    if (indent <= customIndent) break
    if (/^\s*-\s+/u.test(line)) {
      finish()
      current = {}
    }
    if (!current) continue
    const pair = mapping(line)
    if (pair) current[pair.key] = pair.value
  }
  finish()

  return entries.flatMap((entry, index) => {
    if (!entry.command) return []
    const name = entry.name || `Gate ${index + 1}`
    return [{
      gateId: `gate-${String(index + 1).padStart(3, '0')}-${slug(name)}`,
      name,
      command: entry.command,
      blocking: !entry.mode || entry.mode === 'error',
    }]
  })
}

/** Computes a non-reversible digest for complete command output. */
function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Redacts common credential forms and sensitive environment values from evidence.
 *
 * @param value - Raw command, stdout, or stderr text.
 * @returns Bounded evidence text safe for result envelopes and logs.
 */
function redactEvidence(value) {
  let redacted = String(value || '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, '[REDACTED]')
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu.test(name) || !secret || secret.length < 4) continue
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted.slice(0, MAX_EVIDENCE_CHARS)
}

/**
 * Executes configured gates in order and returns structured, redacted evidence.
 *
 * Commands run through the host shell in the reviewed repository. Environment
 * values are inherited for normal build tooling, but sensitive values and
 * bearer tokens are removed from retained evidence. A spawn failure becomes an
 * `error` result and never throws away outcomes from earlier gates.
 *
 * @param configPath - Resolved CodeRabbit-compatible YAML path.
 * @param repoRoot - Reviewed repository used as each command's working directory.
 * @returns Deterministic gate results in configuration order.
 */
export function loadAndRunDeterministicGates(configPath, repoRoot) {
  return runDeterministicGates(readFileSync(configPath, 'utf8'), repoRoot)
}

/**
 * Executes gate definitions parsed from trusted configuration text.
 *
 * @param source - Trusted configuration text selected by the host boundary.
 * @param repoRoot - Reviewed repository used as each command's working directory.
 * @returns Deterministic gate results in configuration order.
 */
export function runDeterministicGates(source, repoRoot) {
  const definitions = parseDeterministicGates(source)
  return definitions.map((gate) => {
    const completed = spawnSync(gate.command, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    })
    const stdout = completed.stdout || ''
    const stderr = completed.stderr || ''
    const status = completed.error ? 'error' : completed.status === 0 ? 'passed' : 'failed'
    return {
      ...gate,
      command: redactEvidence(gate.command),
      status,
      exitCode: completed.status,
      signal: completed.signal,
      stdout: redactEvidence(stdout),
      stderr: redactEvidence(completed.error ? `${stderr}\n${completed.error.message}`.trim() : stderr),
      stdoutSha256: digest(stdout),
      stderrSha256: digest(stderr),
    }
  })
}
