/** @file Unit-test the pure budget-admission control from TypeScript source. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { admit } from '../src/workflows/dakar-review/admission.ts'

test('a luna-transaction is admitted iff spent + worstCase + reservedAudit <= budget', () => {
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.09375, spentUsd: 0.5 }

  const decision = admit(state, 0.4, 'luna-transaction')

  // 0.5 + 0.4 + 0.09375 = 0.99375 <= 1.0
  assert.deepEqual(decision, { admitted: true, worstCaseUsd: 0.4 })
})

test('a luna-transaction is refused once the reserved audit would be squeezed out', () => {
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.09375, spentUsd: 0.5 }

  const decision = admit(state, 0.40626, 'luna-transaction')

  // 0.5 + 0.40626 + 0.09375 = 1.00001 > 1.0
  assert.equal(decision.admitted, false)
  assert.equal(decision.worstCaseUsd, 0.40626)
  assert.equal(typeof decision.reason, 'string')
  assert.ok(decision.reason.length > 0)
})

test('a terra-audit is admitted iff spent + worstCase <= budget, consuming its own reservation', () => {
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.09375, spentUsd: 0.9 }

  // The audit's own reservation is not added again: 0.9 + 0.09375 = 0.99375 <= 1.0.
  const decision = admit(state, 0.09375, 'terra-audit')

  assert.deepEqual(decision, { admitted: true, worstCaseUsd: 0.09375 })
})

test('a terra-audit ignores reservedAuditUsd as a separate addend (no double counting)', () => {
  // If reservedAuditUsd were added again on top of worstCaseUsd, this would be
  // refused (0.9 + 0.09375 + 0.09375 = 1.0875 > 1.0). It must be admitted.
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.09375, spentUsd: 0.9 }

  const decision = admit(state, 0.09375, 'terra-audit')

  assert.equal(decision.admitted, true)
})

test('a terra-audit is refused when spent + worstCase exceeds budget', () => {
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.09375, spentUsd: 0.95 }

  const decision = admit(state, 0.1, 'terra-audit')

  assert.equal(decision.admitted, false)
  assert.equal(decision.worstCaseUsd, 0.1)
  assert.equal(typeof decision.reason, 'string')
  assert.ok(decision.reason.length > 0)
})

test('boundary: an exactly-equal sum is admitted for luna-transaction', () => {
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.09375, spentUsd: 0.40625 }

  // 0.40625 + 0.5 + 0.09375 = 1.0 exactly.
  const decision = admit(state, 0.5, 'luna-transaction')

  assert.deepEqual(decision, { admitted: true, worstCaseUsd: 0.5 })
})

test('boundary: one cent over the budget is refused with a reason string', () => {
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.09375, spentUsd: 0.40625 }

  const decision = admit(state, 0.51, 'luna-transaction')

  assert.equal(decision.admitted, false)
  assert.equal(typeof decision.reason, 'string')
  assert.ok(decision.reason.length > 0)
})

test('boundary: an exactly-equal sum is admitted for terra-audit', () => {
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.09375, spentUsd: 0.90625 }

  // 0.90625 + 0.09375 = 1.0 exactly.
  const decision = admit(state, 0.09375, 'terra-audit')

  assert.deepEqual(decision, { admitted: true, worstCaseUsd: 0.09375 })
})

test('refusals are pure: admit never mutates its inputs', () => {
  const state = { budgetUsd: 0.1, reservedAuditUsd: 0.05, spentUsd: 0.05 }
  const before = structuredClone(state)

  const decision = admit(state, 0.5, 'luna-transaction')

  assert.equal(decision.admitted, false)
  assert.deepEqual(state, before)
})

test('admissions are pure too: admit never mutates its inputs on success', () => {
  const state = { budgetUsd: 1.0, reservedAuditUsd: 0.05, spentUsd: 0.05 }
  const before = structuredClone(state)

  const decision = admit(state, 0.1, 'luna-transaction')

  assert.equal(decision.admitted, true)
  assert.deepEqual(state, before)
})
