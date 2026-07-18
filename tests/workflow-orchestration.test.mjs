/** @file Drive the generated workflow through deterministic injected primitives. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildAgentMock, extractCandidateJson, FixtureFailure } from './helpers/mock-agents.mjs'

function defaultResponders({ failedLabel, recordFailures, collidingCandidates, head,
  candidateTitles, summaryCandidateTitles, verdictTransform, synthesisMetrics, recordResult, recordResults }) {
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
    {
      match: 'synthesis',
      respond: () => ({ verdict: 'changes-requested', summary: 'one', reportMarkdown: '# Review', findings: [{}], metrics: synthesisMetrics }),
    },
    {
      match: (label) => label.startsWith('state-record-'),
      respond: (_prompt, options) => {
        const attempt = Number(options.label.split('-').at(-1))
        if (attempt <= recordFailures) throw new FixtureFailure('record fixture failure')
        return recordResults?.[attempt - 1] ?? recordResult ??
          { ok: true, stateFile: '/trusted/state/dakar/reviews.toml', headCommit: head }
      },
    },
  ]
}

async function runWorkflow({ failedLabel, recordFailures = 0, collidingCandidates = false, prepareStateFile = '/tmp/reviews.toml', stateRoot = '', commitLength = 40, config = '/distinct/policy.yaml', recordResult, recordResults, candidateTitles, summaryCandidateTitles = [], maxFindings, verdictTransform, synthesisMetrics = {} } = {}) {
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
  const agent = buildAgentMock(defaultResponders({ failedLabel, recordFailures, collidingCandidates, head,
    candidateTitles, summaryCandidateTitles, verdictTransform, synthesisMetrics, recordResult, recordResults }), { prompts, agentLabels })
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
    'verify-source-1:src/a.js:2:bug-1', 'synthesis', 'state-record-1',
  ])
  assert.deepEqual(phases, ['Plan', 'Review', 'Verify', 'Synthesize', 'Record'])
  assert.equal(result.recordAttempts, 1)
  for (const [label, prompt] of prompts) {
    assert.match(prompt, /\/distinct\/policy\.yaml/u, `${label} should receive the resolved policy path`)
    assert.doesNotMatch(prompt, /CodeRabbit YAML: auto/u)
  }
})

for (const [label, stage] of [
  ['synthesis', 'synthesize'],
]) {
  test(`generated workflow tags a rejected ${stage} agent call`, async () => {
    const { agentLabels, result } = await runWorkflow({ failedLabel: label })

    assert.deepEqual(result, { ok: false, stage, error: 'fixture failure' })
    assert.equal(agentLabels.at(-1), label)
  })
}

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

test('generated workflow does not trust synthesis-provided metrics', async () => {
  const { result } = await runWorkflow({ synthesisMetrics: { attackerControlled: true, taskCount: 999 } })

  assert.equal(result.metrics.attackerControlled, undefined)
  assert.equal(result.metrics.taskCount, result.taskGraph.length)
})

test('generated workflow retries an incomplete successful record acknowledgement', async () => {
  const { agentLabels, result } = await runWorkflow({ recordResults: [
    { ok: true, stateFile: '/trusted/state/dakar/reviews.toml' },
    { ok: true, stateFile: '/trusted/state/dakar/reviews.toml', headCommit: 'b'.repeat(40) },
  ] })

  assert.equal(result.ok, true)
  assert.equal(result.recordAttempts, 2)
  assert.deepEqual(agentLabels.slice(-2), ['state-record-1', 'state-record-2'])
})

test('generated workflow exhausts retries for repeated malformed successful acknowledgements', async () => {
  const malformed = { ok: true, stateFile: '/trusted/state/dakar/reviews.toml' }
  const { agentLabels, result } = await runWorkflow({ recordResult: malformed })

  assert.equal(result.ok, false)
  assert.equal(result.recordAttempts, 3)
  assert.deepEqual(agentLabels.slice(-3), ['state-record-1', 'state-record-2', 'state-record-3'])
})

test('generated workflow never passes a manipulated prepare state file to the record helper', async () => {
  const manipulated = '/tmp/outside/reviews.toml'
  const { prompts, result } = await runWorkflow({ prepareStateFile: manipulated, stateRoot: '/trusted/state' })
  const prompt = prompts.get('state-record-1')

  assert.doesNotMatch(prompt, new RegExp(manipulated, 'u'))
  assert.match(prompt, /record --repo-root '\.' --state-root '\/trusted\/state'/u)
  assert.equal(result.recordInput.stateFile, undefined)
  assert.equal(result.stateFile, '/trusted/state/dakar/reviews.toml')
})

test('generated workflow retries review-history recording and reports the attempt count', async () => {
  const { agentLabels, logs, result, sleepDelays } = await runWorkflow({ recordFailures: 1 })

  assert.equal(result.ok, true)
  assert.equal(result.recordAttempts, 2)
  assert.deepEqual(agentLabels.slice(-2), ['state-record-1', 'state-record-2'])
  assert.deepEqual(logs, ['Review-history recording attempt 2 of 3 after an unsuccessful attempt.'])
  assert.deepEqual(sleepDelays, [100])
})

test('generated workflow returns its fallback after exhausting record retries', async () => {
  const { agentLabels, logs, result, sleepDelays } = await runWorkflow({ recordFailures: 3 })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'record')
  assert.equal(result.recordAttempts, 3)
  assert.deepEqual(agentLabels.slice(-3), ['state-record-1', 'state-record-2', 'state-record-3'])
  assert.equal(logs.length, 2)
  assert.deepEqual(sleepDelays, [100, 200])
})

test('generated workflow accepts a complete matching 64-character record acknowledgement', async () => {
  const { result } = await runWorkflow({ commitLength: 64 })

  assert.equal(result.ok, true)
  assert.equal(result.recorded.headCommit, 'b'.repeat(64))
})

for (const [name, recordResult] of [
  ['missing state file', { ok: true, headCommit: 'b'.repeat(40) }],
  ['blank state file', { ok: true, stateFile: '   ', headCommit: 'b'.repeat(40) }],
  ['missing head commit', { ok: true, stateFile: '/trusted/state/dakar/reviews.toml' }],
  ['mismatched head commit', { ok: true, stateFile: '/trusted/state/dakar/reviews.toml', headCommit: 'c'.repeat(40) }],
]) {
  test(`generated workflow fails closed on a record acknowledgement with ${name}`, async () => {
    const { result } = await runWorkflow({ recordResult })

    assert.equal(result.ok, false)
    assert.equal(result.stage, 'record')
  })
}

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
