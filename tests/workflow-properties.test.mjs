/**
 * @file Property-based coverage for the pure cost, retry, and compaction cores.
 *
 * These properties pin invariants the ADR 002 admission controller, the Flex
 * backoff schedule, and the audit compactor must uphold for arbitrary inputs,
 * complementing the example-based unit tests. They exercise only pure helpers,
 * so no runtime primitives are driven.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import fc from 'fast-check'

import { admit } from '../src/workflows/dakar-review/admission.ts'
import { backoffSeconds, deterministicJitter } from '../src/workflows/dakar-review/retry.ts'
import { candidateKey, compactForAudit, SEVERITY_RANK } from '../src/workflows/dakar-review/candidates.ts'

test('admit never overspends the budget and never mutates its state argument', () => {
  const nonNegative = fc.double({ min: 0, max: 1000, noNaN: true })
  fc.assert(
    fc.property(
      fc.record({ budgetUsd: nonNegative, reservedAuditUsd: nonNegative, spentUsd: nonNegative }),
      nonNegative,
      fc.constantFrom('luna-transaction', 'terra-audit'),
      (state, worstCaseUsd, kind) => {
        // Spread both sides so the comparison ignores fc.record's null
        // prototype and pins only the field values.
        const before = { ...state }
        const decision = admit(state, worstCaseUsd, kind)

        // admit is pure: neither admission nor refusal touches the state.
        assert.deepEqual({ ...state }, before)

        if (decision.admitted) {
          if (kind === 'luna-transaction') {
            // A luna-transaction must always leave room for the standing audit.
            assert.ok(state.spentUsd + worstCaseUsd + state.reservedAuditUsd <= state.budgetUsd)
          } else {
            // A terra-audit consumes its own reservation, not an extra addend.
            assert.ok(state.spentUsd + worstCaseUsd <= state.budgetUsd)
          }
        }
      },
    ),
  )
})

test('backoffSeconds stays within its documented bounds and is deterministic per (callId, attempt)', () => {
  fc.assert(
    fc.property(
      fc.record({
        flexInitialBackoffSeconds: fc.integer({ min: 1, max: 300 }),
        // Keep the ceiling at or above the floor so a valid schedule cannot
        // clamp the base below the initial backoff.
        maxDelta: fc.integer({ min: 0, max: 900 }),
        flexJitterSeconds: fc.integer({ min: 0, max: 60 }),
        flexAttempts: fc.integer({ min: 2, max: 6 }),
      }),
      fc.string(),
      ({ flexInitialBackoffSeconds, maxDelta, flexJitterSeconds, flexAttempts }, callId) => {
        const config = {
          flexAttempts,
          flexInitialBackoffSeconds,
          flexMaxBackoffSeconds: flexInitialBackoffSeconds + maxDelta,
          flexJitterSeconds,
        }
        for (let attempt = 2; attempt <= config.flexAttempts; attempt += 1) {
          const delay = backoffSeconds(config, callId, attempt)
          assert.ok(delay >= config.flexInitialBackoffSeconds, `delay ${delay} below floor`)
          assert.ok(delay <= config.flexMaxBackoffSeconds + config.flexJitterSeconds, `delay ${delay} above ceiling`)
          // Deterministic: identical inputs yield identical delays and jitter.
          assert.equal(delay, backoffSeconds(config, callId, attempt))
          const jitter = deterministicJitter(callId, attempt, config.flexJitterSeconds)
          assert.equal(jitter, deterministicJitter(callId, attempt, config.flexJitterSeconds))
          assert.ok(jitter >= 0 && jitter <= config.flexJitterSeconds)
        }
      },
    ),
  )
})

test('compactForAudit caps to the deduped count, preserves the deduped set, and orders by non-decreasing severity rank', () => {
  const severityArb = fc.constantFrom('critical', 'high', 'medium', 'low')
  // Draw path, line, and title from small domains so distinct entries routinely
  // collide on candidateKey, genuinely exercising the dedup-then-cap interaction.
  const pathArb = fc.constantFrom('src/a.js', 'src/b.js', 'src/c.js')
  const lineArb = fc.integer({ min: 1, max: 3 })
  const titleArb = fc.constantFrom('alpha', 'beta', 'gamma')
  const rowArb = fc.record({ severity: severityArb, path: pathArb, line: lineArb, title: titleArb })
  fc.assert(
    fc.property(fc.array(rowArb, { maxLength: 40 }), fc.integer({ min: 1, max: 60 }), (rows, cap) => {
      const input = rows.map((row, index) => ({
        candidateId: `c-${index}`, taskId: 'source-1', taskKind: 'source', sourceModel: 'gpt-5.5/high',
        verificationPolicy: 'verify-all', title: row.title, severity: row.severity, path: row.path,
        line: row.line, detail: 'detail', evidence: 'evidence', confidence: 'high', policyRefs: [],
      }))

      // Mirror compactForAudit's first-occurrence-per-key dedup to derive the
      // expected surviving multiset and its exact size.
      const seen = new Set()
      const dedupedIds = []
      for (const candidate of input) {
        const key = candidateKey(candidate)
        if (seen.has(key)) continue
        seen.add(key)
        dedupedIds.push(candidate.candidateId)
      }
      const uniqueByKeyCount = dedupedIds.length

      const { auditCandidates, overCap } = compactForAudit(input, cap)

      // The cap binds against the deduped count, not the raw input length.
      assert.equal(auditCandidates.length, Math.min(uniqueByKeyCount, cap))
      // The audited subset and the over-cap discards partition the deduped set exactly.
      const unionIds = [...auditCandidates.map((c) => c.candidateId), ...overCap.map((d) => d.candidate.candidateId)].sort()
      assert.deepEqual(unionIds, [...dedupedIds].sort())
      // Severity ranks are non-decreasing through the audited subset.
      const ranks = auditCandidates.map((c) => SEVERITY_RANK[c.severity])
      for (let index = 1; index < ranks.length; index += 1) {
        assert.ok(ranks[index] >= ranks[index - 1], `rank ${ranks[index]} < ${ranks[index - 1]}`)
      }
    }),
  )
})
