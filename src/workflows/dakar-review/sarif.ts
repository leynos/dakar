/**
 * Assemble Dakar's canonical SARIF 2.1.0 evidence and projections.
 *
 * @module
 */

import type { Candidate, DeterministicGateResult, Discarded, LedgerEntry, Verdict } from './types.ts'

/** SARIF keeps explicit JSON nulls for its optional provenance records. */
const JSON_NULL: null = JSON.parse('null')

/** One SARIF rule descriptor emitted by the Dakar tool driver. */
interface SarifRuleDescriptor {
  /** Stable identifier referenced by each matching SARIF result. */
  id: string
  /** Human-readable rule name displayed by SARIF consumers. */
  name: string
}

/** Dakar provenance attached to one SARIF invocation record. */
interface SarifInvocationDakarProperties {
  /** Deterministic gates and their outcomes for this invocation. */
  gates: DeterministicGateResult[]
}

/** Namespaced properties on one SARIF invocation record. */
interface SarifInvocationProperties {
  /** Dakar-specific invocation metadata. */
  dakar: SarifInvocationDakarProperties
}

/** One SARIF invocation result, including gate execution status. */
interface SarifInvocation {
  /** Whether every blocking deterministic gate passed. */
  executionSuccessful: boolean
  /** Namespaced invocation metadata. */
  properties: SarifInvocationProperties
}

/** Dakar-specific run metadata shared by all SARIF results in the run. */
interface SarifRunDakarProperties {
  /** Version of the pricing table used to estimate calls. */
  pricingTableVersion: string
  /** Estimated model-call costs recorded during the review. */
  ledger: LedgerEntry[]
  /** Verifier outcomes recorded during the audit pass. */
  auditVerdicts: Verdict[]
}

/** Namespaced metadata attached to the SARIF run. */
interface SarifRunProperties {
  /** Dakar-specific run metadata. */
  dakar: SarifRunDakarProperties
}

/** Canonical SARIF schema URI used by every Dakar result. */
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'

/** Minimal structural type for Dakar's SARIF 2.1.0 result contract. */
export interface DakarSarif {
  /** SARIF schema URI, always set to {@link SARIF_SCHEMA}. */
  $schema: string
  /** SARIF specification version this document conforms to. */
  version: '2.1.0'
  /** One-element array holding Dakar's single deterministic review run. */
  runs: Array<{
    /** Tool component describing the Dakar driver and the rules it reported. */
    tool: {
      /** Driver metadata for the tool that produced the run. */
      driver: {
        /** Driver name, always `Dakar`. */
        name: string
        /** Driver version string. */
        version: string
        /** Rule descriptors, one per distinct rule id emitted in `results`. */
        rules: SarifRuleDescriptor[]
      }
    }
    /** Invocation records capturing overall execution success and gate provenance. */
    invocations: SarifInvocation[]
    /** SARIF results for deterministic gate failures and semantic candidates. */
    results: SarifResult[]
    /** Run-level namespaced Dakar provenance such as ledger and audit verdicts. */
    properties: SarifRunProperties
  }>
}

type CandidateEvidence = Candidate | { candidateId?: string }

interface SemanticDisposition {
  status: string
  reason: string
  evidenceChecked: string
  acceptedSeverity?: string
}

interface SemanticDakarProperties {
  kind: 'semantic'
  candidate: CandidateEvidence
  provenance: {
    taskId: string
    taskKind: string
    model: string
    lane: string
    serviceTier: string
    reasoningEffort?: string
  } | null
  audit: Verdict | null
  disposition?: SemanticDisposition | null
  clusterId?: string
  cost: LedgerEntry | null
  pricingTableVersion: string
}

interface GateDakarProperties {
  kind: 'deterministic-gate'
  gate: DeterministicGateResult
  disposition: { status: 'blocking' | 'non-blocking' }
  pricingTableVersion: string
}

interface SarifResult {
  ruleId: string
  level: 'error' | 'warning' | 'note'
  message: { text: string }
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string }
      region?: { startLine: number }
    }
  }>
  fingerprints: Record<string, string>
  suppressions?: Array<{ kind: 'external'; status: 'accepted'; justification: string }>
  properties: { dakar: SemanticDakarProperties | GateDakarProperties }
}

/** Inputs required to consolidate model and deterministic evidence. */
export interface SarifAssemblyInput {
  /** Candidates confirmed for reporting, keyed by candidate id to enrich results. */
  accepted?: Candidate[]
  /** All proposed candidates projected into semantic SARIF results. */
  candidates?: Candidate[]
  /** Candidates or unknown verdict references recorded as discards. */
  discarded?: Discarded[]
  /** Deterministic gate outcomes; non-passing gates become SARIF results. */
  gates?: DeterministicGateResult[]
  /** Priced call ledger supplying lane, tier, and cost provenance. */
  ledger?: LedgerEntry[]
  /** Pricing table version stamped onto every emitted result. */
  pricingTableVersion: string
  /** Verifier verdicts recorded as separate audit records per candidate. */
  verdicts?: Verdict[]
}

/** Evidence selected for one semantic SARIF result by the assembly pass. */
interface SemanticSarifEvidence {
  accepted: Candidate | undefined
  discard: Discarded | undefined
  verdict: Verdict | undefined
  sourceLedger: LedgerEntry | undefined
}

/** Returns a stable severity mapping for SARIF result levels. */
function sarifLevel(severity: string): SarifResult['level'] {
  if (severity === 'critical' || severity === 'high') return 'error'
  if (severity === 'medium') return 'warning'
  return 'note'
}

/** Copies normalized Luna evidence without sharing a mutable object reference. */
function candidateEvidence(candidate: CandidateEvidence): CandidateEvidence {
  if (!('taskId' in candidate)) return { candidateId: candidate.candidateId }
  return {
    candidateId: candidate.candidateId,
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
  }
}

/** Builds a SARIF location only when normalized source evidence supplies a path. */
function locationsFor(candidate: CandidateEvidence): NonNullable<SarifResult['locations']> {
  if (!('path' in candidate) || candidate.path === '') return []
  const physicalLocation: NonNullable<SarifResult['locations']>[number]['physicalLocation'] = {
    artifactLocation: { uri: candidate.path },
  }
  if (candidate.line > 0) physicalLocation.region = { startLine: candidate.line }
  return [{ physicalLocation }]
}

/** Finds the immutable Terra verdict for one stable candidate identifier. */
function verdictFor(candidateId: string | undefined, verdicts: Verdict[]): Verdict | undefined {
  return verdicts.find((verdict) => verdict.candidateId === candidateId)
}

/** Finds the Luna ledger row that supplies lane, tier, and estimated cost provenance. */
function ledgerFor(candidate: CandidateEvidence, ledger: LedgerEntry[]): LedgerEntry | undefined {
  if (!('taskId' in candidate)) return undefined
  return ledger.find((entry) => entry.callId === candidate.taskId)
}

/** Apply a verifier's audit fields, retaining the original truthy fallbacks. */
function verdictDisposition(verdict: Verdict | undefined, fallbackStatus: string): SemanticDisposition {
  return {
    status: verdict?.status || fallbackStatus,
    reason: verdict?.reason || '',
    evidenceChecked: verdict?.evidenceChecked || '',
  }
}

/** Independently prefer each truthy discard field over its verifier fallback. */
function discardDisposition(discard: Discarded | undefined, disposition: SemanticDisposition): SemanticDisposition {
  return {
    status: discard?.status || disposition.status,
    reason: discard?.reason || disposition.reason,
    evidenceChecked: discard?.evidenceChecked || disposition.evidenceChecked,
  }
}

/** Prefer accepted evidence, or independently override audit fields with a discard. */
function semanticDisposition(accepted: Candidate | undefined, discard: Discarded | undefined, verdict: Verdict | undefined): SemanticDisposition {
  const disposition = verdictDisposition(verdict, accepted ? 'accepted' : 'not_selected')
  if (accepted) return { ...disposition, acceptedSeverity: accepted.severity }
  return discardDisposition(discard, disposition)
}

/** Carry trusted task provenance and the ledger's optional routing details. */
function semanticProvenance(candidate: Candidate, sourceLedger: LedgerEntry | undefined) {
  return {
    taskId: candidate.taskId,
    taskKind: candidate.taskKind,
    model: candidate.sourceModel,
    lane: sourceLedger?.lane || 'luna-flex',
    serviceTier: sourceLedger?.serviceTier || 'flex',
    reasoningEffort: sourceLedger?.reasoningEffort,
  }
}

/** Project one normalized candidate into the canonical semantic SARIF shape. */
function semanticSarifResult(
  candidate: Candidate,
  evidence: SemanticSarifEvidence,
  pricingTableVersion: string,
): SarifResult {
  const { accepted, discard, verdict, sourceLedger } = evidence
  const disposition = semanticDisposition(accepted, discard, verdict)
  const dakar: SemanticDakarProperties = {
    kind: 'semantic',
    candidate: candidateEvidence(candidate),
    provenance: semanticProvenance(candidate, sourceLedger),
    audit: verdict === undefined ? JSON_NULL : { ...verdict },
    disposition,
    clusterId: verdict?.clusterId,
    cost: sourceLedger === undefined ? JSON_NULL : { ...sourceLedger },
    pricingTableVersion,
  }
  const result = {
    ruleId: `dakar/semantic/${candidate.candidateId}`,
    level: sarifLevel(accepted?.severity || candidate.severity),
    message: { text: candidate.title },
    locations: locationsFor(candidate),
    fingerprints: {
      'dakar/candidateId': candidate.candidateId,
      'dakar/semanticFingerprint': candidate.candidateId.slice(candidate.taskId.length + 1),
    },
  }
  if (accepted === undefined) {
    return {
      ...result,
      suppressions: [{ kind: 'external' as const, status: 'accepted' as const, justification: disposition.reason }],
      properties: { dakar },
    }
  }
  return { ...result, properties: { dakar } }
}

/** Project discards that were omitted from the candidate inventory. */
function extraDiscardResults(input: SarifAssemblyInput, candidates: Candidate[], verdicts: Verdict[]): SarifResult[] {
  const knownCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId))
  return (input.discarded || [])
    .filter((item) => !knownCandidateIds.has(item.candidate.candidateId || ''))
    .map((item) => {
      const candidateId = item.candidate.candidateId || 'unknown'
      const audit = verdictFor(item.candidate.candidateId, verdicts)
      const dakar: SemanticDakarProperties = {
        kind: 'semantic',
        candidate: candidateEvidence(item.candidate),
        provenance: JSON_NULL,
        audit: audit || JSON_NULL,
        disposition: { status: item.status, reason: item.reason, evidenceChecked: item.evidenceChecked },
        cost: JSON_NULL,
        pricingTableVersion: input.pricingTableVersion,
      }
      return {
        ruleId: `dakar/semantic/${candidateId}`,
        level: 'note',
        message: { text: item.reason },
        locations: locationsFor(item.candidate),
        fingerprints: { 'dakar/candidateId': candidateId },
        suppressions: [{ kind: 'external' as const, status: 'accepted' as const, justification: item.reason }],
        properties: { dakar },
      }
    })
}

/** Project non-passing deterministic gates into SARIF result records. */
function gateSarifResults(input: SarifAssemblyInput): SarifResult[] {
  return (input.gates || [])
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
}

/** Determine whether every gate passed or was explicitly non-blocking. */
function gatesAllowExecution(gates: DeterministicGateResult[]): boolean {
  return gates.every((gate) => gate.status === 'passed' || !gate.blocking)
}

/** Snapshot the optional candidate list before result enrichment and sorting. */
function candidateInventory(candidates: Candidate[] | undefined): Candidate[] {
  return [...(candidates || [])]
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
  const candidates = candidateInventory(input.candidates)
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
      return semanticSarifResult(candidate, { accepted, discard, verdict, sourceLedger }, input.pricingTableVersion)
    })
    .toSorted((left, right) => {
      const leftId = left.fingerprints['dakar/candidateId'] ?? ''
      const rightId = right.fingerprints['dakar/candidateId'] ?? ''
      return leftId === rightId ? 0 : (leftId < rightId ? -1 : 1)
    })

  const extraDiscards = extraDiscardResults(input, candidates, verdicts)
  const gateResults = gateSarifResults(input)
  const results = [...gateResults, ...semanticResults, ...extraDiscards]
  const ruleIds = [...new Set(results.map((result) => result.ruleId))].toSorted()
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
      invocations: [{ executionSuccessful: gatesAllowExecution(gates), properties: { dakar: { gates } } }],
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

/** Returns semantic results from the first run without changing projection order. */
function semanticResults(sarif: DakarSarif): SemanticDakarProperties[] {
  const [run] = sarif.runs
  if (run === undefined) return []
  return run.results.flatMap((result) => {
    const { dakar } = result.properties
    return dakar.kind === 'semantic' ? [dakar] : []
  })
}

interface CompatibilityFinding {
  severity: string
  path: string
  line: number | undefined
  title: string
  detail: string
  evidence: string
  clusterId: string | undefined
  sourceTasks: string[]
}

/** Converts accepted Dakar result properties to the legacy finding shape. */
function compatibilityFinding(dakar: SemanticDakarProperties): CompatibilityFinding {
  const { candidate } = dakar
  if (!('taskId' in candidate)) {
    return emptyCompatibilityFinding(dakar)
  }
  const { disposition, audit } = dakar
  return {
    severity: disposition?.acceptedSeverity || candidate.severity || 'low',
    path: candidate.path || '',
    line: positiveCompatibilityLine(candidate.line),
    title: candidate.title || '',
    detail: candidate.detail || '',
    evidence: candidate.evidence || '',
    clusterId: audit?.clusterId || undefined,
    sourceTasks: [candidate.taskId],
  }
}

/** Preserves the legacy blank projection for an accepted result without a candidate. */
function emptyCompatibilityFinding(dakar: SemanticDakarProperties): CompatibilityFinding {
  return {
    severity: dakar.disposition?.acceptedSeverity || 'low',
    path: '',
    line: undefined,
    title: '',
    detail: '',
    evidence: '',
    clusterId: dakar.audit?.clusterId || undefined,
    sourceTasks: [],
  }
}

/** Keeps only a positive line number in the legacy finding projection. */
function positiveCompatibilityLine(line: number | undefined): number | undefined {
  return line !== undefined && line > 0 ? line : undefined
}

/**
 * Projects accepted compatibility findings from the canonical SARIF document.
 *
 * @param sarif - Dakar SARIF document.
 * @returns Existing CLI finding objects derived only from SARIF evidence.
 */
export function projectFindingsFromSarif(sarif: DakarSarif): CompatibilityFinding[] {
  return semanticResults(sarif).flatMap((dakar) => {
    if (!['accepted', 'severity_downgraded'].includes(dakar.disposition?.status || '')) return []
    return [compatibilityFinding(dakar)]
  })
}

/** Converts one non-accepted Dakar result to the compatibility discard shape. */
function compatibilityDiscard(dakar: SemanticDakarProperties): Discarded {
  const { disposition } = dakar
  return {
    candidate: dakar.candidate,
    status: String(disposition?.status || ''),
    reason: String(disposition?.reason || ''),
    evidenceChecked: String(disposition?.evidenceChecked || ''),
  }
}

/**
 * Projects discarded compatibility records from the canonical SARIF document.
 *
 * @param sarif - Dakar SARIF document.
 * @returns Existing discard objects derived only from SARIF evidence.
 */
export function projectDiscardedFromSarif(sarif: DakarSarif): Discarded[] {
  return semanticResults(sarif).flatMap((dakar) => {
    if (['accepted', 'severity_downgraded'].includes(dakar.disposition?.status || '')) return []
    return [compatibilityDiscard(dakar)]
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
  const gateFailures = (run?.results || []).filter((result) => result.properties.dakar.kind === 'deterministic-gate')
  const blockingGateFailures = gateFailures.filter((result) => {
    const dakar = result.properties.dakar
    return dakar.kind === 'deterministic-gate' && dakar.disposition.status === 'blocking'
  })
  const summary = blockingGateFailures.length > 0
    ? `${blockingGateFailures.length} blocking deterministic gate failure${blockingGateFailures.length === 1 ? '' : 's'} require remediation.`
    : (findings.length === 0
    ? 'No blocking findings were accepted.'
    : `${findings.length} confirmed finding${findings.length === 1 ? '' : 's'} require changes.`)
  return [
    '# Dakar review',
    '',
    summary,
    ...gateFailures.flatMap((result) => ['', `## deterministic gate: ${result.message.text}`]),
    ...findings.flatMap((finding) => [
      '',
      `## ${finding.severity}: ${finding.title}`,
      '',
      `${finding.path}${finding.line ? `:${finding.line}` : ''}`,
      '',
      finding.detail,
      '',
      `Evidence: ${finding.evidence}`,
    ]),
  ].join('\n')
}
