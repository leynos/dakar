/** @file Drive the generated workflow through deterministic injected primitives. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

class FixtureFailure extends Error {}

async function runWorkflow({ failedLabel } = {}) {
  let source = await readFile(new URL('../workflows/dakar-review.js', import.meta.url), 'utf8')
  source = source.replace(/^export const meta\s*=/mu, 'const meta =')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const body = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'validate', source)
  const prompts = new Map()
  const agentLabels = []
  const phases = []
  const head = 'b'.repeat(40)
  const base = 'a'.repeat(40)
  const agent = async (prompt, options = {}) => {
    agentLabels.push(options.label)
    assert.equal(prompts.has(options.label), false, `duplicate agent label: ${options.label}`)
    prompts.set(options.label, prompt)
    if (options.label === failedLabel) throw new FixtureFailure('fixture failure')
    if (options.label === 'config-resolve') return { ok: true, config: '/distinct/policy.yaml' }
    if (options.label === 'state-prepare') {
      return { ok: true, stateFile: '/tmp/reviews.toml', reviewBase: base, headCommit: head,
        commitCount: 1, changedFiles: ['src/a.js'], diffStat: '1 file changed', warnings: [] }
    }
    if (options.label === 'source-1') {
      return { taskId: 'source-1', summary: 'candidate', candidates: [{ title: 'Bug', severity: 'high',
        path: 'src/a.js', line: 2, detail: 'Broken branch', evidence: 'diff line', confidence: 'high' }],
        metrics: { filesInspected: 1, findingsProposed: 1 } }
    }
    if (options.label === 'review-summary-1') {
      return { taskId: 'review-summary-1', summary: 'covered', candidates: [],
        metrics: { filesInspected: 1, findingsProposed: 0 } }
    }
    if (String(options.label).startsWith('verify-')) {
      const candidateId = JSON.parse(prompt.split('Candidate JSON:\n')[1].split('\n\nRepository root:')[0]).candidateId
      return { candidateId, status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' }
    }
    if (options.label === 'synthesis') {
      return { verdict: 'changes-requested', summary: 'one', reportMarkdown: '# Review', findings: [{}], metrics: {} }
    }
    if (options.label === 'state-record-1') return { ok: true }
    throw new Error(`unexpected agent label: ${options.label}`)
  }
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
  const result = await body(agent, parallel, pipeline, (name) => phases.push(name), () => {}, {},
    { total: null, spent: () => 0, remaining: () => 0 }, async () => null,
    () => ({ ok: true, meta: null, errors: [], warnings: [] }))
  return { agentLabels, phases, prompts, result }
}

test('generated workflow threads the resolved policy path through every downstream prompt', async () => {
  const { agentLabels, phases, prompts, result } = await runWorkflow()
  assert.equal(result.ok, true)
  assert.deepEqual(agentLabels, [
    'config-resolve', 'state-prepare', 'source-1', 'review-summary-1',
    'verify-source-1:src/a.js:2:bug', 'synthesis', 'state-record-1',
  ])
  assert.deepEqual(phases, ['Resolve Config', 'Prepare', 'Plan', 'Review', 'Verify', 'Synthesize', 'Record'])
  for (const [label, prompt] of prompts) {
    if (label !== 'config-resolve') {
      assert.match(prompt, /\/distinct\/policy\.yaml/u, `${label} should receive the resolved policy path`)
      assert.doesNotMatch(prompt, /CodeRabbit YAML: auto/u)
    }
  }
})

test('generated workflow filters failed parallel slots and reports incomplete coverage', async () => {
  const { result } = await runWorkflow({ failedLabel: 'review-summary-1' })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'review')
  assert.deepEqual(result.failedTaskIds, ['review-summary-1'])
})
