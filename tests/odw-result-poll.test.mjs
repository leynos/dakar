/**
 * @file Unit-test the injected kernel of the ODW result poller.
 *
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'

import { pollOdwResult } from '../scripts/odw-result-poll.mjs'

/** A successful `odw result` fetch. */
const SUCCEEDED = { status: 0, signal: null, stdout: '{"ok":true}', stderr: '', error: undefined }
/** A failed `odw result` fetch. */
const REFUSED = { status: 3, signal: null, stdout: '', stderr: 'not ready', error: undefined }

/** Arbitrary fetch sequence, each result carrying a distinct identity. */
const fetchSequenceArb = fc.array(
  fc.record({
    status: fc.constantFrom(0, 3),
    stdout: fc.constant(''),
    stderr: fc.constant('not ready'),
  }),
  { maxLength: 20 },
).map((results) => results.map((result, index) => ({
  ...result, id: index, signal: null, error: undefined,
})))

/**
 * Run one poll against a controlled clock.
 *
 * Fetches are served in order; once they run out the poll keeps seeing a
 * refused fetch, and the sleeper advances the same clock the poller reads.
 *
 * @param {Array<object>} fetchResults - fetch results to serve, in order.
 * @param {number} timeoutMs - polling deadline in milliseconds.
 * @returns {Promise<object>} the poll outcome, the recorded sleep delays and the served fetches.
 */
async function runPoll(fetchResults, timeoutMs) {
  const fetches = [...fetchResults]
  const delays = []
  const served = []
  let milliseconds = 0
  const outcome = await pollOdwResult({
    fetchResult: () => {
      const next = fetches.shift() ?? REFUSED
      served.push(next)
      return next
    },
    now: () => milliseconds,
    sleepFn: async (delay) => {
      delays.push(delay)
      milliseconds += delay
    },
    timeoutMs,
  })
  return { ...outcome, delays, served }
}

test('the first successful fetch is returned without sleeping', async () => {
  const { result, poll, delays } = await runPoll([SUCCEEDED], 60_000)
  assert.equal(result.status, 0)
  assert.deepEqual(poll, { attempts: 1, failures: 0, startedAt: 0 })
  assert.deepEqual(delays, [], 'a successful first attempt must not delay')
})

test('a retried fetch counts every attempt and failure', async () => {
  const { result, poll, delays } = await runPoll([REFUSED, REFUSED, SUCCEEDED], 60_000)
  assert.equal(result.status, 0)
  assert.deepEqual(poll, { attempts: 3, failures: 2, startedAt: 0 })
  assert.deepEqual(delays, [1000, 1000], 'retries wait one second between attempts')
})

test('polling stops at the deadline with the last failed fetch', async () => {
  const { result, poll, delays } = await runPoll([REFUSED, REFUSED, REFUSED, REFUSED], 2500)
  assert.equal(result.status, 3)
  assert.deepEqual(poll, { attempts: 4, failures: 4, startedAt: 0 })
  assert.deepEqual(delays, [1000, 1000, 500], 'the final delay is clamped to the remaining time')
})

test('a spawn error is counted as a failed attempt', async () => {
  const spawnError = { status: null, signal: null, stdout: '', stderr: '', error: new Error('ENOENT') }
  const { result, poll, delays } = await runPoll([spawnError], 0)
  assert.equal(result.error.message, 'ENOENT')
  assert.deepEqual(poll, { attempts: 1, failures: 1, startedAt: 0 })
  assert.deepEqual(delays, [], 'an expired deadline forbids further attempts')
})

test('the polling invariants hold over generated deadlines and fetch sequences', async () => {
  await fc.assert(fc.asyncProperty(fetchSequenceArb, fc.nat({ max: 60_000 }), async (fetchResults, timeoutMs) => {
    const { result, poll, delays, served } = await runPoll(fetchResults, timeoutMs)
    let totalDelay = 0
    for (const delay of delays) totalDelay += delay

    assert.ok(poll.attempts >= 1, 'the first attempt is always made')
    assert.ok(poll.failures <= poll.attempts, 'failures cannot exceed attempts')
    assert.equal(served.length, poll.attempts, 'every attempt performs exactly one fetch')
    assert.equal(result, served.at(-1), 'the returned result is the final fetch served')
    assert.ok(delays.every((delay) => delay >= 0 && delay <= 1000), 'each delay is bounded by one second')
    assert.ok(totalDelay <= timeoutMs, 'sleeping never outlasts the deadline')
  }), { numRuns: 200 })
})
