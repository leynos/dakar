/**
 * @file Unit-test deterministic compaction of candidates for the issue-set audit.
 *
 * `compactForAudit` orders eligible candidates by severity, deduplicates by
 * candidate key, and caps the set at `maxAuditCandidates`, recording every
 * over-cap candidate as an explicit `over_audit_cap` discard rather than
 * silently dropping it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compactForAudit } from '../src/workflows/dakar-review/candidates.ts'

function candidate(overrides = {}) {
  return {
    candidateId: overrides.candidateId ?? `source-1:${overrides.path ?? 'src/a.js'}:${overrides.line ?? 1}:t`,
    taskId: 'source-1', taskKind: 'source', sourceModel: 'gpt-5.5/high', verificationPolicy: 'verify-all',
    title: overrides.title ?? 'finding', severity: overrides.severity ?? 'medium', path: overrides.path ?? 'src/a.js',
    line: overrides.line ?? 1, detail: 'detail', evidence: 'evidence', confidence: 'high', policyRefs: [], ...overrides,
  }
}

test('compactForAudit orders by severity rank, then path, then line, then candidateId', () => {
  // Two shared severities (high, medium) held by several candidates that differ
  // by path, line, and candidateId, so the full deterministic tiebreak chain
  // (compactForAudit sorts by bySeverity: rank, path, line, id) is exercised
  // rather than only severity-stable order.
  const input = [
    candidate({ candidateId: 'h-b-2', severity: 'high', path: 'src/b.js', line: 2, title: 'h-b-2' }),
    candidate({ candidateId: 'm-a-9', severity: 'medium', path: 'src/a.js', line: 9, title: 'm-a-9' }),
    candidate({ candidateId: 'h-a-5', severity: 'high', path: 'src/a.js', line: 5, title: 'h-a-5' }),
    candidate({ candidateId: 'h-a-1-y', severity: 'high', path: 'src/a.js', line: 1, title: 'h-a-1-y' }),
    candidate({ candidateId: 'h-a-1-x', severity: 'high', path: 'src/a.js', line: 1, title: 'h-a-1-x' }),
    candidate({ candidateId: 'm-a-3', severity: 'medium', path: 'src/a.js', line: 3, title: 'm-a-3' }),
  ]
  const { auditCandidates, overCap } = compactForAudit(input, 30)

  // high before medium; within high: path a < b, then line 1 < 5, then id x < y.
  assert.deepEqual(
    auditCandidates.map((c) => c.candidateId),
    ['h-a-1-x', 'h-a-1-y', 'h-a-5', 'h-b-2', 'm-a-3', 'm-a-9'],
  )
  assert.deepEqual(overCap, [])
})

test('compactForAudit deduplicates entries sharing a candidate key', () => {
  const input = [
    candidate({ candidateId: 'source-1:src/a.js:1:t', path: 'src/a.js', line: 1, title: 'finding' }),
    candidate({ candidateId: 'source-1:src/a.js:1:t', path: 'src/a.js', line: 1, title: 'finding' }),
  ]
  const { auditCandidates } = compactForAudit(input, 30)

  assert.equal(auditCandidates.length, 1)
})

test('compactForAudit caps at maxAuditCandidates and records the remainder as over_audit_cap', () => {
  const input = [
    candidate({ candidateId: 'c1', severity: 'critical', path: 'src/a.js', line: 1, title: 'a' }),
    candidate({ candidateId: 'c2', severity: 'high', path: 'src/b.js', line: 2, title: 'b' }),
    candidate({ candidateId: 'c3', severity: 'low', path: 'src/c.js', line: 3, title: 'c' }),
  ]
  const { auditCandidates, overCap } = compactForAudit(input, 2)

  assert.deepEqual(auditCandidates.map((c) => c.title), ['a', 'b'])
  assert.equal(overCap.length, 1)
  assert.equal(overCap[0].status, 'over_audit_cap')
  assert.equal(overCap[0].candidate.title, 'c')
  assert.match(overCap[0].reason, /audit cap/iu)
})

test('compactForAudit returns no discards when the set fits within the cap', () => {
  const { auditCandidates, overCap } = compactForAudit([candidate()], 30)
  assert.equal(auditCandidates.length, 1)
  assert.equal(overCap.length, 0)
})
