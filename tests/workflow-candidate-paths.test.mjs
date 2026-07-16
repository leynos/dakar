/**
 * @file Prove candidate path handling resists path traversal.
 *
 * The invariants under test: a candidate may only reference a reviewed changed
 * file, and traversal or absolute paths are dropped before any candidate
 * reaches a verification command, even if they were somehow present in the
 * changed-file set.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'

import {
  acceptedFromVerdicts,
  candidateKey,
  candidatesForVerification,
  isSafeCandidatePath,
  normalizeCandidates,
} from '../src/workflows/dakar-review/candidates.ts'

function taskResult(candidatePaths) {
  return [
    {
      taskId: 'source-1',
      candidates: candidatePaths.map((path, index) => ({
        title: `finding ${index}`,
        severity: 'medium',
        path,
        line: index + 1,
        detail: 'detail',
        evidence: 'evidence',
        confidence: 0.9,
      })),
    },
  ]
}

const TASK_GRAPH = [
  {
    taskId: 'source-1',
    kind: 'source',
    assignedModel: 'gpt-5.5/high',
    files: [],
    maxFindings: 2,
    verificationPolicy: 'verify-all',
  },
]

function bindResults(results, files, maxFindings = TASK_GRAPH[0].maxFindings) {
  const task = { ...TASK_GRAPH[0], files, maxFindings }
  return results.map((result) => ({ result, task }))
}

test('normalizeCandidates drops candidates whose path is not a reviewed changed file', () => {
  const changedFiles = ['src/app.js', 'src/util.js']
  const results = taskResult(['src/app.js', 'src/not-changed.js', 'docs/guide.md'])

  const candidates = normalizeCandidates(bindResults(results, changedFiles), changedFiles, 30)

  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ['src/app.js'],
  )
})

test('normalizeCandidates enforces the per-task finding cap before the global cap', () => {
  const changedFiles = ['src/a.js', 'src/b.js', 'src/c.js']
  const candidates = normalizeCandidates(bindResults(taskResult(changedFiles), changedFiles), changedFiles, 30)

  assert.deepEqual(candidates.map(({ path }) => path), changedFiles.slice(0, TASK_GRAPH[0].maxFindings))
})

test('per-task caps apply after deterministic ordering, not finder arrival order', () => {
  const changedFiles = ['src/a.js', 'src/b.js', 'src/c.js']
  const results = taskResult([...changedFiles].reverse())

  const candidates = normalizeCandidates(bindResults(results, changedFiles), changedFiles, 30)

  assert.deepEqual(candidates.map(({ path }) => path), ['src/a.js', 'src/b.js'])
})

test('normalizeCandidates never exceeds a positive per-task cap', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 20 }),
    fc.integer({ min: 0, max: 50 }),
    (maxFindings, candidateCount) => {
      const changedFiles = Array.from({ length: candidateCount }, (_, index) => `src/${index}.js`)
      const task = { ...TASK_GRAPH[0], files: changedFiles, maxFindings }
      const bound = taskResult(changedFiles).map((result) => ({ result, task }))
      assert.ok(normalizeCandidates(bound, changedFiles, 1_000).length <= maxFindings)
    },
  ))
})

test('normalizeCandidates drops traversal and absolute paths even if present in changedFiles', () => {
  // Defence in depth: even a poisoned changed-file set cannot smuggle a path
  // that escapes REPO_ROOT past the traversal guard.
  const changedFiles = ['../evil.js', '/etc/passwd', 'src/ok.js', 'a/../../b.js']
  const results = taskResult(['../evil.js', '/etc/passwd', 'src/ok.js', 'a/../../b.js'])

  const candidates = normalizeCandidates(bindResults(results, changedFiles), changedFiles, 30)

  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ['src/ok.js'],
  )
})

test('isSafeCandidatePath enforces the whitelist and rejects traversal', () => {
  const changed = new Set(['src/app.js'])

  assert.equal(isSafeCandidatePath('src/app.js', changed), true)
  assert.equal(isSafeCandidatePath('src/other.js', changed), false)
  assert.equal(isSafeCandidatePath('', changed), false)
  assert.equal(isSafeCandidatePath('src/app.js', new Set()), false)
  // Traversal and absolute forms are rejected regardless of the whitelist.
  assert.equal(isSafeCandidatePath('../secret', new Set(['../secret'])), false)
  assert.equal(isSafeCandidatePath('src/../../secret', new Set(['src/../../secret'])), false)
  assert.equal(isSafeCandidatePath('/etc/passwd', new Set(['/etc/passwd'])), false)
  assert.equal(isSafeCandidatePath('C:\\Windows\\system32', new Set(['C:\\Windows\\system32'])), false)
  assert.equal(isSafeCandidatePath('\\\\server\\share', new Set(['\\\\server\\share'])), false)
})

test('candidate and finding caps retain higher severities with stable ties', () => {
  const changedFiles = ['src/low.js', 'src/high-a.js', 'src/critical.js', 'src/high-b.js']
  const results = [
    {
      taskId: 'source-1',
      candidates: [
        { title: 'low', severity: 'low', path: changedFiles[0] },
        { title: 'high a', severity: 'high', path: changedFiles[1] },
        { title: 'critical', severity: 'critical', path: changedFiles[2] },
        { title: 'high b', severity: 'high', path: changedFiles[3] },
      ].map((candidate) => ({ ...candidate, detail: 'detail', evidence: 'evidence' })),
    },
  ]
  const candidates = normalizeCandidates(bindResults(results, changedFiles, 10), changedFiles, 3)
  assert.deepEqual(candidates.map(({ title }) => title), ['critical', 'high a', 'high b'])

  const verdicts = candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    status: 'accepted',
    reason: 'confirmed',
    evidenceChecked: 'source',
  }))
  const accepted = acceptedFromVerdicts([...candidates].reverse().map((scheduledCandidate) => ({
    scheduledCandidate,
    verdict: verdicts.find(({ candidateId }) => candidateId === scheduledCandidate.candidateId),
  })))
  assert.deepEqual(accepted.map(({ title }) => title), ['critical', 'high a', 'high b'])
})

test('candidate keys preserve and normalize Unicode letters and numbers', () => {
  const base = { path: 'src/a.js', line: 1 }

  assert.equal(candidateKey({ ...base, title: 'Résumé ２' }), 'src/a.js:1:résumé-2')
  assert.equal(candidateKey({ ...base, title: ' Bug ' }), 'src/a.js:1:-bug-')
  assert.notEqual(candidateKey({ ...base, title: '修正' }), candidateKey({ ...base, title: 'Ошибка' }))
})

test('accepted verdict reduction binds decisions to unique scheduled candidates', () => {
  const first = { candidateId: 'first', severity: 'high', path: 'a.js', line: 1 }
  const second = { candidateId: 'second', severity: 'high', path: 'b.js', line: 1 }
  const accepted = (candidateId) => ({ candidateId, status: 'accepted', reason: 'yes', evidenceChecked: 'source' })

  assert.deepEqual(acceptedFromVerdicts([
    { scheduledCandidate: first, verdict: accepted('second') },
    { scheduledCandidate: second, verdict: accepted('second') },
    { scheduledCandidate: second, verdict: accepted('second') },
  ]).map(({ candidateId }) => candidateId), ['second'])
})

test('candidate caps use deterministic path, line, and id tie-breaks', () => {
  const changedFiles = ['z.js', 'a.js']
  const results = [{ taskId: 'source-1', candidates: [
    { title: 'later', severity: 'medium', path: 'z.js', line: 1 },
    { title: 'line two', severity: 'medium', path: 'a.js', line: 2 },
    { title: 'line one z', severity: 'medium', path: 'a.js', line: 1 },
    { title: 'line one a', severity: 'medium', path: 'a.js', line: 1 },
  ].map((candidate) => ({ ...candidate, detail: 'detail', evidence: 'evidence' })) }]

  const candidates = normalizeCandidates(bindResults(results, changedFiles, 10), changedFiles, 3)

  assert.deepEqual(candidates.map(({ title }) => title), ['line one a', 'line one z', 'line two'])
})

test('verification policy samples one low candidate per non-high task', () => {
  const candidates = [
    { candidateId: 'a', taskId: 'tests-1', severity: 'low', verificationPolicy: 'verify-non-low-and-sampled-low' },
    { candidateId: 'b', taskId: 'tests-1', severity: 'low', verificationPolicy: 'verify-non-low-and-sampled-low' },
    { candidateId: 'c', taskId: 'tests-1', severity: 'high', verificationPolicy: 'verify-non-low-and-sampled-low' },
    { candidateId: 'd', taskId: 'source-1', severity: 'low', verificationPolicy: 'verify-all' },
  ]
  assert.deepEqual(candidatesForVerification(candidates).map(({ candidateId }) => candidateId), ['a', 'c', 'd'])
})
