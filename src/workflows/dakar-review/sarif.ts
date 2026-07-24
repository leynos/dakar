/** @file Assemble Dakar's canonical SARIF 2.1.0 evidence and projections. */

import type { Candidate, DeterministicGateResult, Discarded, LedgerEntry, Verdict } from './types.ts'

/** Canonical SARIF schema URI used by every Dakar result. */
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'

/** Minimal structural type for Dakar's SARIF result contract. */
export interface DakarSarif {
  $schema: string
  version: '2.1.0'
  runs: Array<{
    tool: { driver: { name: string; version: string; rules: Array<Record<string, unknown>> } }
    invocations: Array<Record<string, unknown>>
    results: Array<Record<string, unknown>>
    properties: { dakar: Record<string, unknown> }
  }>
}

/** Inputs required to consolidate model and deterministic evidence. */
export interface SarifAssemblyInput {
  accepted?: Candidate[]
  candidates?: Candidate[]
  discarded?: Discarded[]
  gates?: DeterministicGateResult[]
  ledger?: LedgerEntry[]
  pricingTableVersion: string
  verdicts?: Verdict[]
}

/** Returns a stable severity mapping for SARIF result levels. */
function sarifLevel(severity: string): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error'
  if (severity === 'medium') return 'warning'
  return 'note'
}

/** Copies normalized Luna evidence without sharing a mutable object reference. */
function candidateEvidence(candidate: Candidate | { candidateId?: string }): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    ...('taskId' in candidate ? {
      taskId: candidate.taskId,
      taskKind: candidate.taskKind,
      sourceModel: candidate.sourceModel,
      verificationPolicy: candidate.verificationPolicy,
      title: candidate.title,
      severity: candidate.severity,
      path: candidate.path,
      line: candidate.line,
      detail: candidate.detail,
      evidence: candidate.evidence,
      confidence: candidate.confidence,
      policyRefs: [...candidate.policyRefs],
    } : {}),
  }
}

/** Builds a SARIF location only when normalized source evidence supplies a path. */
function locationsFor(candidate: Candidate | { candidateId?: string }): Array<Record<string, unknown>> {
  if (!('path' in candidate) || !candidate.path) return []
  return [{
    physicalLocation: {
      artifactLocation: { uri: candidate.path },
      region: candidate.line > 0 ? { startLine: candidate.line } : undefined,
    },
  }]
}

/** Finds the immutable Terra verdict for one stable candidate identifier. */
function verdictFor(candidateId: string | undefined, verdicts: Verdict[]): Verdict | undefined {
  return verdicts.find((verdict) => verdict.candidateId === candidateId)
}

/** Finds the Luna ledger row that supplies lane, tier, and estimated cost provenance. */
function ledgerFor(candidate: Candidate | { candidateId?: string }, ledger: LedgerEntry[]): LedgerEntry | undefined {
  if (!('taskId' in candidate)) return undefined
  return ledger.find((entry) => entry.callId === candidate.taskId)
}

/**
 * Assembles the canonical SARIF 2.1.0 document from immutable review evidence.
 *
 * Candidate identity and Luna evidence are copied into namespaced properties;
 * Terra verdicts are separate audit records and never overwrite the candidate.
 *
 * @param input - Normalized semantic evidence, deterministic gates, and cost ledger.
 * @returns One deterministic SARIF run containing every accepted and discarded item.
 */
export function assembleSarif(input: SarifAssemblyInput): DakarSarif {
  const candidates = [...(input.candidates || [])]
  const acceptedById = new Map(
    (input.accepted || []).map((candidate): [string, Candidate] => [candidate.candidateId, candidate]),
  )
  const verdicts = [...(input.verdicts || [])]
  const ledger = [...(input.ledger || [])]
  const discardById = new Map(
    (input.discarded || []).map((item): [string | undefined, Discarded] => [item.candidate.candidateId, item]),
  )
  const semanticResults = candidates
    .map((candidate) => {
      const accepted = acceptedById.get(candidate.candidateId)
      const discard = discardById.get(candidate.candidateId)
      const verdict = verdictFor(candidate.candidateId, verdicts)
      const sourceLedger = ledgerFor(candidate, ledger)
      const disposition = accepted
        ? {
            status: verdict?.status || 'accepted',
            reason: verdict?.reason || '',
            evidenceChecked: verdict?.evidenceChecked || '',
            acceptedSeverity: accepted.severity,
          }
        : {
            status: discard?.status || verdict?.status || 'not_selected',
            reason: discard?.reason || verdict?.reason || '',
            evidenceChecked: discard?.evidenceChecked || verdict?.evidenceChecked || '',
          }
      return {
        ruleId: `dakar/semantic/${candidate.candidateId}`,
        level: sarifLevel(accepted?.severity || candidate.severity),
        message: { text: candidate.title },
        locations: locationsFor(candidate),
        fingerprints: {
          'dakar/candidateId': candidate.candidateId,
          'dakar/semanticFingerprint': candidate.candidateId.slice(candidate.taskId.length + 1),
        },
        ...(accepted ? {} : { suppressions: [{ kind: 'external', status: 'accepted', justification: disposition.reason }] }),
        properties: {
          dakar: {
            kind: 'semantic',
            candidate: candidateEvidence(candidate),
            provenance: {
              taskId: candidate.taskId,
              taskKind: candidate.taskKind,
              model: candidate.sourceModel,
              lane: sourceLedger?.lane || 'luna-flex',
              serviceTier: sourceLedger?.serviceTier || 'flex',
              reasoningEffort: sourceLedger?.reasoningEffort,
            },
            audit: verdict ? { ...verdict } : null,
            disposition,
            clusterId: verdict?.clusterId,
            cost: sourceLedger ? { ...sourceLedger } : null,
            pricingTableVersion: input.pricingTableVersion,
          },
        },
      }
    })
    .sort((left, right) => {
      const leftId = left.fingerprints['dakar/candidateId']
      const rightId = right.fingerprints['dakar/candidateId']
      return leftId === rightId ? 0 : leftId < rightId ? -1 : 1
    })

  const knownCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId))
  const extraDiscards = (input.discarded || [])
    .filter((item) => !knownCandidateIds.has(item.candidate.candidateId || ''))
    .map((item) => ({
      ruleId: `dakar/semantic/${item.candidate.candidateId || 'unknown'}`,
      level: 'note',
      message: { text: item.reason },
      locations: locationsFor(item.candidate),
      fingerprints: { 'dakar/candidateId': item.candidate.candidateId || 'unknown' },
      suppressions: [{ kind: 'external', status: 'accepted', justification: item.reason }],
      properties: {
        dakar: {
          kind: 'semantic',
          candidate: candidateEvidence(item.candidate),
          provenance: null,
          audit: verdictFor(item.candidate.candidateId, verdicts) || null,
          disposition: { status: item.status, reason: item.reason, evidenceChecked: item.evidenceChecked },
          cost: null,
          pricingTableVersion: input.pricingTableVersion,
        },
      },
    }))

  const gateResults = (input.gates || [])
    .filter((gate) => gate.status !== 'passed')
    .map((gate) => ({
      ruleId: `dakar/gate/${gate.gateId}`,
      level: gate.blocking ? 'error' : 'warning',
      message: { text: `${gate.name} ${gate.status}: ${gate.command}` },
      fingerprints: { 'dakar/gateId': gate.gateId },
      properties: {
        dakar: {
          kind: 'deterministic-gate',
          gate: { ...gate },
          disposition: { status: gate.blocking ? 'blocking' : 'non-blocking' },
          pricingTableVersion: input.pricingTableVersion,
        },
      },
    }))

  const results = [...gateResults, ...semanticResults, ...extraDiscards]
  const ruleIds = [...new Set(results.map((result) => result.ruleId))].sort()
  const gates = (input.gates || []).map((gate) => ({ ...gate }))
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'Dakar',
          version: '0.1.0',
          rules: ruleIds.map((id) => ({ id, name: id })),
        },
      },
      invocations: [{
        executionSuccessful: gates.every((gate) => gate.status === 'passed' || !gate.blocking),
        properties: { dakar: { gates } },
      }],
      results,
      properties: {
        dakar: {
          pricingTableVersion: input.pricingTableVersion,
          ledger: ledger.map((entry) => ({ ...entry })),
          auditVerdicts: verdicts.map((verdict) => ({ ...verdict })),
        },
      },
    }],
  }
}

/** Returns Dakar-owned result properties from an untrusted SARIF result shape. */
function dakarProperties(result: Record<string, unknown>): Record<string, unknown> {
  const properties = result.properties
  if (!properties || typeof properties !== 'object') return {}
  const dakar = (properties as Record<string, unknown>).dakar
  return dakar && typeof dakar === 'object' ? dakar as Record<string, unknown> : {}
}

/**
 * Projects accepted compatibility findings from the canonical SARIF document.
 *
 * @param sarif - Dakar SARIF document.
 * @returns Existing CLI finding objects derived only from SARIF evidence.
 */
export function projectFindingsFromSarif(sarif: DakarSarif): Array<Record<string, unknown>> {
  const [run] = sarif.runs
  if (!run) return []
  return run.results.flatMap((result) => {
    const dakar = dakarProperties(result)
    if (dakar.kind !== 'semantic') return []
    const disposition = dakar.disposition as Record<string, unknown>
    if (!['accepted', 'severity_downgraded'].includes(String(disposition?.status))) return []
    const candidate = dakar.candidate as Record<string, unknown>
    const audit = dakar.audit as Record<string, unknown> | null
    return [{
      severity: disposition.acceptedSeverity || candidate.severity,
      path: candidate.path,
      line: Number(candidate.line) > 0 ? candidate.line : undefined,
      title: candidate.title,
      detail: candidate.detail || '',
      evidence: candidate.evidence || '',
      clusterId: audit?.clusterId || undefined,
      sourceTasks: [candidate.taskId],
    }]
  })
}

/**
 * Projects discarded compatibility records from the canonical SARIF document.
 *
 * @param sarif - Dakar SARIF document.
 * @returns Existing discard objects derived only from SARIF evidence.
 */
export function projectDiscardedFromSarif(sarif: DakarSarif): Discarded[] {
  const [run] = sarif.runs
  if (!run) return []
  return run.results.flatMap((result) => {
    const dakar = dakarProperties(result)
    if (dakar.kind !== 'semantic') return []
    const disposition = dakar.disposition as Record<string, unknown>
    if (['accepted', 'severity_downgraded'].includes(String(disposition?.status))) return []
    return [{
      candidate: dakar.candidate as unknown as Candidate,
      status: String(disposition?.status || ''),
      reason: String(disposition?.reason || ''),
      evidenceChecked: String(disposition?.evidenceChecked || ''),
    }]
  })
}

/**
 * Renders the stable Markdown projection from canonical SARIF evidence.
 *
 * @param sarif - Dakar SARIF document.
 * @returns Deterministic human-readable review report.
 */
export function renderSarifMarkdown(sarif: DakarSarif): string {
  const findings = projectFindingsFromSarif(sarif)
  const [run] = sarif.runs
  const gateFailures = (run?.results || []).filter((result) =>
    dakarProperties(result).kind === 'deterministic-gate')
  const blockingGateFailures = gateFailures.filter((result) => {
    const disposition = dakarProperties(result).disposition
    return disposition && typeof disposition === 'object'
      && (disposition as Record<string, unknown>).status === 'blocking'
  })
  const summary = blockingGateFailures.length > 0
    ? `${blockingGateFailures.length} blocking deterministic gate failure${blockingGateFailures.length === 1 ? '' : 's'} require remediation.`
    : findings.length === 0
    ? 'No blocking findings were accepted.'
    : `${findings.length} confirmed finding${findings.length === 1 ? '' : 's'} require changes.`
  return [
    '# Dakar review',
    '',
    summary,
    ...gateFailures.flatMap((result) => ['', `## deterministic gate: ${String((result.message as Record<string, unknown>).text)}`]),
    ...findings.flatMap((finding) => [
      '',
      `## ${finding.severity}: ${finding.title}`,
      '',
      `${finding.path}${finding.line ? `:${finding.line}` : ''}`,
      '',
      String(finding.detail),
      '',
      `Evidence: ${finding.evidence}`,
    ]),
  ].join('\n')
}
