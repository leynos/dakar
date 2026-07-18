/** @file Drive the generated Flex-lane workflow through injected primitives. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildAgentMock, extractAuditCandidates, extractTaskFiles, FixtureFailure } from './helpers/mock-agents.mjs'
import { deterministicJitter } from '../src/workflows/dakar-review/retry.ts'

// Finder packs (labels `luna-flex-<n>`) emit one candidate per assigned file by
// default; tests override `finderTitles` to craft multi-candidate packs. The
// audit responder accepts every compacted candidate unless `auditVerdicts`
// overrides it.
function defaultResponders({ failedLabel, finderTitles, auditVerdicts, auditFails, finderFailures = 0, auditFailures = 0 }) {
  // Per-label transient failure counters give each finder pack and the audit
  // their own "fail N attempts then succeed" state, so the retry helper's
  // deterministic schedule can be exercised without a shared counter leaking
  // across labels.
  const finderAttempts = new Map()
  let auditAttempts = 0
  return [
    { match: (label) => label === failedLabel, respond: () => { throw new FixtureFailure('fixture failure') } },
    {
      match: (label) => /^luna-flex-\d+$/u.test(label),
      respond: (prompt, options) => {
        const seen = finderAttempts.get(options.label) ?? 0
        if (seen < finderFailures) {
          finderAttempts.set(options.label, seen + 1)
          throw new FixtureFailure(`finder transient failure ${seen + 1} for ${options.label}`)
        }
        const files = extractTaskFiles(prompt)
        const path = files[0] ?? 'src/a.js'
        const titles = finderTitles ?? ['Bug']
        return {
          taskId: options.label,
          summary: 'candidate',
          candidates: titles.map((title) => ({
            title, severity: 'high', path, line: 2, detail: 'Broken branch', evidence: 'diff line', confidence: 'high',
          })),
          metrics: { filesInspected: files.length, findingsProposed: titles.length },
        }
      },
    },
    {
      match: 'audit',
      respond: (prompt) => {
        if (auditFails) throw new FixtureFailure('audit fixture failure')
        if (auditAttempts < auditFailures) {
          auditAttempts += 1
          throw new FixtureFailure(`audit transient failure ${auditAttempts}`)
        }
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

async function runWorkflow({
  failedLabel, changedFiles = ['src/a.js'], config = '/distinct/policy.yaml', commitLength = 40,
  finderTitles, auditVerdicts, auditFails, finderFailures, auditFailures, knobs = {},
} = {}) {
  let source = await readFile(new URL('../workflows/dakar-review.js', import.meta.url), 'utf8')
  source = source.replace(/^export const meta\s*=/mu, 'const meta =')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const body = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'validate', 'sleep', source)
  const prompts = new Map()
  const agentLabels = []
  const agentCalls = []
  const phases = []
  const logs = []
  const sleepDelays = []
  const head = 'b'.repeat(commitLength)
  const base = 'a'.repeat(commitLength)
  const prepared = { ok: true, stateFile: '/tmp/reviews.toml', reviewBase: base, headCommit: head,
    commitCount: 1, changedFiles, diffStat: '1 file changed', warnings: [] }
  const agent = buildAgentMock(defaultResponders({ failedLabel, finderTitles, auditVerdicts, auditFails, finderFailures, auditFailures }),
    { prompts, agentLabels, agentCalls })
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
    { config, prepared, ...knobs },
    { total: null, spent: () => 0, remaining: () => 0 }, async () => null,
    () => ({ ok: true, meta: null, errors: [], warnings: [] }), async (milliseconds) => { sleepDelays.push(milliseconds) })
  return { agentLabels, agentCalls, logs, phases, prompts, result, sleepDelays }
}

const finderLabels = (labels) => labels.filter((label) => /^luna-flex-\d+$/u.test(label))

test('finder packs route through the Luna adapter and the audit through Terra', async () => {
  const { agentCalls, phases, result } = await runWorkflow()

  assert.equal(result.ok, true)
  assert.deepEqual(phases, ['Plan', 'Review', 'Audit'])
  const finderCalls = agentCalls.filter((call) => /^luna-flex-\d+$/u.test(call.label))
  assert.equal(finderCalls.length, 1)
  assert.equal(finderCalls.every((call) => call.adapter === 'pi-luna-flex'), true)
  assert.equal(finderCalls.every((call) => call.model === 'gpt-5.6-luna'), true)
  const auditCall = agentCalls.find((call) => call.label === 'audit')
  assert.equal(auditCall.adapter, 'pi-terra-flex')
  assert.equal(auditCall.model, 'gpt-5.6-terra')
})

test('the finder plan never exceeds maxLunaFlexCalls and surfaces truncation', async () => {
  const changedFiles = Array.from({ length: 6 }, (_, index) => `src/module-${index}.js`)
  const { agentCalls, result } = await runWorkflow({
    changedFiles,
    // Deterministic per-call worst case: cap input at 1 token so the flat
    // overhead dominates; a generous budget admits all four packs.
    knobs: { budgetGbp: 0.12, transactionMaxFiles: 1, transactionMaxInputTokens: 1, adapterOverheadTokens: 13000 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.taskGraph.length, 4, 'the plan is bounded at maxLunaFlexCalls packs')
  assert.equal(finderLabels(agentCalls.map((call) => call.label)).length, 4)
  assert.equal(result.metrics.truncatedFileCount, 2)
  assert.deepEqual(result.metrics.truncatedFiles, changedFiles.slice(4))
})

test('a budget too small for the audit reserve fails before any finder call', async () => {
  const { agentLabels, result } = await runWorkflow({ knobs: { budgetGbp: 0.01 } })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'admission')
  assert.equal(agentLabels.length, 0, 'reserve-first: no model call runs when the audit cannot be reserved')
})

test('a refused Luna pack is skipped with a structured refusal while the audit still runs', async () => {
  const { agentLabels, result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js'],
    // Budget fits the reserve plus exactly one deterministic Luna pack.
    knobs: { budgetGbp: 0.085, transactionMaxFiles: 1, transactionMaxInputTokens: 1, adapterOverheadTokens: 13000 },
  })

  assert.equal(result.ok, true)
  assert.equal(finderLabels(agentLabels).length, 1, 'only the admitted pack runs a model call')
  assert.equal(result.admissionRefusals.length, 1)
  assert.equal(result.admissionRefusals[0].kind, 'luna-transaction')
  assert.match(result.admissionRefusals[0].reason, /budget/u)
  assert.equal(result.metrics.admissionRefusalCount, 1)
  assert.ok(agentLabels.includes('audit'), 'the reserved audit still runs after a refusal')
})

test('the ledger records every admitted call with the pricing-table version', async () => {
  const { result } = await runWorkflow()

  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.metrics.ledger))
  assert.equal(result.metrics.ledger.length, 2, 'one Luna finder plus one Terra audit')
  const luna = result.metrics.ledger.find((entry) => entry.lane === 'luna-flex')
  const terra = result.metrics.ledger.find((entry) => entry.lane === 'terra-flex')
  assert.equal(luna.model, 'gpt-5.6-luna')
  assert.equal(luna.serviceTier, 'flex')
  assert.equal(luna.reasoningEffort, 'low')
  assert.equal(luna.attempts, 1)
  assert.equal(luna.reportedUsage, undefined)
  assert.equal(luna.reportedUsd, undefined)
  assert.equal(terra.model, 'gpt-5.6-terra')
  assert.equal(terra.reasoningEffort, 'medium')
  for (const entry of result.metrics.ledger) {
    assert.equal(entry.pricingTableVersion, '2026-07-18')
    assert.ok(entry.estimatedWorstCaseUsd > 0)
  }
  const sum = result.metrics.ledger.reduce((total, entry) => total + entry.estimatedWorstCaseUsd, 0)
  assert.ok(Math.abs(result.metrics.ledgerTotalEstimatedUsd - sum) < 1e-9)
})

test('the resolved policy path threads through every finder and audit prompt', async () => {
  const { prompts, result } = await runWorkflow()
  assert.equal(result.ok, true)
  for (const [label, prompt] of prompts) {
    assert.match(prompt, /\/distinct\/policy\.yaml/u, `${label} should receive the resolved policy path`)
  }
})

test('the workflow defers recording to the CLI and emits recordInput', async () => {
  const { agentLabels, phases, result } = await runWorkflow()

  assert.equal(result.ok, true)
  assert.equal(phases.at(-1), 'Audit')
  assert.equal(agentLabels.some((label) => label.startsWith('state-record')), false)
  assert.equal(result.recorded, undefined)
  assert.equal(result.stateFile, undefined)
  assert.ok(result.recordInput, 'workflow still emits recordInput for the CLI to record')
})

test('recordInput echoes the prepared head commit for either commit length', async () => {
  for (const commitLength of [40, 64]) {
    const { result } = await runWorkflow({ commitLength })
    assert.equal(result.ok, true)
    assert.equal(result.recordInput.headCommit, 'b'.repeat(commitLength))
    assert.equal(result.recordInput.baseCommit, 'a'.repeat(commitLength))
  }
})

test('an unknown-id audit verdict is counted without crashing', async () => {
  const { result } = await runWorkflow({
    auditVerdicts: (candidates) => [
      ...candidates.map((candidate) => ({ candidateId: candidate.candidateId, status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' })),
      { candidateId: 'ghost-candidate', status: 'accepted', reason: 'noise', evidenceChecked: 'none' },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.metrics.unknownAuditVerdictCount, 1)
  assert.equal(result.findings.length, 1)
})

test('a repeated candidate id keeps the first audit verdict', async () => {
  const { result } = await runWorkflow({
    auditVerdicts: (candidates) => [
      { candidateId: candidates[0].candidateId, status: 'accepted', reason: 'first wins', evidenceChecked: 'git object' },
      { candidateId: candidates[0].candidateId, status: 'not_applicable', reason: 'ignored', evidenceChecked: 'git object' },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
  assert.equal(result.metrics.duplicateAuditVerdictCount, 1)
})

test('the audit fails closed when it omits a verdict for a candidate', async () => {
  const { result } = await runWorkflow({
    finderTitles: ['First', 'Second'],
    auditVerdicts: (candidates) => [
      { candidateId: candidates[0].candidateId, status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object' },
    ],
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'audit')
  assert.match(result.error, /verdict for every candidate/u)
  assert.equal(result.recordInput, undefined)
})

test('over-cap candidates become over_audit_cap discards', async () => {
  const { agentLabels, result } = await runWorkflow({
    finderTitles: ['First', 'Second', 'Third'],
    knobs: { maxAuditCandidates: 2 },
  })

  assert.equal(result.ok, true)
  assert.equal(agentLabels.filter((label) => label === 'audit').length, 1)
  assert.equal(result.metrics.auditCandidateCount, 2)
  assert.equal(result.metrics.overAuditCapCount, 1)
  assert.equal(result.discarded.filter(({ status }) => status === 'over_audit_cap').length, 1)
})

test('audit clusterId propagates onto accepted findings', async () => {
  const { result } = await runWorkflow({
    finderTitles: ['First', 'Second'],
    auditVerdicts: (candidates) => candidates.map((candidate) => ({
      candidateId: candidate.candidateId, status: 'accepted', reason: 'confirmed', evidenceChecked: 'git object', clusterId: 'cluster-shared',
    })),
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 2)
  assert.equal(result.findings.every((finding) => finding.clusterId === 'cluster-shared'), true)
})

test('zero surviving candidates issue zero audit calls and still record', async () => {
  const { agentLabels, result } = await runWorkflow({ finderTitles: [] })

  assert.equal(result.ok, true)
  assert.equal(agentLabels.includes('audit'), false)
  assert.equal(result.findings.length, 0)
  assert.equal(result.metrics.auditCandidateCount, 0)
  assert.equal(result.metrics.ledger.filter((entry) => entry.lane === 'terra-flex').length, 0)
  assert.ok(result.recordInput, 'a zero-finding review is still a recordable success')
})

test('an invalid severity downgrade fails the required audit closed', async () => {
  const { result } = await runWorkflow({
    auditVerdicts: (candidates) => candidates.map((candidate) => ({
      candidateId: candidate.candidateId, status: 'severity_downgraded',
      acceptedSeverity: 'critical', reason: 'bogus downgrade', evidenceChecked: 'git object',
    })),
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'audit')
})

test('accepted overflow beyond maxFindings is discarded after reconciliation', async () => {
  // Two homogeneous single-file packs each contribute one accepted candidate;
  // maxFindings caps the confirmed set at one and discards the reconciled rest.
  const { result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js'],
    knobs: { maxFindings: 1, transactionMaxFiles: 1 },
  })

  assert.equal(result.findings.length, 1)
  assert.equal(result.discarded.filter(({ status }) => status === 'max_findings_exceeded').length, 1)
  assert.equal(result.metrics.confirmedFindings, 1)
  assert.equal(result.metrics.discardedFindings >= 1, true)
})

test('metrics are computed host-side and record the routing policy', async () => {
  const { agentLabels, result } = await runWorkflow()

  assert.equal(agentLabels.includes('synthesis'), false)
  assert.equal(result.metrics.taskCount, result.taskGraph.length)
  assert.equal(result.metrics.confirmedFindings, result.findings.length)
  assert.equal(result.metrics.routingPolicy, 'deterministic-flex-v1')
})

test('a Luna pack failing twice then succeeding retries on the deterministic schedule', async () => {
  const { agentCalls, result, sleepDelays } = await runWorkflow({ finderFailures: 2 })

  assert.equal(result.ok, true)
  // One admitted pack, three attempts against the same label.
  const finderCalls = agentCalls.filter((call) => call.label === 'luna-flex-1')
  assert.equal(finderCalls.length, 3)
  const luna = result.metrics.ledger.find((entry) => entry.lane === 'luna-flex')
  assert.equal(luna.attempts, 3, 'the ledger records the attempt count')
  // Sleep precedes attempts 2 and 3 only: 30 s + jitter, then 60 s + jitter.
  assert.equal(sleepDelays.length, 2)
  assert.ok(sleepDelays[0] >= 30000 && sleepDelays[0] <= 40000, `first backoff ${sleepDelays[0]}ms`)
  assert.ok(sleepDelays[1] >= 60000 && sleepDelays[1] <= 70000, `second backoff ${sleepDelays[1]}ms`)
  // Exactly the deterministic jitter derived from the call id and attempt.
  assert.equal(sleepDelays[0], (30 + deterministicJitter('luna-flex-1', 2, 10)) * 1000)
  assert.equal(sleepDelays[1], (60 + deterministicJitter('luna-flex-1', 3, 10)) * 1000)
  assert.equal(result.findings.length, 1)
})

test('a Luna pack exhausting its attempts is downgraded while the review completes', async () => {
  const { result, sleepDelays } = await runWorkflow({ failedLabel: 'luna-flex-1' })

  assert.equal(result.ok, true, 'a downgraded pack no longer fails the review')
  assert.equal(result.lunaDowngrades.length, 1)
  assert.equal(result.lunaDowngrades[0].taskId, 'luna-flex-1')
  assert.equal(result.lunaDowngrades[0].attempts, 3)
  assert.match(result.lunaDowngrades[0].reason, /exhaust/iu)
  assert.equal(result.metrics.lunaDowngradeCount, 1)
  // failedTaskIds stays for compatibility, listing the downgraded pack ids.
  assert.deepEqual(result.metrics.failedTaskIds, ['luna-flex-1'])
  // Three attempts means two backoff sleeps even on the exhaustion path.
  assert.equal(sleepDelays.length, 2)
  // The audit still runs against whatever survived (here nothing, so it is
  // skipped as a zero-candidate review) and the review remains recordable.
  assert.ok(result.recordInput, 'a review with a downgraded pack is still recordable')
})

test('a surviving pack is still audited after a sibling pack is downgraded', async () => {
  const { agentLabels, result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js'],
    // One pack per file; the first pack always fails, the second succeeds.
    failedLabel: 'luna-flex-1',
    knobs: { transactionMaxFiles: 1, transactionMaxInputTokens: 1, adapterOverheadTokens: 13000, budgetGbp: 0.12 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.lunaDowngrades.length, 1)
  assert.equal(result.lunaDowngrades[0].taskId, 'luna-flex-1')
  assert.ok(agentLabels.includes('audit'), 'the audit still runs over the surviving candidates')
  assert.equal(result.findings.length, 1, 'the surviving pack contributes its finding')
})

test('an audit exhausting its attempts defers without recording the head', async () => {
  const { agentCalls, result, sleepDelays } = await runWorkflow({ auditFails: true })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'deferred')
  assert.equal(result.deferred, true)
  assert.match(result.reason, /flex capacity exhausted for the required audit/u)
  assert.equal(result.attempts, 3)
  // No recordInput: the CLI's guard requires ok === true && recordInput, so the
  // reviewed head must not be recorded as complete.
  assert.equal(result.recordInput, undefined)
  // Context fields the deferred result must carry for an operator or retry.
  assert.equal(result.headCommit, 'b'.repeat(40))
  assert.equal(result.reviewBase, 'a'.repeat(40))
  assert.ok(Array.isArray(result.metrics.ledger))
  // Three audit attempts, two backoff sleeps recorded.
  const auditCalls = agentCalls.filter((call) => call.label === 'audit')
  assert.equal(auditCalls.length, 3)
  assert.equal(sleepDelays.length, 2)
  const auditEntry = result.metrics.ledger.find((entry) => entry.lane === 'terra-flex')
  assert.equal(auditEntry.attempts, 3)
})

test('an audit failing twice then succeeding recovers with the retry sleeps recorded', async () => {
  const { agentCalls, result, sleepDelays } = await runWorkflow({ auditFailures: 2 })

  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
  const auditCalls = agentCalls.filter((call) => call.label === 'audit')
  assert.equal(auditCalls.length, 3)
  assert.equal(sleepDelays.length, 2)
  assert.equal(sleepDelays[0], (30 + deterministicJitter('audit', 2, 10)) * 1000)
  assert.equal(sleepDelays[1], (60 + deterministicJitter('audit', 3, 10)) * 1000)
})

test('retries share one admission: spentUsd and ledger totals are unchanged by attempts', async () => {
  const single = await runWorkflow()
  const retried = await runWorkflow({ finderFailures: 2, auditFailures: 2 })

  assert.equal(retried.result.ok, true)
  assert.equal(retried.result.metrics.spentUsd, single.result.metrics.spentUsd)
  assert.equal(retried.result.metrics.ledgerTotalEstimatedUsd, single.result.metrics.ledgerTotalEstimatedUsd)
  // The ledger still holds exactly the two admitted calls, not one entry per attempt.
  assert.equal(retried.result.metrics.ledger.length, 2)
})
