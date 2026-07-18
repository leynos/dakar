/** @file Prove the deterministic report rendering path is byte-stable.
 *
 * After stage c the Synthesize agent call is gone and the workflow renders its
 * report purely from the authoritative accepted candidates. These tests drive
 * the compiled workflow twice through the mock-agent harness with identical
 * fixture inputs and assert the emitted `reportMarkdown` is byte-for-byte
 * identical, and that a known accepted candidate produces the expected
 * deterministic Markdown sections.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildAgentMock, extractAuditCandidates, FixtureFailure } from './helpers/mock-agents.mjs'

function renderingResponders() {
  return [
    {
      match: 'source-1',
      respond: () => ({
        taskId: 'source-1', summary: 'candidate',
        candidates: [{ title: 'Bug', severity: 'high', path: 'src/a.js', line: 2,
          detail: 'Broken branch', evidence: 'diff line', confidence: 'high' }],
        metrics: { filesInspected: 1, findingsProposed: 1 },
      }),
    },
    {
      match: 'review-summary-1',
      respond: () => ({ taskId: 'review-summary-1', summary: 'covered', candidates: [],
        metrics: { filesInspected: 1, findingsProposed: 0 } }),
    },
    {
      match: 'audit',
      respond: (prompt) => ({ summary: 'audited', verdicts: extractAuditCandidates(prompt).map((candidate) => ({
        candidateId: candidate.candidateId, status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' })) }),
    },
  ]
}

async function renderOnce() {
  let source = await readFile(new URL('../workflows/dakar-review.js', import.meta.url), 'utf8')
  source = source.replace(/^export const meta\s*=/mu, 'const meta =')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const body = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'validate', 'sleep', source)
  const prompts = new Map()
  const agentLabels = []
  const head = 'b'.repeat(40)
  const base = 'a'.repeat(40)
  const prepared = { ok: true, stateFile: '/tmp/reviews.toml', reviewBase: base, headCommit: head,
    commitCount: 1, changedFiles: ['src/a.js'], diffStat: '1 file changed', warnings: [] }
  const agent = buildAgentMock(renderingResponders(), { prompts, agentLabels })
  const swallowFixtureFailure = (error) => {
    if (error instanceof FixtureFailure) return null
    throw error
  }
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(swallowFixtureFailure)))
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, index) => {
    try {
      let value = item
      for (const stage of stages) value = await stage(value, item, index)
      return value
    } catch (error) {
      return swallowFixtureFailure(error)
    }
  }))
  const result = await body(agent, parallel, pipeline, () => {}, () => {},
    { config: '/distinct/policy.yaml', stateRoot: '', prepared },
    { total: null, spent: () => 0, remaining: () => 0 }, async () => null,
    () => ({ ok: true, meta: null, errors: [], warnings: [] }), async () => {})
  return { agentLabels, result }
}

test('deterministic rendering is byte-stable across identical runs', async () => {
  const first = await renderOnce()
  const second = await renderOnce()

  assert.equal(first.result.ok, true)
  assert.equal(second.result.ok, true)
  assert.equal(first.agentLabels.includes('synthesis'), false)
  assert.equal(typeof first.result.reportMarkdown, 'string')
  assert.equal(first.result.reportMarkdown, second.result.reportMarkdown)
})

test('deterministic report renders the expected sections for a known accepted candidate', async () => {
  const { result } = await renderOnce()

  assert.equal(result.ok, true)
  assert.match(result.reportMarkdown, /^## high: Bug$/mu)
  assert.match(result.reportMarkdown, /^src\/a\.js:2$/mu)
  assert.match(result.reportMarkdown, /^Evidence: diff line$/mu)
})
