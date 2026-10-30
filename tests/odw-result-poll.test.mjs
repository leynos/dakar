/** @file Unit-test the injected kernel of the ODW result poller. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { pollOdwResult } from '../scripts/odw-result-poll.mjs'

/** A successful `odw result` fetch. */
const SUCCEEDED = { status: 0, signal: null, stdout: '{"ok":true}', stderr: '', error: undefined }
/** A failed `odw result` fetch. */
const REFUSED = { status: 3, signal: null, stdout: '', stderr: 'not ready', error: undefined }

/**
 * Run one poll against a controlled clock.
 *
 * Fetches are served in order; once they run out the poll keeps seeing a
 * refused fetch, and the sleeper advances the same clock the poller reads.
 *
 * @param {Array<object>} fetchResults - fetch results to serve, in order.
 * @param {number} timeoutMs - polling deadline in milliseconds.
 * @returns {Promise<object>} the poll outcome plus the recorded sleep delays.
 */
async function runPoll(fetchResults, timeoutMs) {
  const fetches = [...fetchResults]
  const delays = []
  let milliseconds = 0
  const outcome = await pollOdwResult({
    fetchResult: () => fetches.shift() ?? REFUSED,
    now: () => milliseconds,
    sleepFn: async (delay) => {
      delays.push(delay)
      milliseconds += delay
    },
    timeoutMs,
  })
  return { ...outcome, delays }
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
