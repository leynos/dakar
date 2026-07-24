/** @file Verify Dakar's canonical SARIF assembly and deterministic projections. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assembleSarif,
  projectDiscardedFromSarif,
  projectFindingsFromSarif,
  renderSarifMarkdown,
} from '../src/workflows/dakar-review/sarif.ts'

function fixture() {
  const candidate = {
    candidateId: 'luna-flex-1:src/a.ts:4:null-guard',
    taskId: 'luna-flex-1',
    taskKind: 'source',
    sourceModel: 'gpt-5.6-luna',
    verificationPolicy: 'verify-all',
    title: 'Null guard is inverted',
    severity: 'high',
    path: 'src/a.ts',
    line: 4,
    detail: 'The success branch returns the failure value.',
    evidence: 'The diff reverses the predicate.',
    confidence: 'high',
    policyRefs: ['reviews.profile'],
  }
  const verdict = {
    candidateId: candidate.candidateId,
    status: 'accepted',
    reason: 'Confirmed against the changed branch.',
    evidenceChecked: 'git diff at src/a.ts:4',
    clusterId: 'cluster-null-guard',
  }
  const accepted = {
    ...candidate,
    clusterId: verdict.clusterId,
    verificationStatus: verdict.status,
    verificationReason: verdict.reason,
    evidenceChecked: verdict.evidenceChecked,
  }
  const discardedCandidate = {
    ...candidate,
    candidateId: 'luna-flex-1:src/a.ts:9:style-only',
    line: 9,
    title: 'Style-only observation',
    severity: 'low',
  }
  return {
    candidates: [candidate, discardedCandidate],
    verdicts: [verdict],
    accepted: [accepted],
    discarded: [{
      candidate: discardedCandidate,
      status: 'tool_false_positive',
      reason: 'Covered by the configured formatter.',
      evidenceChecked: 'formatter output',
    }],
    gates: [{
      gateId: 'gate-001-format',
      name: 'Format',
      command: 'make check-fmt',
      blocking: true,
      status: 'passed',
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutSha256: '0'.repeat(64),
      stderrSha256: '0'.repeat(64),
    }],
    ledger: [{
      callId: 'luna-flex-1',
      phase: 'Review',
      lane: 'luna-flex',
      model: 'gpt-5.6-luna',
      serviceTier: 'flex',
      reasoningEffort: 'low',
      estimatedWorstCaseUsd: 0.01,
      pricingTableVersion: '2026-07-18',
      attempts: 1,
    }],
    pricingTableVersion: '2026-07-18',
  }
}

test('assembleSarif emits SARIF 2.1.0 with stable identity, provenance, and gate evidence', () => {
  const input = fixture()
  const original = structuredClone(input.candidates)
  const sarif = assembleSarif(input)

  assert.equal(sarif.version, '2.1.0')
  assert.equal(sarif.$schema, 'https://json.schemastore.org/sarif-2.1.0.json')
  assert.equal(sarif.runs.length, 1)
  const [run] = sarif.runs
  assert.equal(run.tool.driver.name, 'Dakar')
  assert.equal(run.properties.dakar.pricingTableVersion, '2026-07-18')
  assert.equal(run.invocations[0].properties.dakar.gates[0].gateId, 'gate-001-format')

  const accepted = run.results.find((result) =>
    result.fingerprints['dakar/candidateId'] === input.candidates[0].candidateId)
  assert.equal(accepted.properties.dakar.provenance.taskId, 'luna-flex-1')
  assert.equal(accepted.properties.dakar.provenance.model, 'gpt-5.6-luna')
  assert.equal(accepted.properties.dakar.provenance.lane, 'luna-flex')
  assert.equal(accepted.properties.dakar.provenance.serviceTier, 'flex')
  assert.equal(accepted.properties.dakar.audit.candidateId, input.candidates[0].candidateId)
  assert.equal(accepted.properties.dakar.disposition.status, 'accepted')
  assert.deepEqual(input.candidates, original, 'SARIF assembly must not mutate Luna evidence')
})

test('SARIF assembly and Markdown projection are byte-stable', () => {
  const input = fixture()
  const first = assembleSarif(input)
  const second = assembleSarif(structuredClone(input))

  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(renderSarifMarkdown(first), renderSarifMarkdown(second))
})

test('compatibility findings and discards are deterministic SARIF projections', () => {
  const sarif = assembleSarif(fixture())
  const findings = projectFindingsFromSarif(sarif)
  const discarded = projectDiscardedFromSarif(sarif)

  assert.deepEqual(findings, [{
    severity: 'high',
    path: 'src/a.ts',
    line: 4,
    title: 'Null guard is inverted',
    detail: 'The success branch returns the failure value.',
    evidence: 'The diff reverses the predicate.',
    clusterId: 'cluster-null-guard',
    sourceTasks: ['luna-flex-1'],
  }])
  assert.equal(discarded.length, 1)
  assert.equal(discarded[0].candidate.candidateId, 'luna-flex-1:src/a.ts:9:style-only')
  assert.equal(discarded[0].status, 'tool_false_positive')
  assert.match(renderSarifMarkdown(sarif), /^## high: Null guard is inverted$/mu)
})

test('SARIF projections preserve audited severity and distinguish advisory gates', () => {
  const input = fixture()
  input.accepted[0].severity = 'medium'
  input.verdicts[0].status = 'severity_downgraded'
  input.gates = [{
    ...input.gates[0],
    blocking: false,
    status: 'failed',
    exitCode: 1,
  }]

  const sarif = assembleSarif(input)
  const semantic = sarif.runs[0].results.find((result) =>
    result.fingerprints['dakar/candidateId'] === input.candidates[0].candidateId)

  assert.equal(semantic.level, 'warning')
  assert.equal(projectFindingsFromSarif(sarif)[0].severity, 'medium')
  assert.doesNotMatch(renderSarifMarkdown(sarif), /require remediation/u)
})
