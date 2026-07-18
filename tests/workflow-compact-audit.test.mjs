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

test('compactForAudit orders candidates by severity then stable path/line/id', () => {
  const input = [
    candidate({ candidateId: 'c-low', severity: 'low', path: 'src/z.js', line: 5, title: 'low' }),
    candidate({ candidateId: 'c-crit', severity: 'critical', path: 'src/b.js', line: 2, title: 'crit' }),
    candidate({ candidateId: 'c-high', severity: 'high', path: 'src/a.js', line: 1, title: 'high' }),
  ]
  const { auditCandidates, overCap } = compactForAudit(input, 30)

  assert.deepEqual(auditCandidates.map((c) => c.title), ['crit', 'high', 'low'])
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
