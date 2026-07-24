/**
 * @file Deterministic Flex retry schedule, jitter, and worst-case timeout budget.
 *
 * ADR 002 ("Flex scheduling and failure policy") requires bounded exponential
 * backoff with positive jitter for Flex capacity failures, and forbids
 * `Math.random`/`Date.now` (the ODW dialect bans them outright). This module
 * holds the pure computation only; `main.ts` owns the imperative `agent()` and
 * `sleep()` calls that consume this schedule. Keeping the arithmetic pure makes
 * the backoff sequence, jitter determinism, and timeout budget directly
 * testable without driving the runtime.
 */

/** The bounded retry knobs consumed by the Flex backoff schedule. */
export interface FlexRetryConfig {
  readonly flexAttempts: number
  readonly flexInitialBackoffSeconds: number
  readonly flexMaxBackoffSeconds: number
  readonly flexJitterSeconds: number
}

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * Derives a reproducible jitter offset in `[0, jitterSeconds]` from a call id
 * and attempt number using a small FNV-1a integer hash.
 *
 * Jitter exists to decorrelate concurrent reviews; it does not need to be
 * cryptographic, and reproducible pseudo-randomness suffices because call ids
 * differ across runs. Using a deterministic hash keeps the workflow free of the
 * `Math.random`/`Date.now` primitives the ODW dialect forbids.
 *
 * @param callId - Stable identifier for the retried call (task id or "audit").
 * @param attempt - The 1-based attempt number being scheduled.
 * @param jitterSeconds - Inclusive upper bound for the jitter; `0` disables it.
 * @returns An integer jitter offset within `[0, jitterSeconds]`.
 */
export function deterministicJitter(callId: string, attempt: number, jitterSeconds: number): number {
  if (jitterSeconds <= 0) return 0
  const input = `${callId}:${attempt}`
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash % (jitterSeconds + 1)
}

/**
 * Computes the backoff delay in seconds before a given attempt.
 *
 * Attempt 1 is the initial try and has no preceding sleep; sleep precedes
 * attempts 2..N. For attempt `n`, the base delay is
 * `min(flexInitialBackoffSeconds * 2^(n-2), flexMaxBackoffSeconds)` and the
 * positive jitter from {@link deterministicJitter} is added on top.
 *
 * @param config - The bounded Flex retry knobs.
 * @param callId - Stable identifier for the retried call.
 * @param attempt - The 1-based attempt about to run.
 * @returns The backoff in seconds; `0` for the first attempt.
 */
export function backoffSeconds(config: FlexRetryConfig, callId: string, attempt: number): number {
  if (attempt < 2) return 0
  const base = Math.min(config.flexInitialBackoffSeconds * 2 ** (attempt - 2), config.flexMaxBackoffSeconds)
  return base + deterministicJitter(callId, attempt, config.flexJitterSeconds)
}

/**
 * Classifies whether a thrown agent failure should be retried on the Flex lane.
 *
 * ADR 002's failure policy retries the Flex `resource_unavailable` (HTTP 429)
 * response, and the M0 failure-shape evidence shows that adapter failures are
 * opaque through ODW: timeouts, 429s, and process failures all surface as a
 * single thrown call failure with no distinguishing structure. This slice
 * therefore adopts the plan's conservative classifier and retries every thrown
 * agent error. A schema-invalid response is deliberately NOT special-cased
 * here: ODW performs its own schema-repair retries before returning to the
 * workflow, so distinguishing that case is neither possible nor our
 * responsibility. Retrying is safe because the affected stages are idempotent
 * and free of repository writes.
 *
 * @param _error - The value thrown by the failed `agent()` call.
 * @returns Whether the caller should retry the call.
 */
export function isRetryableFlexError(_error: unknown): boolean {
  return true
}

/**
 * Computes one call chain's worst-case wall clock: every attempt hits its
 * per-call adapter timeout and every backoff draws the maximum jitter.
 *
 * @param config - The bounded Flex retry knobs.
 * @param perCallTimeoutSeconds - The per-call adapter timeout in seconds.
 * @returns The worst-case seconds for a single retried call chain.
 */
function worstCaseChainSeconds(config: FlexRetryConfig, perCallTimeoutSeconds: number): number {
  let total = config.flexAttempts * perCallTimeoutSeconds
  for (let attempt = 2; attempt <= config.flexAttempts; attempt += 1) {
    const base = Math.min(config.flexInitialBackoffSeconds * 2 ** (attempt - 2), config.flexMaxBackoffSeconds)
    total += base + config.flexJitterSeconds
  }
  return total
}

/**
 * Computes the worst-case wall clock for a whole review: the finder packs run
 * in parallel (so one pack chain bounds them) and the audit chain runs
 * afterwards, giving `packChain + auditChain`. A test asserts the default
 * result stays below the harness's outer `--timeout 3600`.
 *
 * @param config - The bounded Flex retry knobs.
 * @param perCallTimeoutSeconds - The per-call adapter timeout in seconds.
 * @returns The worst-case review wall clock in seconds.
 */
export function worstCaseReviewSeconds(config: FlexRetryConfig, perCallTimeoutSeconds: number): number {
  const chain = worstCaseChainSeconds(config, perCallTimeoutSeconds)
  return chain + chain
}
