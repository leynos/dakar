/** @file Drive the generated workflow through deterministic injected primitives. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildAgentMock, extractAuditCandidates, FixtureFailure } from './helpers/mock-agents.mjs'

// The default audit responder accepts every compacted candidate it is handed,
// echoing one verdict per candidate id. Tests override `auditVerdicts` to craft
// unknown-id, duplicate, missing, cluster, or failing audits.
function defaultResponders({ failedLabel, collidingCandidates,
  candidateTitles, summaryCandidateTitles, auditVerdicts, auditFails }) {
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
      match: 'audit',
      respond: (prompt) => {
        if (auditFails) throw new FixtureFailure('audit fixture failure')
        const candidates = extractAuditCandidates(prompt)
        const verdicts = auditVerdicts
          ? auditVerdicts(candidates)
          : candidates.map((candidate) => ({ candidateId: candidate.candidateId,
              status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' }))
        return { verdicts, summary: 'audited' }
      },
    },
  ]
}

async function runWorkflow({ failedLabel, collidingCandidates = false, prepareStateFile = '/tmp/reviews.toml', stateRoot = '', commitLength = 40, config = '/distinct/policy.yaml', candidateTitles, summaryCandidateTitles = [], maxFindings, maxAuditCandidates, auditVerdicts, auditFails } = {}) {
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
    candidateTitles, summaryCandidateTitles, auditVerdicts, auditFails }), { prompts, agentLabels })
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
    { config, stateRoot, prepared, ...(maxFindings === undefined ? {} : { maxFindings }), ...(maxAuditCandidates === undefined ? {} : { maxAuditCandidates }) },
    { total: null, spent: () => 0, remaining: () => 0 }, async () => null,
    () => ({ ok: true, meta: null, errors: [], warnings: [] }), async (milliseconds) => { sleepDelays.push(milliseconds) })
  return { agentLabels, logs, phases, prompts, result, sleepDelays }
}

test('generated workflow threads the resolved policy path through every downstream prompt', async () => {
  const { agentLabels, phases, prompts, result } = await runWorkflow()
  assert.equal(result.ok, true)
  assert.deepEqual(agentLabels, ['source-1', 'review-summary-1', 'audit'])
  assert.deepEqual(phases, ['Plan', 'Review', 'Audit'])
  for (const [label, prompt] of prompts) {
    assert.match(prompt, /\/distinct\/policy\.yaml/u, `${label} should receive the resolved policy path`)
    assert.doesNotMatch(prompt, /CodeRabbit YAML: auto/u)
  }
})

test('generated workflow issues exactly one audit call for a multi-candidate review', async () => {
  const { agentLabels, result } = await runWorkflow({ candidateTitles: ['First', 'Second'], summaryCandidateTitles: ['Third'] })

  assert.equal(result.ok, true)
  assert.equal(agentLabels.filter((label) => label === 'audit').length, 1)
  assert.equal(agentLabels.some((label) => label.startsWith('verify-')), false)
  assert.equal(result.findings.length, 3)
})

test('generated workflow no longer calls a record agent and defers recording to the CLI', async () => {
  const { agentLabels, phases, result } = await runWorkflow()

  assert.equal(result.ok, true)
  assert.equal(agentLabels.some((label) => label.startsWith('state-record')), false)
  assert.equal(phases.includes('Record'), false)
  assert.equal(phases.at(-1), 'Audit')
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

test('generated workflow counts an unknown-id audit verdict without crashing', async () => {
  const { result } = await runWorkflow({
    auditVerdicts: (candidates) => [
      ...candidates.map((candidate) => ({ candidateId: candidate.candidateId, status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' })),
      { candidateId: 'ghost-candidate-that-was-never-scheduled', status: 'accepted', reason: 'noise', evidenceChecked: 'none' },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.metrics.unknownAuditVerdictCount, 1)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings.every((finding) => finding.title === 'Bug'), true)
})

test('generated workflow keeps the first verdict when the audit repeats a candidate id', async () => {
  const { result } = await runWorkflow({
    auditVerdicts: (candidates) => [
      { candidateId: candidates[0].candidateId, status: 'accepted', reason: 'first wins', evidenceChecked: 'git object' },
      { candidateId: candidates[0].candidateId, status: 'not_applicable', reason: 'should be ignored', evidenceChecked: 'git object' },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
  assert.equal(result.metrics.duplicateAuditVerdictCount, 1)
})

test('generated workflow fails closed when the audit omits a verdict for a candidate', async () => {
  const { result } = await runWorkflow({
    candidateTitles: ['First', 'Second'],
    auditVerdicts: (candidates) => [
      { candidateId: candidates[0].candidateId, status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' },
    ],
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'audit')
  assert.match(result.error, /verdict for every candidate/u)
  assert.equal(result.recordInput, undefined)
})

test('generated workflow records over-cap candidates as over_audit_cap discards', async () => {
  const { agentLabels, result } = await runWorkflow({
    candidateTitles: ['First', 'Second', 'Third'],
    maxAuditCandidates: 2,
  })

  assert.equal(result.ok, true)
  assert.equal(agentLabels.filter((label) => label === 'audit').length, 1)
  assert.equal(result.metrics.auditCandidateCount, 2)
  assert.equal(result.metrics.overAuditCapCount, 1)
  assert.equal(result.discarded.filter(({ status }) => status === 'over_audit_cap').length, 1)
})

test('generated workflow propagates audit clusterId onto accepted findings', async () => {
  const { result } = await runWorkflow({
    candidateTitles: ['First', 'Second'],
    auditVerdicts: (candidates) => candidates.map((candidate) => ({
      candidateId: candidate.candidateId, status: 'accepted', reason: 'confirmed',
      evidenceChecked: 'git object', clusterId: 'cluster-shared',
    })),
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 2)
  assert.equal(result.findings.every((finding) => finding.clusterId === 'cluster-shared'), true)
})

test('generated workflow issues zero audit calls and succeeds when no candidates survive', async () => {
  const { agentLabels, result } = await runWorkflow({ candidateTitles: [], summaryCandidateTitles: [] })

  assert.equal(result.ok, true)
  assert.equal(agentLabels.includes('audit'), false)
  assert.equal(result.findings.length, 0)
  assert.equal(result.metrics.auditCandidateCount, 0)
  assert.ok(result.recordInput, 'a zero-finding review is still a recordable success')
})

test('generated workflow applies the severity_downgrade lowering rule during re-pairing', async () => {
  const { result } = await runWorkflow({
    auditVerdicts: (candidates) => candidates.map((candidate) => ({
      // A downgrade that does not strictly lower severity is invalid and must
      // fail the required audit closed rather than silently accept.
      candidateId: candidate.candidateId, status: 'severity_downgraded',
      acceptedSeverity: 'critical', reason: 'bogus downgrade', evidenceChecked: 'git object',
    })),
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'audit')
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
  assert.equal(result.metrics.routingPolicy, 'deterministic-flex-v1')
})

test('generated workflow filters failed parallel slots and reports incomplete coverage', async () => {
  const { result } = await runWorkflow({ failedLabel: 'review-summary-1' })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'review')
  assert.deepEqual(result.failedTaskIds, ['review-summary-1'])
})
