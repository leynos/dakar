/** @file Unit-test the deterministic Flex retry schedule and timeout budget. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  backoffSeconds,
  deterministicJitter,
  isRetryableFlexError,
  worstCaseReviewSeconds,
} from '../src/workflows/dakar-review/retry.ts'
import { resolveWorkflowConfig } from '../src/workflows/dakar-review/config.ts'

// The slice defaults per ADR 002 (flexAttempts reduced from 6 to 3 for the
// timeout budget) and the M5 specification.
const DEFAULTS = Object.freeze({
  flexAttempts: 3,
  flexInitialBackoffSeconds: 30,
  flexMaxBackoffSeconds: 120,
  flexJitterSeconds: 10,
})

test('the backoff sequence matches the documented exponential schedule with jitter', () => {
  // Attempt 1 is the initial try with no preceding sleep; sleep precedes 2..N.
  const jitter2 = deterministicJitter('luna-flex-1', 2, DEFAULTS.flexJitterSeconds)
  const jitter3 = deterministicJitter('luna-flex-1', 3, DEFAULTS.flexJitterSeconds)

  assert.equal(backoffSeconds(DEFAULTS, 'luna-flex-1', 2), 30 + jitter2)
  assert.equal(backoffSeconds(DEFAULTS, 'luna-flex-1', 3), 60 + jitter3)
})

test('backoff is capped at flexMaxBackoffSeconds before jitter is added', () => {
  const capped = { flexAttempts: 6, flexInitialBackoffSeconds: 100, flexMaxBackoffSeconds: 120, flexJitterSeconds: 0 }
  // Attempt 3 base is min(100 * 2^1, 120) = 120, not 200.
  assert.equal(backoffSeconds(capped, 'call', 3), 120)
  // Attempt 4 base is min(100 * 2^2, 120) = 120.
  assert.equal(backoffSeconds(capped, 'call', 4), 120)
})

test('deterministic jitter is reproducible for the same call id and attempt', () => {
  for (const attempt of [2, 3, 4, 5, 6]) {
    assert.equal(
      deterministicJitter('audit', attempt, DEFAULTS.flexJitterSeconds),
      deterministicJitter('audit', attempt, DEFAULTS.flexJitterSeconds),
    )
  }
})

test('two distinct call ids decorrelate somewhere across the attempt range', () => {
  const sequenceA = Array.from({ length: 6 }, (_, index) => deterministicJitter('luna-flex-1', index + 1, DEFAULTS.flexJitterSeconds))
  const sequenceB = Array.from({ length: 6 }, (_, index) => deterministicJitter('luna-flex-2', index + 1, DEFAULTS.flexJitterSeconds))
  assert.notDeepEqual(sequenceA, sequenceB, 'distinct call ids must produce a different jitter offset in at least one attempt')
})

test('jitter always lands within the inclusive bound and zero disables it', () => {
  for (const callId of ['audit', 'luna-flex-1', 'luna-flex-2', 'luna-flex-3', 'x']) {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const jitter = deterministicJitter(callId, attempt, DEFAULTS.flexJitterSeconds)
      assert.ok(Number.isInteger(jitter))
      assert.ok(jitter >= 0 && jitter <= DEFAULTS.flexJitterSeconds, `jitter ${jitter} out of [0, ${DEFAULTS.flexJitterSeconds}]`)
      assert.equal(deterministicJitter(callId, attempt, 0), 0)
    }
  }
})

test('every thrown agent error is conservatively retryable', () => {
  assert.equal(isRetryableFlexError(new Error('adapter timeout')), true)
  assert.equal(isRetryableFlexError(new Error('HTTP 429 resource_unavailable')), true)
  assert.equal(isRetryableFlexError('process exited non-zero'), true)
})

test('worstCaseReviewSeconds sums the parallel pack chain and the audit chain', () => {
  // Per chain: flexAttempts * perCallTimeout + backoff for attempts 2..N with
  // maximum jitter. Defaults: 3 * 300 = 900; backoff (30 + 10) + (60 + 10) = 110;
  // chain = 1010. Pack chain and audit chain: 2 * 1010 = 2020.
  assert.equal(worstCaseReviewSeconds(DEFAULTS, 300), 2020)
})

test('worstCaseReviewSeconds for the resolved defaults fits the outer harness timeout', () => {
  const config = resolveWorkflowConfig(undefined)
  const worst = worstCaseReviewSeconds(
    {
      flexAttempts: config.flexAttempts,
      flexInitialBackoffSeconds: config.flexInitialBackoffSeconds,
      flexMaxBackoffSeconds: config.flexMaxBackoffSeconds,
      flexJitterSeconds: config.flexJitterSeconds,
    },
    config.perCallTimeoutSeconds,
  )
  assert.equal(worst, 2020)
  assert.ok(worst < 3600, `worst-case review ${worst}s must fit the outer --timeout 3600`)
})
