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
function defaultResponders({ failedLabel, nullLabel, finderTitles, auditVerdicts, auditFails, auditNulls, finderFailures = 0, auditFailures = 0, finderFailLabel }) {
  // Per-label transient failure counters give each finder pack and the audit
  // their own "fail N attempts then succeed" state, so the retry helper's
  // deterministic schedule can be exercised without a shared counter leaking
  // across labels. `finderFailLabel` scopes the transient failures to a single
  // pack so a sibling can survive on its first attempt; when it is undefined
  // every finder pack fails `finderFailures` times (the historical behaviour).
  const finderAttempts = new Map()
  let auditAttempts = 0
  return [
    { match: (label) => failedLabel !== undefined && label === failedLabel, respond: () => { throw new FixtureFailure('fixture failure') } },
    // ODW's real agent() resolves to null on a terminal adapter failure rather
    // than throwing (observed live, M7); this responder simulates that shape.
    { match: (label) => nullLabel !== undefined && label === nullLabel, respond: () => null },
    {
      match: (label) => /^luna-flex-\d+$/u.test(label),
      respond: (prompt, options) => {
        const failuresForLabel =
          finderFailLabel === undefined || options.label === finderFailLabel ? finderFailures : 0
        const seen = finderAttempts.get(options.label) ?? 0
        if (seen < failuresForLabel) {
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
        if (auditNulls) return null
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
  failedLabel, nullLabel, changedFiles = ['src/a.js'], config = '/distinct/policy.yaml', commitLength = 40, repoRoot,
  finderTitles, auditVerdicts, auditFails, auditNulls, finderFailures, auditFailures, finderFailLabel,
  nullParallelSlots = [], knobs = {},
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
  const agent = buildAgentMock(defaultResponders({ failedLabel, nullLabel, finderTitles, auditVerdicts, auditFails, auditNulls, finderFailures, auditFailures, finderFailLabel }),
    { prompts, agentLabels, agentCalls })
  const swallowFixtureFailure = (error) => {
    if (error instanceof FixtureFailure) return null
    throw error
  }
  // `nullParallelSlots` simulates ODW aborting a thunk and resolving its slot
  // to null without the thunk's own code (including the retry helper) running
  // to completion — the semantics observed live in M7.
  const parallel = (thunks) => Promise.all(thunks.map((thunk, index) =>
    nullParallelSlots.includes(index)
      ? Promise.resolve(null)
      : Promise.resolve().then(thunk).catch(swallowFixtureFailure)))
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
    { config, prepared, ...(repoRoot === undefined ? {} : { repoRoot }), ...knobs },
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

test('a plan whose every finder pack is refused fails closed without recording', async () => {
  // Live gap (M8): the audit reservation fits but no Luna pack is affordable, so
  // admittedPacks is empty. The guard must key off the PLANNED packs, not the
  // admitted ones, or a zero-file review records the head as a clean pass.
  const { agentLabels, result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js'],
    // budgetGbp 0.075 -> USD 0.09525: the reserve (USD 0.09375) fits, but the
    // remaining USD 0.0015 cannot admit even one Luna pack (>= USD 0.0104 each).
    knobs: { budgetGbp: 0.075, transactionMaxFiles: 1 },
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'review')
  assert.equal(result.recordInput, undefined, 'a zero-coverage review must not be recordable')
  assert.equal(result.admissionRefusals.length, 2, 'every planned pack is refused')
  assert.equal(finderLabels(agentLabels).length, 0, 'no finder pack runs a model call')
  assert.equal(agentLabels.includes('audit'), false, 'the audit never runs on zero coverage')
})

test('maxTasks caps the finder plan below maxLunaFlexCalls', async () => {
  // --max-tasks is the planned-task cap; with maxTasks 1 the effective finder cap
  // is min(1, maxLunaFlexCalls) so exactly one pack dispatches even when several
  // homogeneous packs would otherwise be planned.
  const { agentLabels, result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js', 'tests/a.test.js', 'docs/g.md'],
    knobs: { maxTasks: 1 },
  })

  assert.equal(result.ok, true)
  assert.equal(finderLabels(agentLabels).length, 1, 'maxTasks 1 dispatches exactly one finder pack')
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
  // A generous budget so every admitted retry is charged rather than refused.
  const { agentCalls, result, sleepDelays } = await runWorkflow({ finderFailures: 2, knobs: { budgetGbp: 0.5 } })

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
  // Exactly the deterministic jitter derived from the per-review call id (head
  // commit prefix) and attempt.
  const head = 'b'.repeat(40)
  assert.equal(sleepDelays[0], (30 + deterministicJitter(`.:${head}:luna-flex-1`, 2, 10)) * 1000)
  assert.equal(sleepDelays[1], (60 + deterministicJitter(`.:${head}:luna-flex-1`, 3, 10)) * 1000)
  assert.equal(result.findings.length, 1)
})

test('a review whose only finder pack fails is refused, not recorded as a pass', async () => {
  // Live evidence (M7, comenq 140): an adapter failure must never turn into a
  // clean zero-finding review that records the head as reviewed.
  const { result, sleepDelays } = await runWorkflow({ failedLabel: 'luna-flex-1', knobs: { budgetGbp: 0.5 } })

  assert.equal(result.ok, false, 'zero finder coverage must fail closed')
  assert.equal(result.stage, 'review')
  assert.match(result.error, /zero coverage|every admitted finder pack failed/iu)
  assert.equal(result.recordInput, undefined, 'a zero-coverage review must not be recordable')
  assert.equal(result.lunaDowngrades.length, 1)
  assert.equal(result.lunaDowngrades[0].taskId, 'luna-flex-1')
  assert.equal(result.lunaDowngrades[0].attempts, 3)
  assert.match(result.lunaDowngrades[0].reason, /exhaust/iu)
  // Three attempts means two backoff sleeps even on the exhaustion path.
  assert.equal(sleepDelays.length, 2)
})

test('a finder pack resolving null is retried and then downgraded', async () => {
  // ODW's agent() resolves to null on terminal adapter failure; a null result
  // must consume retry attempts rather than masquerade as a completed call.
  const { agentCalls, result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js'],
    nullLabel: 'luna-flex-1',
    knobs: { transactionMaxFiles: 1, transactionMaxInputTokens: 1, adapterOverheadTokens: 13000, budgetGbp: 0.12 },
  })

  assert.equal(result.ok, true, 'the surviving sibling keeps the review alive')
  const nullCalls = agentCalls.filter((call) => call.label === 'luna-flex-1')
  assert.equal(nullCalls.length, 3, 'a null result consumes retry attempts')
  assert.equal(result.lunaDowngrades.length, 1)
  assert.equal(result.lunaDowngrades[0].taskId, 'luna-flex-1')
  assert.equal(result.findings.length, 1, 'the surviving pack contributes its finding')
})

test('a parallel slot nulled by the runtime is attributed to its pack', async () => {
  // ODW may abort a thunk and resolve its slot to null without the workflow's
  // own retry code completing; the pack must still be accounted for.
  const { result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js'],
    nullParallelSlots: [0],
    knobs: { transactionMaxFiles: 1, transactionMaxInputTokens: 1, adapterOverheadTokens: 13000, budgetGbp: 0.12 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.lunaDowngrades.length, 1)
  assert.equal(result.lunaDowngrades[0].taskId, 'luna-flex-1', 'the nulled slot maps to its pack by index')
  assert.equal(result.findings.length, 1)
})

test('an audit resolving null defers without recording the head', async () => {
  // A generous budget so the audit's retries are admitted and charged, letting a
  // null result consume all three attempts before the review defers.
  const { agentCalls, result } = await runWorkflow({ auditNulls: true, knobs: { budgetGbp: 0.5 } })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'deferred')
  assert.equal(result.recordInput, undefined)
  const auditCalls = agentCalls.filter((call) => call.label === 'audit')
  assert.equal(auditCalls.length, 3, 'a null audit result consumes retry attempts')
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
  // A generous budget so the audit exhausts its retries rather than being
  // refused one, exercising the capacity-exhaustion deferral path.
  const { agentCalls, result, sleepDelays } = await runWorkflow({ auditFails: true, knobs: { budgetGbp: 0.5 } })

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
  // A generous budget so both audit retries are admitted and charged.
  const { agentCalls, result, sleepDelays } = await runWorkflow({ auditFailures: 2, knobs: { budgetGbp: 0.5 } })

  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
  const auditCalls = agentCalls.filter((call) => call.label === 'audit')
  assert.equal(auditCalls.length, 3)
  assert.equal(sleepDelays.length, 2)
  const head = 'b'.repeat(40)
  assert.equal(sleepDelays[0], (30 + deterministicJitter(`.:${head}:audit`, 2, 10)) * 1000)
  assert.equal(sleepDelays[1], (60 + deterministicJitter(`.:${head}:audit`, 3, 10)) * 1000)
})

test('recordInput.models is derived from the ledger of completed calls', async () => {
  // An ordinary review runs one Luna finder and the Terra audit, so both models
  // are recorded in first-appearance order.
  const ordinary = await runWorkflow()
  assert.equal(ordinary.result.ok, true)
  assert.deepEqual(ordinary.result.recordInput.models, ['gpt-5.6-luna', 'gpt-5.6-terra'])

  // A zero-candidate review skips the audit, so only the Luna finder's model is
  // recorded — never the configured REVIEW_MODELS.
  const auditSkipped = await runWorkflow({ finderTitles: [] })
  assert.equal(auditSkipped.result.ok, true)
  assert.deepEqual(auditSkipped.result.recordInput.models, ['gpt-5.6-luna'])
})

// Deterministic per-call worst cases at transactionMaxInputTokens 1 and
// adapterOverheadTokens 13000: one Luna finder pack prices at USD 0.010375625
// (13001 input tokens x cache-write 0.625/MTok + 750 output x 3.0/MTok) and the
// Terra audit reserve at USD 0.09375. The retry-admission fixtures below are
// derived from these two figures.
const PACK_WORST_CASE_USD = (13001 * 0.625) / 1e6 + (750 * 3.0) / 1e6
const AUDIT_RESERVE_USD = 0.09375
const RETRY_KNOB_BASE = { transactionMaxInputTokens: 1, adapterOverheadTokens: 13000 }
const approx = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`)

test('admitted retries are charged: spentUsd and ledger estimates grow per attempt', async () => {
  // A budget generous enough to admit three finder attempts and three audit
  // attempts, so every retry is charged rather than refused.
  const generous = { budgetGbp: 0.5, ...RETRY_KNOB_BASE }
  const single = await runWorkflow({ knobs: generous })
  const retried = await runWorkflow({ finderFailures: 2, auditFailures: 2, knobs: generous })

  assert.equal(single.result.ok, true)
  assert.equal(retried.result.ok, true)

  const finderOf = (r) => r.result.metrics.ledger.find((entry) => entry.lane === 'luna-flex')
  const auditOf = (r) => r.result.metrics.ledger.find((entry) => entry.lane === 'terra-flex')

  // Each ADMITTED retry charges another worst case onto the entry's estimate;
  // three attempts means the estimate is three times the single-run value while
  // `attempts` records the observed count.
  approx(finderOf(retried).estimatedWorstCaseUsd, 3 * finderOf(single).estimatedWorstCaseUsd,
    'finder estimate grows to 3x')
  approx(auditOf(retried).estimatedWorstCaseUsd, 3 * auditOf(single).estimatedWorstCaseUsd,
    'audit estimate grows to 3x')
  assert.equal(finderOf(retried).attempts, 3)
  assert.equal(auditOf(retried).attempts, 3)

  const finderIncrement = 2 * finderOf(single).estimatedWorstCaseUsd
  const auditIncrement = 2 * auditOf(single).estimatedWorstCaseUsd
  approx(retried.result.metrics.spentUsd, single.result.metrics.spentUsd + finderIncrement + auditIncrement,
    'spentUsd equals the single-run total plus the retry increments')
  approx(retried.result.metrics.ledgerTotalEstimatedUsd,
    single.result.metrics.ledgerTotalEstimatedUsd + finderIncrement + auditIncrement,
    'ledgerTotalEstimatedUsd equals the single-run total plus the retry increments')
  // Still exactly the two admitted calls: retries accumulate onto entries.
  assert.equal(retried.result.metrics.ledger.length, 2)
})

test('a Luna retry refused by the budget stops retrying and downgrades', async () => {
  // Budget fits both packs' first attempts plus the audit reserve (2P + R =
  // USD 0.11450) but not a single Luna retry (which would need 3P + R =
  // USD 0.12488). budgetGbp 0.093 -> USD 0.11811 sits between the two.
  const budgetUsd = 0.093 * 1.27
  assert.ok(budgetUsd >= 2 * PACK_WORST_CASE_USD + AUDIT_RESERVE_USD, 'first attempts must fit')
  assert.ok(budgetUsd < 3 * PACK_WORST_CASE_USD + AUDIT_RESERVE_USD, 'one retry must not fit')

  const { result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js'],
    // Only the first pack fails transiently; its sibling survives on attempt 1.
    finderFailures: 2,
    finderFailLabel: 'luna-flex-1',
    knobs: { budgetGbp: 0.093, transactionMaxFiles: 1, ...RETRY_KNOB_BASE },
  })

  assert.equal(result.ok, true, 'the surviving sibling keeps the review alive')
  assert.equal(result.lunaDowngrades.length, 1)
  const downgrade = result.lunaDowngrades[0]
  assert.equal(downgrade.taskId, 'luna-flex-1')
  assert.ok(downgrade.attempts < 3, `budget-refused downgrade should stop before exhaustion, got ${downgrade.attempts}`)
  assert.match(downgrade.reason, /budget/u)
  assert.equal(result.recordInput, undefined, 'a budget-downgraded review must not be recordable')
  assert.equal(result.recordWithheld.lunaDowngradeCount, 1)
  assert.ok(result.metrics.spentUsd <= budgetUsd, `spentUsd ${result.metrics.spentUsd} must not exceed budget ${budgetUsd}`)
})

test('an audit retry refused by the budget defers', async () => {
  // Budget fits one finder pack plus one audit attempt (P + R = USD 0.10413)
  // but not a second audit attempt (P + 2R = USD 0.19788). budgetGbp 0.11 ->
  // USD 0.1397 admits the audit once, then refuses its retry.
  const budgetUsd = 0.11 * 1.27
  assert.ok(budgetUsd >= PACK_WORST_CASE_USD + AUDIT_RESERVE_USD, 'the audit must be admitted once')
  assert.ok(budgetUsd < PACK_WORST_CASE_USD + 2 * AUDIT_RESERVE_USD, 'the audit retry must not fit')

  const { result } = await runWorkflow({
    auditFailures: 2,
    knobs: { budgetGbp: 0.11, ...RETRY_KNOB_BASE },
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'deferred')
  assert.equal(result.deferred, true)
  // The first audit attempt is admitted and runs; its refused retry is attempt
  // 2, so the helper returns the observed count of 1.
  assert.equal(result.attempts, 1)
  assert.match(result.reason, /budget/u)
  assert.equal(result.recordInput, undefined)
  assert.ok(result.metrics.spentUsd <= budgetUsd, `spentUsd ${result.metrics.spentUsd} must not exceed budget ${budgetUsd}`)
})

test('a retried run never lets spentUsd exceed the hard budget', async () => {
  const generous = { budgetGbp: 0.5, ...RETRY_KNOB_BASE }
  const { result } = await runWorkflow({ finderFailures: 2, auditFailures: 2, knobs: generous })

  assert.equal(result.ok, true)
  assert.ok(result.metrics.spentUsd <= result.metrics.budgetUsd,
    `spentUsd ${result.metrics.spentUsd} must not exceed budgetUsd ${result.metrics.budgetUsd}`)
})

test('retry jitter seeds are scoped by repository root as well as head', async () => {
  // /repo-a and /repo-b are a verified divergent fixture pair for this head
  // (jitter 10 versus 5 at attempt 2), so otherwise identical reviews of
  // different repositories never share a backoff schedule.
  const head = 'b'.repeat(40)
  const runA = await runWorkflow({ repoRoot: '/repo-a', finderFailures: 1, knobs: { budgetGbp: 0.5 } })
  const runB = await runWorkflow({ repoRoot: '/repo-b', finderFailures: 1, knobs: { budgetGbp: 0.5 } })

  const jitterA = deterministicJitter(`/repo-a:${head}:luna-flex-1`, 2, 10)
  const jitterB = deterministicJitter(`/repo-b:${head}:luna-flex-1`, 2, 10)
  assert.notEqual(jitterA, jitterB, 'the fixture pair must diverge for the assertion to bite')
  assert.equal(runA.sleepDelays[0], (30 + jitterA) * 1000)
  assert.equal(runB.sleepDelays[0], (30 + jitterB) * 1000)
})

test('finder-plan truncation withholds recordInput while keeping diagnostics', async () => {
  const changedFiles = Array.from({ length: 6 }, (_, index) => `src/module-${index}.js`)
  const { result } = await runWorkflow({
    changedFiles,
    knobs: { budgetGbp: 0.12, transactionMaxFiles: 1, transactionMaxInputTokens: 1, adapterOverheadTokens: 13000 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.recordInput, undefined, 'truncated coverage must not be recordable')
  assert.equal(result.recordWithheld.truncatedFileCount, 2)
  assert.equal(result.metrics.truncatedFileCount, 2, 'diagnostics stay visible')
})

test('an admission refusal withholds recordInput while the review completes', async () => {
  const changedFiles = ['src/a.js', 'src/b.js', 'src/c.js']
  const { result } = await runWorkflow({
    changedFiles,
    // A budget admitting the audit and some, but not all, of the three packs.
    knobs: { budgetGbp: 0.095, transactionMaxFiles: 1, transactionMaxInputTokens: 1, adapterOverheadTokens: 13000 },
  })

  assert.equal(result.ok, true)
  assert.ok(result.admissionRefusals.length >= 1, 'the scenario must refuse at least one pack')
  assert.equal(result.recordInput, undefined, 'refused coverage must not be recordable')
  assert.equal(result.recordWithheld.admissionRefusalCount, result.admissionRefusals.length)
})

test('a Luna downgrade withholds recordInput while the review completes', async () => {
  const { result } = await runWorkflow({
    changedFiles: ['src/a.js', 'src/b.js'],
    failedLabel: 'luna-flex-1',
    knobs: { transactionMaxFiles: 1, transactionMaxInputTokens: 1, adapterOverheadTokens: 13000, budgetGbp: 0.12 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.lunaDowngrades.length, 1)
  assert.equal(result.recordInput, undefined, 'downgraded coverage must not be recordable')
  assert.equal(result.recordWithheld.lunaDowngradeCount, 1)
})

test('a complete successful review still emits recordInput and no recordWithheld', async () => {
  const { result } = await runWorkflow()

  assert.equal(result.ok, true)
  assert.ok(result.recordInput, 'complete coverage remains recordable')
  assert.equal(result.recordWithheld, undefined)
})
