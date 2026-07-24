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
import test from 'node:test'
import { extractAuditCandidates } from './helpers/mock-agents.mjs'
import { runCompiledWorkflow } from './helpers/run-workflow.mjs'

function renderingResponders() {
  return [
    {
      match: (label) => /^luna-flex-\d+$/u.test(label),
      respond: (_prompt, options) => ({
        taskId: options.label, summary: 'candidate',
        candidates: [{ title: 'Bug', severity: 'high', path: 'src/a.js', line: 2,
          detail: 'Broken branch', evidence: 'diff line', confidence: 'high' }],
        metrics: { filesInspected: 1, findingsProposed: 1 },
      }),
    },
    {
      match: 'audit',
      respond: (prompt) => ({ summary: 'audited', verdicts: extractAuditCandidates(prompt).map((candidate) => ({
        candidateId: candidate.candidateId, status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' })) }),
    },
  ]
}

async function renderOnce() {
  const head = 'b'.repeat(40)
  const base = 'a'.repeat(40)
  const prepared = { ok: true, stateFile: '/tmp/reviews.toml', reviewBase: base, headCommit: head,
    commitCount: 1, changedFiles: ['src/a.js'], diffStat: '1 file changed', warnings: [] }
  return runCompiledWorkflow({
    responders: renderingResponders(),
    prepared,
    args: { config: '/distinct/policy.yaml', stateRoot: '' },
  })
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
