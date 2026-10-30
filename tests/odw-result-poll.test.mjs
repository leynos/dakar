/** @file Unit-test the injected kernel of the ODW result poller. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { pollOdwResult } from '../scripts/odw-result-poll.mjs'

/** A successful `odw result` fetch. */
function succeeded(stdout = '{"ok":true}') {
  return { status: 0, signal: null, stdout, stderr: '', error: undefined }
}

/** A failed `odw result` fetch. */
function refused(status = 3) {
  return { status, signal: null, stdout: '', stderr: 'not ready', error: undefined }
}

/** A controllable millisecond clock plus a sleeper that records its delays. */
function controllableClock() {
  let milliseconds = 0
  const delays = []
  return {
    now: () => milliseconds,
    delays,
    sleepFn: async (delay) => {
      delays.push(delay)
      milliseconds += delay
    },
  }
}

test('the first successful fetch is returned without sleeping', async () => {
  const clock = controllableClock()
  const { result, poll } = await pollOdwResult({
    fetchResult: () => succeeded(),
    now: clock.now,
    sleepFn: clock.sleepFn,
    timeoutMs: 60_000,
  })
  assert.equal(result.status, 0)
  assert.deepEqual(poll, { attempts: 1, failures: 0, startedAt: 0 })
  assert.deepEqual(clock.delays, [], 'a successful first attempt must not delay')
})

test('a retried fetch counts every attempt and failure', async () => {
  const clock = controllableClock()
  const fetches = [refused(), refused(), succeeded()]
  const { result, poll } = await pollOdwResult({
    fetchResult: () => fetches.shift(),
    now: clock.now,
    sleepFn: clock.sleepFn,
    timeoutMs: 60_000,
  })
  assert.equal(result.status, 0)
  assert.deepEqual(poll, { attempts: 3, failures: 2, startedAt: 0 })
  assert.deepEqual(clock.delays, [1000, 1000], 'retries wait one second between attempts')
})

test('polling stops at the deadline with the last failed fetch', async () => {
  const clock = controllableClock()
  const { result, poll } = await pollOdwResult({
    fetchResult: () => refused(),
    now: clock.now,
    sleepFn: clock.sleepFn,
    timeoutMs: 2500,
  })
  assert.equal(result.status, 3)
  assert.deepEqual(poll, { attempts: 4, failures: 4, startedAt: 0 })
  assert.deepEqual(clock.delays, [1000, 1000, 500], 'the final delay is clamped to the remaining time')
})

test('a spawn error is counted as a failed attempt', async () => {
  const clock = controllableClock()
  const spawnError = { status: null, signal: null, stdout: '', stderr: '', error: new Error('ENOENT') }
  const { result, poll } = await pollOdwResult({
    fetchResult: () => spawnError,
    now: clock.now,
    sleepFn: clock.sleepFn,
    timeoutMs: 0,
  })
  assert.equal(result.error.message, 'ENOENT')
  assert.deepEqual(poll, { attempts: 1, failures: 1, startedAt: 0 })
  assert.deepEqual(clock.delays, [], 'an expired deadline forbids further attempts')
})