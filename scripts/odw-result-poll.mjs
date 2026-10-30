/**
 * Poll for an asynchronous review result until it is available.
 *
 * The polling policy stays free of process spawning, wall-clock reads,
 * logging and recording: callers inject the result fetcher, clock and sleeper,
 * which keeps the unit testable without touching process or clock globals.
 *
 * @module
 */

/**
 * @typedef {object} PollMetrics Bounded metrics for a completed poll, safe to attach to telemetry.
 * @property {number} attempts - result-fetch attempts made.
 * @property {number} failures - attempts that did not exit successfully.
 * @property {number} startedAt - clock reading when polling began.
 */

/**
 * @typedef {object} PollOutcome The final fetch and the metrics describing the whole poll.
 * @property {import('node:child_process').SpawnSyncReturns<string>} result - the last fetch attempted.
 * @property {PollMetrics} poll - bounded metrics for the poll.
 */

/**
 * Count one result-fetch attempt and, when the fetch failed, one failure.
 *
 * @param {PollMetrics} poll - mutable poll counters.
 * @param {import('node:child_process').SpawnSyncReturns<string>} result - the fetch result.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} the same result, for chaining.
 */
function recordResultFetch(poll, result) {
  poll.attempts += 1
  if (result.status !== 0) poll.failures += 1
  return result
}

/**
 * Poll for a result until it succeeds or the deadline is reached.
 *
 * This unit is read-only and fallible: it performs no recording, emits no
 * telemetry and builds no failure envelope. The first attempt is always made,
 * even when the deadline has already passed.
 *
 * @param {object} polling - polling dependencies and limit.
 * @param {() => import('node:child_process').SpawnSyncReturns<string>} polling.fetchResult - perform one result-fetch attempt.
 * @param {() => number} polling.now - millisecond clock used for the deadline.
 * @param {(milliseconds: number) => Promise<unknown>} polling.sleepFn - delay between attempts.
 * @param {number} polling.timeoutMs - polling deadline in milliseconds.
 * @returns {Promise<PollOutcome>} the final fetch and its bounded metrics.
 */
export async function pollOdwResult({ fetchResult, now, sleepFn, timeoutMs }) {
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  const poll = { attempts: 0, failures: 0, startedAt }
  let result = recordResultFetch(poll, fetchResult())
  while (result.status !== 0 && now() < deadline) {
    const remainingMilliseconds = deadline - now()
    const delayMilliseconds = Math.min(1000, Math.max(0, remainingMilliseconds))
    await sleepFn(delayMilliseconds)
    result = recordResultFetch(poll, fetchResult())
  }
  return { result, poll }
}