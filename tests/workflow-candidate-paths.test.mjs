/**
 * @file Prove candidate path handling resists path traversal.
 *
 * `normalizeCandidates` lives inside the ODW workflow body, so the tests slice
 * the declaration region above the control flow and compile it with inert
 * injected primitives (mirroring ODW's loader). The invariants under test: a
 * candidate may only reference a reviewed changed file, and traversal or
 * absolute paths are dropped before any candidate reaches a verification
 * command, even if they were somehow present in the changed-file set.
 */

import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

const WORKFLOW_PATH = new URL('../workflows/dakar-review.js', import.meta.url)
const CONTROL_FLOW_MARKER = 'if (cfg.dryRun === true) {'

async function loadCandidateSurface(workflowArgs = {}) {
  let source = await readFile(WORKFLOW_PATH, 'utf8')
  source = source.replace(/^export const meta\s*=/mu, 'const meta =')
  const markerIndex = source.indexOf(CONTROL_FLOW_MARKER)
  assert.notEqual(markerIndex, -1, 'control-flow marker should exist above the candidate helpers')
  const helperSource = source.slice(0, markerIndex)
  const factory = new Function(
    'args',
    'phase',
    'log',
    'agent',
    'parallel',
    'pipeline',
    'budget',
    'workflow',
    'validate',
    `${helperSource}\nreturn { normalizeCandidates, isSafeCandidatePath }`,
  )
  return factory(
    workflowArgs,
    () => {},
    () => {},
    async () => ({}),
    async () => [],
    async () => [],
    { total: null, spent: () => 0, remaining: () => Infinity },
    async () => ({}),
    () => ({ ok: true, errors: [], warnings: [] }),
  )
}

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
        confidence: 0.9,
      })),
    },
  ]
}

const TASK_GRAPH = [{ taskId: 'source-1', kind: 'source', assignedModel: 'gpt-5.5/high' }]

test('normalizeCandidates drops candidates whose path is not a reviewed changed file', async () => {
  const { normalizeCandidates } = await loadCandidateSurface()
  const changedFiles = ['src/app.js', 'src/util.js']
  const results = taskResult(['src/app.js', 'src/not-changed.js', 'docs/guide.md'])

  const candidates = normalizeCandidates(results, TASK_GRAPH, changedFiles)

  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ['src/app.js'],
  )
})

test('normalizeCandidates drops traversal and absolute paths even if present in changedFiles', async () => {
  const { normalizeCandidates } = await loadCandidateSurface()
  // Defence in depth: even a poisoned changed-file set cannot smuggle a path
  // that escapes REPO_ROOT past the traversal guard.
  const changedFiles = ['../evil.js', '/etc/passwd', 'src/ok.js', 'a/../../b.js']
  const results = taskResult(['../evil.js', '/etc/passwd', 'src/ok.js', 'a/../../b.js'])

  const candidates = normalizeCandidates(results, TASK_GRAPH, changedFiles)

  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ['src/ok.js'],
  )
})

test('isSafeCandidatePath enforces the whitelist and rejects traversal', async () => {
  const { isSafeCandidatePath } = await loadCandidateSurface()
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
