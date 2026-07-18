/** @file Drive the generated workflow through deterministic injected primitives. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildAgentMock, extractCandidateJson, FixtureFailure } from './helpers/mock-agents.mjs'

function defaultResponders({ failedLabel, collidingCandidates,
  candidateTitles, summaryCandidateTitles, verdictTransform }) {
  return [
    { match: (label) => label === failedLabel, respond: () => { throw new FixtureFailure('fixture failure') } },
    {
      match: 'source-1',
      respond: () => {
        const titles = candidateTitles ?? (collidingCandidates
          ? [`${'same-prefix-'.repeat(5)}first`, `${'same-prefix-'.repeat(5)}second`]
          : ['Bug'])
        return { taskId: 'source-1', summary: 'candidate', candidates: titles.map((title) => ({ title, severity: 'high',
          path: 'src/a.js', line: 2, detail: 'Broken branch', evidence: 'diff line', confidence: 'high' })),
          metrics: { filesInspected: 1, findingsProposed: 1 } }
      },
    },
    {
      match: 'review-summary-1',
      respond: () => ({ taskId: 'review-summary-1', summary: 'covered', candidates: summaryCandidateTitles.map((title) => ({
        title, severity: 'high', path: 'src/a.js', line: 3, detail: 'Summary branch', evidence: 'diff line', confidence: 'high',
      })), metrics: { filesInspected: 1, findingsProposed: summaryCandidateTitles.length } }),
    },
    {
      match: (label) => label.startsWith('verify-'),
      respond: (prompt) => {
        const candidateId = extractCandidateJson(prompt).candidateId
        return { candidateId: verdictTransform ? verdictTransform(candidateId) : candidateId,
          status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' }
      },
    },
  ]
}

async function runWorkflow({ failedLabel, collidingCandidates = false, prepareStateFile = '/tmp/reviews.toml', stateRoot = '', commitLength = 40, config = '/distinct/policy.yaml', candidateTitles, summaryCandidateTitles = [], maxFindings, verdictTransform } = {}) {
  let source = await readFile(new URL('../workflows/dakar-review.js', import.meta.url), 'utf8')
  source = source.replace(/^export const meta\s*=/mu, 'const meta =')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const body = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'validate', 'sleep', source)
  const prompts = new Map()
  const agentLabels = []
  const phases = []
  const logs = []
  const sleepDelays = []
  const head = 'b'.repeat(commitLength)
  const base = 'a'.repeat(commitLength)
  const prepared = { ok: true, stateFile: prepareStateFile, reviewBase: base, headCommit: head,
    commitCount: 1, changedFiles: ['src/a.js'], diffStat: '1 file changed', warnings: [] }
  const agent = buildAgentMock(defaultResponders({ failedLabel, collidingCandidates,
    candidateTitles, summaryCandidateTitles, verdictTransform }), { prompts, agentLabels })
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
  const result = await body(agent, parallel, pipeline, (name) => phases.push(name), (message) => logs.push(message),
    { config, stateRoot, prepared, ...(maxFindings === undefined ? {} : { maxFindings }) },
    { total: null, spent: () => 0, remaining: () => 0 }, async () => null,
    () => ({ ok: true, meta: null, errors: [], warnings: [] }), async (milliseconds) => { sleepDelays.push(milliseconds) })
  return { agentLabels, logs, phases, prompts, result, sleepDelays }
}

test('generated workflow threads the resolved policy path through every downstream prompt', async () => {
  const { agentLabels, phases, prompts, result } = await runWorkflow()
  assert.equal(result.ok, true)
  assert.deepEqual(agentLabels, [
    'source-1', 'review-summary-1',
    'verify-source-1:src/a.js:2:bug-1',
  ])
  assert.deepEqual(phases, ['Plan', 'Review', 'Verify'])
  for (const [label, prompt] of prompts) {
    assert.match(prompt, /\/distinct\/policy\.yaml/u, `${label} should receive the resolved policy path`)
    assert.doesNotMatch(prompt, /CodeRabbit YAML: auto/u)
  }
})

test('generated workflow no longer calls a record agent and defers recording to the CLI', async () => {
  const { agentLabels, phases, result } = await runWorkflow()

  assert.equal(result.ok, true)
  assert.equal(agentLabels.some((label) => label.startsWith('state-record')), false)
  assert.equal(phases.includes('Record'), false)
  assert.equal(phases.at(-1), 'Verify')
  assert.equal(result.recorded, undefined)
  assert.equal(result.recordAttempts, undefined)
  assert.equal(result.stateFile, undefined)
  assert.equal(result.stage, undefined)
  assert.ok(result.recordInput, 'workflow still emits recordInput for the CLI to record')
})

test('generated workflow recordInput headCommit matches the prepared head commit', async () => {
  for (const commitLength of [40, 64]) {
    const { result } = await runWorkflow({ commitLength })
    assert.equal(result.ok, true)
    assert.equal(result.recordInput.headCommit, 'b'.repeat(commitLength))
    assert.equal(result.recordInput.baseCommit, 'a'.repeat(commitLength))
  }
})

test('generated workflow rejects verifier verdicts returned for a different scheduled candidate', async () => {
  const ids = []
  const { result } = await runWorkflow({
    candidateTitles: ['First', 'Second'],
    verdictTransform: (candidateId) => {
      ids.push(candidateId)
      return ids.length === 1 ? candidateId.replace(/first$/u, 'second') : candidateId.replace(/second$/u, 'first')
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'verify')
})

test('generated workflow rejects duplicate returned verifier candidate ids', async () => {
  let firstId
  const { result } = await runWorkflow({
    candidateTitles: ['First', 'Second'],
    verdictTransform: (candidateId) => {
      firstId ??= candidateId
      return firstId
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'verify')
})

test('generated workflow records accepted overflow as discarded after reconciliation', async () => {
  const { result } = await runWorkflow({ candidateTitles: ['Alpha'], summaryCandidateTitles: ['Beta'], maxFindings: 1 })

  assert.equal(result.findings.length, 1)
  assert.equal(result.discarded.filter(({ status }) => status === 'max_findings_exceeded').length, 1)
  assert.equal(result.metrics.confirmedFindings, 1)
  assert.equal(result.metrics.discardedFindings, 1)
})

test('generated workflow computes metrics host-side without a synthesis agent call', async () => {
  const { agentLabels, result } = await runWorkflow()

  assert.equal(agentLabels.includes('synthesis'), false)
  assert.equal(result.metrics.attackerControlled, undefined)
  assert.equal(result.metrics.taskCount, result.taskGraph.length)
  assert.equal(result.metrics.confirmedFindings, result.findings.length)
})

test('generated workflow gives colliding truncated candidate ids distinct verifier labels', async () => {
  const { agentLabels, result } = await runWorkflow({ collidingCandidates: true })
  const verifierLabels = agentLabels.filter((label) => label.startsWith('verify-'))

  assert.equal(result.ok, true)
  assert.equal(verifierLabels.length, 2)
  assert.equal(new Set(verifierLabels).size, 2)
  assert.ok(verifierLabels.every((label) => label.length <= 42))
})

test('generated workflow filters failed parallel slots and reports incomplete coverage', async () => {
  const { result } = await runWorkflow({ failedLabel: 'review-summary-1' })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'review')
  assert.deepEqual(result.failedTaskIds, ['review-summary-1'])
})
