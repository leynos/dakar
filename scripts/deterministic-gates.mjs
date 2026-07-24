/**
 * @file Execute normalized deterministic pre-merge checks.
 *
 * YAML parsing and policy validation belong to `review-config.mjs`. This module
 * accepts only that normalized contract, executes command-bearing checks, and
 * retains bounded redacted evidence without exposing environment secrets.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { loadReviewPolicy } from './review-config.mjs'

/** Maximum retained characters per redacted command-output stream. */
const MAX_EVIDENCE_CHARS = 4000

/**
 * Selects executable checks from a normalized review policy.
 *
 * @param {object} policy - policy returned by `loadReviewPolicy`.
 * @returns Stable executable gate definitions in configuration order.
 */
export function deterministicGateDefinitions(policy) {
  return policy.customChecks.flatMap((check) =>
    check.command === undefined
      ? []
      : [{
          gateId: check.gateId,
          name: check.name,
          command: check.command,
          blocking: check.blocking,
        }])
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
  return runDeterministicGates(loadReviewPolicy(configPath), repoRoot)
}

/**
 * Executes gate definitions selected from trusted normalized policy.
 *
 * @param {object} policy - trusted normalized review policy.
 * @param repoRoot - Reviewed repository used as each command's working directory.
 * @returns Deterministic gate results in configuration order.
 */
export function runDeterministicGates(policy, repoRoot) {
  const definitions = deterministicGateDefinitions(policy)
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
