/** @file Verify Dakar's canonical SARIF assembly and deterministic projections. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

function projectedResult(dakar) {
  return { properties: { dakar } }
}

function projectedDocument(results, laterResults = []) {
  return { runs: [{ results }, ...(laterResults.length > 0 ? [{ results: laterResults }] : [])] }
}

function semanticDakarResult(overrides = {}) {
  return {
    kind: 'semantic',
    disposition: { status: 'accepted' },
    candidate: {
      taskId: 'luna-task',
      severity: 'high',
      path: 'src/example.ts',
      line: 7,
      title: 'Finding title',
      detail: 'Finding detail',
      evidence: 'Finding evidence',
    },
    audit: { clusterId: 'cluster-one' },
    ...overrides,
  }
}

function assembledCandidate(candidateId, overrides = {}) {
  return { ...fixture().candidates[0], candidateId, ...overrides }
}

function assembledSemantic(input) {
  return assembleSarif(input).runs[0].results.filter((result) => result.properties.dakar.kind === 'semantic')
}

function semanticDigest(input) {
  return createHash('sha256').update(JSON.stringify(assembleSarif(input))).digest('hex')
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

test('SARIF assembly retains pre-refactor serialised output for representative evidence', () => {
  const base = fixture()
  const acceptedWithDiscard = assembledCandidate('luna-flex-1:src/a.ts:8:accepted-with-discard', { line: 8 })
  const evidence = {
    ...base,
    candidates: [base.candidates[1], acceptedWithDiscard, base.candidates[0]],
    accepted: [base.accepted[0], { ...acceptedWithDiscard, severity: 'medium' }],
    discarded: [...base.discarded, {
      candidate: acceptedWithDiscard,
      status: 'duplicate',
      reason: 'Discard must not override accepted evidence.',
      evidenceChecked: 'duplicate evidence',
    }],
  }

  assert.equal(semanticDigest(base), 'f00fac48d1821fdd599cd8fb16937480ed8532c4d94a008df567e281d1aef773')
  assert.equal(semanticDigest(evidence), 'af7a84e143abdbacf05b25459ad480410f268c6b30255788dbbb4394ac76c9bf')
})

test('accepted semantic results use accepted severity and ignore a concurrent discard', () => {
  const candidate = assembledCandidate('luna-flex-1:src/a.ts:4:accepted')
  const accepted = { ...candidate, severity: 'medium' }
  const discard = { candidate, status: 'duplicate', reason: 'discard reason', evidenceChecked: 'discard evidence' }
  const [withoutVerdict] = assembledSemantic({ candidates: [candidate], accepted: [accepted], discarded: [discard], pricingTableVersion: 'v1' })
  const [withVerdict] = assembledSemantic({
    candidates: [candidate], accepted: [accepted], discarded: [discard],
    verdicts: [{ candidateId: candidate.candidateId, status: 'severity_downgraded', reason: 'audit reason', evidenceChecked: 'audit evidence' }],
    pricingTableVersion: 'v1',
  })

  assert.equal(withoutVerdict.level, 'warning')
  assert.deepEqual(withoutVerdict.properties.dakar.disposition, {
    status: 'accepted', reason: '', evidenceChecked: '', acceptedSeverity: 'medium',
  })
  assert.equal(withoutVerdict.properties.dakar.audit, null)
  assert.equal(withoutVerdict.properties.dakar.candidate.severity, 'high', 'candidate evidence retains its proposed severity')
  assert.equal(Object.hasOwn(withoutVerdict, 'suppressions'), false)
  assert.deepEqual(withVerdict.properties.dakar.disposition, {
    status: 'severity_downgraded', reason: 'audit reason', evidenceChecked: 'audit evidence', acceptedSeverity: 'medium',
  })
  assert.equal(Object.hasOwn(withVerdict, 'suppressions'), false)
})

test('discard fields independently override verdict fields with truthy fallbacks', () => {
  const candidate = assembledCandidate('luna-flex-1:src/a.ts:4:discarded')
  const verdict = { candidateId: candidate.candidateId, status: 'needs_human', reason: 'verdict reason', evidenceChecked: 'verdict evidence' }
  const discard = { candidate, status: 'duplicate', reason: '', evidenceChecked: 'discard evidence' }
  const [result] = assembledSemantic({ candidates: [candidate], discarded: [discard], verdicts: [verdict], pricingTableVersion: 'v1' })
  const disposition = result.properties.dakar.disposition
  assert.deepEqual(disposition, { status: 'duplicate', reason: 'verdict reason', evidenceChecked: 'discard evidence' })
  assert.deepEqual(result.suppressions, [{ kind: 'external', status: 'accepted', justification: 'verdict reason' }])
  assert.notStrictEqual(result.properties.dakar.audit, verdict, 'audit evidence is shallow-copied')
  assert.deepEqual(result.properties.dakar.audit, verdict)

  const [fallback] = assembledSemantic({
    candidates: [candidate],
    discarded: [{ candidate, status: '', reason: '', evidenceChecked: '' }],
    verdicts: [verdict], pricingTableVersion: 'v1',
  })
  assert.deepEqual(fallback.properties.dakar.disposition, {
    status: 'needs_human', reason: 'verdict reason', evidenceChecked: 'verdict evidence',
  })
  const [defaults] = assembledSemantic({ candidates: [candidate], pricingTableVersion: 'v1' })
  assert.deepEqual(defaults.properties.dakar.disposition, { status: 'not_selected', reason: '', evidenceChecked: '' })
  assert.equal(defaults.properties.dakar.audit, null)
  assert.equal(defaults.properties.dakar.cost, null)
  assert.deepEqual(defaults.suppressions, [{ kind: 'external', status: 'accepted', justification: '' }])
})

test('semantic provenance retains defaults and copies present ledger evidence', () => {
  const candidate = assembledCandidate('luna-flex-1:src/a.ts:4:provenance')
  const ledger = { ...fixture().ledger[0], lane: 'terra-flex', serviceTier: 'priority', reasoningEffort: 'high' }
  const [withoutLedger] = assembledSemantic({ candidates: [candidate], pricingTableVersion: 'v1' })
  const [withLedger] = assembledSemantic({ candidates: [candidate], ledger: [ledger], pricingTableVersion: 'v1' })

  assert.deepEqual(withoutLedger.properties.dakar.provenance, {
    taskId: candidate.taskId, taskKind: candidate.taskKind, model: candidate.sourceModel,
    lane: 'luna-flex', serviceTier: 'flex', reasoningEffort: undefined,
  })
  assert.equal(Object.hasOwn(withoutLedger.properties.dakar.provenance, 'reasoningEffort'), true)
  assert.equal(Object.hasOwn(withoutLedger.properties.dakar, 'clusterId'), true)
  assert.equal(withoutLedger.properties.dakar.clusterId, undefined)
  assert.equal(withLedger.properties.dakar.provenance.lane, 'terra-flex')
  assert.equal(withLedger.properties.dakar.provenance.serviceTier, 'priority')
  assert.equal(withLedger.properties.dakar.provenance.reasoningEffort, 'high')
  assert.notStrictEqual(withLedger.properties.dakar.cost, ledger, 'ledger evidence is shallow-copied')
  assert.deepEqual(withLedger.properties.dakar.cost, ledger)
})

test('semantic results sort by candidate id stably and do not mutate input', () => {
  const first = assembledCandidate('luna-flex-1:z', { title: 'First equal id' })
  const second = assembledCandidate('luna-flex-1:a', { title: 'Earlier id' })
  const third = assembledCandidate('luna-flex-1:z', { title: 'Second equal id' })
  const input = { candidates: [first, second, third], pricingTableVersion: 'v1' }
  const original = structuredClone(input)
  const results = assembledSemantic(input)

  assert.deepEqual(results.map((result) => result.message.text), ['Earlier id', 'First equal id', 'Second equal id'])
  assert.deepEqual(input, original, 'SARIF assembly does not mutate candidate input or its order')
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

test('finding projection returns no findings without a first run or results', () => {
  assert.deepEqual(projectFindingsFromSarif({ runs: [] }), [])
  assert.deepEqual(projectFindingsFromSarif(projectedDocument([])), [])
  assert.deepEqual(
    projectFindingsFromSarif(projectedDocument([], [projectedResult(semanticDakarResult())])),
    [],
    'later runs are ignored when the first run has no results',
  )
})

test('finding projection excludes non-semantic, rejected, and missing-disposition results', () => {
  const accepted = semanticDakarResult()
  const missingDisposition = { kind: 'semantic', candidate: accepted.candidate }
  const findings = projectFindingsFromSarif(projectedDocument([
    projectedResult({ ...accepted, kind: 'transaction' }),
    projectedResult({ ...accepted, disposition: { status: 'rejected' } }),
    projectedResult(missingDisposition),
  ]))

  assert.deepEqual(findings, [])
})

test('finding projection prefers accepted severity and falls back to candidate severity', () => {
  const findings = projectFindingsFromSarif(projectedDocument([
    projectedResult(semanticDakarResult({ disposition: { status: 'accepted', acceptedSeverity: 'critical' } })),
    projectedResult(semanticDakarResult({
      disposition: { status: 'severity_downgraded' },
      candidate: { ...semanticDakarResult().candidate, severity: 'medium' },
    })),
  ]))

  assert.equal(findings[0].severity, 'critical')
  assert.equal(findings[1].severity, 'medium')
})

test('finding projection retains original positive lines and undefined non-positive or absent lines', () => {
  const candidate = semanticDakarResult().candidate
  const findings = projectFindingsFromSarif(projectedDocument([
    projectedResult(semanticDakarResult({ candidate: { ...candidate, line: '12' } })),
    projectedResult(semanticDakarResult({ candidate: { ...candidate, line: 0 } })),
    projectedResult(semanticDakarResult({ candidate: { ...candidate, line: -3 } })),
    projectedResult(semanticDakarResult({ candidate: { ...candidate, line: undefined } })),
  ]))

  assert.deepEqual(findings.map((finding) => finding.line), ['12', undefined, undefined, undefined])
  assert.ok(findings.every((finding) => Object.hasOwn(finding, 'line')), 'undefined line values remain own properties')
})

test('finding projection keeps empty text fallbacks and undefined absent audit fields', () => {
  const candidate = semanticDakarResult().candidate
  const findings = projectFindingsFromSarif(projectedDocument([
    projectedResult(semanticDakarResult({
      candidate: { ...candidate, detail: '', evidence: '' },
      audit: undefined,
    })),
    projectedResult(semanticDakarResult({ audit: {} })),
  ]))

  assert.deepEqual(findings, [
    {
      severity: 'high',
      path: 'src/example.ts',
      line: 7,
      title: 'Finding title',
      detail: '',
      evidence: '',
      clusterId: undefined,
      sourceTasks: ['luna-task'],
    },
    {
      severity: 'high',
      path: 'src/example.ts',
      line: 7,
      title: 'Finding title',
      detail: 'Finding detail',
      evidence: 'Finding evidence',
      clusterId: undefined,
      sourceTasks: ['luna-task'],
    },
  ])
  assert.ok(findings.every((finding) => Object.hasOwn(finding, 'clusterId')), 'undefined clusterId remains an own property')
})

test('finding projection preserves result order and does not mutate SARIF input', () => {
  const sarif = projectedDocument([
    projectedResult(semanticDakarResult({ candidate: { ...semanticDakarResult().candidate, title: 'First' } })),
    projectedResult({ ...semanticDakarResult(), disposition: { status: 'rejected' } }),
    projectedResult(semanticDakarResult({ candidate: { ...semanticDakarResult().candidate, title: 'Second' } })),
  ])
  const original = structuredClone(sarif)

  assert.deepEqual(projectFindingsFromSarif(sarif).map((finding) => finding.title), ['First', 'Second'])
  assert.deepEqual(sarif, original, 'projection leaves the input SARIF document unchanged')
})

test('discard projection returns no records without first-run results', () => {
  assert.deepEqual(projectDiscardedFromSarif({ runs: [] }), [])
  assert.deepEqual(projectDiscardedFromSarif(projectedDocument([])), [])
  assert.deepEqual(
    projectDiscardedFromSarif(projectedDocument([], [projectedResult({ kind: 'semantic' })])),
    [],
    'later runs are ignored when the first run has no results',
  )
})

test('discard projection ignores non-semantic and accepted results', () => {
  const candidate = { candidateId: 'candidate-stub' }
  const sarif = projectedDocument([
    projectedResult({ kind: 'deterministic-gate', candidate, disposition: { status: 'blocking' } }),
    projectedResult({ kind: 'semantic', candidate, disposition: { status: 'accepted' } }),
    projectedResult({ kind: 'semantic', candidate, disposition: { status: 'severity_downgraded' } }),
  ])

  assert.deepEqual(projectDiscardedFromSarif(sarif), [])
})

test('discard projection retains categories, unknown statuses, order, and candidate identity', () => {
  const candidates = [
    { candidateId: 'minimal-one' },
    { candidateId: 'minimal-two' },
    { candidateId: 'minimal-three' },
  ]
  const sarif = projectedDocument([
    projectedResult({
      kind: 'semantic',
      candidate: candidates[0],
      disposition: { status: 'tool_false_positive', reason: 'known category', evidenceChecked: 'check one' },
    }),
    projectedResult({
      kind: 'semantic',
      candidate: candidates[1],
      disposition: { status: 'rejected', reason: 'ordinary discard', evidenceChecked: 'check two' },
    }),
    projectedResult({
      kind: 'semantic',
      candidate: candidates[2],
      disposition: { status: 'future_status', reason: 'unknown category', evidenceChecked: 'check three' },
    }),
  ])
  const original = structuredClone(sarif)
  const discards = projectDiscardedFromSarif(sarif)

  assert.deepEqual(discards, [
    { candidate: candidates[0], status: 'tool_false_positive', reason: 'known category', evidenceChecked: 'check one' },
    { candidate: candidates[1], status: 'rejected', reason: 'ordinary discard', evidenceChecked: 'check two' },
    { candidate: candidates[2], status: 'future_status', reason: 'unknown category', evidenceChecked: 'check three' },
  ])
  assert.deepEqual(discards.map((discard) => discard.status), ['tool_false_positive', 'rejected', 'future_status'])
  assert.deepEqual(discards.map((discard) => discard.candidate.candidateId), ['minimal-one', 'minimal-two', 'minimal-three'])
  discards.forEach((discard, index) => {
    assert.strictEqual(discard.candidate, candidates[index], 'each discard preserves the original candidate reference')
  })
  assert.deepEqual(sarif, original, 'projection leaves the input SARIF document unchanged')
})

test('discard projection stringifies missing and falsy disposition fields as empty strings', () => {
  const candidates = [
    { candidateId: 'missing-disposition' },
    { candidateId: 'null-disposition' },
    { candidateId: 'falsy-fields' },
  ]
  const sarif = projectedDocument([
    projectedResult({ kind: 'semantic', candidate: candidates[0] }),
    projectedResult({ kind: 'semantic', candidate: candidates[1], disposition: null }),
    projectedResult({
      kind: 'semantic',
      candidate: candidates[2],
      disposition: { status: 0, reason: false, evidenceChecked: null },
    }),
  ])

  const discards = projectDiscardedFromSarif(sarif)

  assert.deepEqual(discards, candidates.map((candidate) => ({
    candidate,
    status: '',
    reason: '',
    evidenceChecked: '',
  })))
  discards.forEach((discard, index) => {
    assert.strictEqual(discard.candidate, candidates[index], 'minimal candidate stubs retain object identity')
  })
})

test('discard projection applies String conversion to truthy non-string fields', () => {
  const candidate = { candidateId: 'minimal-truthy-fields' }
  const discards = projectDiscardedFromSarif(projectedDocument([
    projectedResult({
      kind: 'semantic',
      candidate,
      disposition: { status: 42, reason: { source: 'audit' }, evidenceChecked: ['first', 'second'] },
    }),
  ]))

  assert.deepEqual(discards, [{
    candidate,
    status: '42',
    reason: '[object Object]',
    evidenceChecked: 'first,second',
  }])
  assert.strictEqual(discards[0].candidate, candidate)
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
