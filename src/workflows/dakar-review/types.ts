/** @file Declare the data contracts shared by the typed workflow modules. */

/** Represents an untrusted object whose fields require runtime narrowing. */
export type UnknownObject = Record<string, unknown>

/** Enumerates the reasoning levels supported by Dakar's Codex adapters. */
export type Reasoning = 'low' | 'medium' | 'high'

/** Describes one configured model, reasoning level, label, and review role. */
export interface ModelSpec {
  label?: string
  model: string
  reasoning: Reasoning
  role?: string
}

/** Carries trusted-base repository instructions and truncation provenance. */
export interface AgentInstructions {
  content?: string
  source?: string
  truncated?: boolean
}

/** Describes untrusted external arguments accepted by the workflow entry. */
export interface WorkflowArgs {
  agentInstructions?: AgentInstructions
  base?: string
  config?: string
  dryRun?: boolean
  head?: string
  maxCandidates?: unknown
  maxFindings?: unknown
  maxTasks?: unknown
  models?: unknown
  prepared?: PreparedReview
  repoRoot?: string
  stateRoot?: string
  synthesisModel?: string
  synthesisReasoning?: string
}

/** Captures the deterministic review range returned by the state helper. */
export interface PreparedReview {
  alreadyReviewed?: boolean
  changedFiles?: string[]
  commitCount?: number
  diffStat?: string
  headCommit?: string
  ok?: boolean
  reviewBase?: string
  stateFile?: string
  warnings?: string[]
}

/** Defines one bounded, model-routed unit of changed-file review work. */
export interface ReviewTask {
  adapter: string
  assignedModel: string
  files: string[]
  kind: string
  maxFindings: number
  model: string
  modelLabel?: string
  role: string
  taskId: string
  verificationPolicy: string
}

/** Describes a schema-validated finding proposed by a review task. */
export interface RawCandidate {
  confidence: 'high' | 'medium' | 'low'
  detail: string
  evidence: string
  line?: number
  path: string
  policyRefs?: string[]
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
}

/** Captures one review task's candidate output and coverage metrics. */
export interface CandidateResult {
  candidates: RawCandidate[]
  metrics: {
    filesInspected: number
    findingsProposed: number
    noFindings?: boolean
  }
  noFindingsReason?: string
  summary: string
  taskId: string
}

/** Binds a candidate result to the trusted task that produced it. */
export interface BoundCandidateResult {
  result: CandidateResult
  task: ReviewTask
}

/** Enriches a raw candidate with trusted task and verification metadata. */
export interface Candidate extends RawCandidate {
  candidateId: string
  line: number
  path: string
  policyRefs: string[]
  sourceModel: string
  taskId: string
  taskKind: string
  title: string
  verificationPolicy: string
  evidenceChecked?: string
  verificationReason?: string
  verificationStatus?: string
}

/** Describes one verifier decision for a scheduled candidate identifier. */
export interface Verdict {
  acceptedSeverity?: 'critical' | 'high' | 'medium' | 'low'
  candidateId: string
  evidenceChecked: string
  reason: string
  status:
    | 'accepted'
    | 'duplicate'
    | 'out_of_scope'
    | 'not_applicable'
    | 'insufficient_evidence'
    | 'speculative'
    | 'tool_false_positive'
    | 'severity_downgraded'
    | 'needs_human'
}

/** Records why a candidate or unknown verifier reference was not accepted. */
export interface Discarded {
  candidate: Candidate | { candidateId?: string }
  evidenceChecked: string
  reason: string
  status: string
}

/** Bundles trusted repository, policy, and instruction data for prompt builders. */
export interface PromptContext {
  agentInstructions: AgentInstructions | null
  policyPath: string
  repoRoot: string
}

/** Records one priced, admitted call for the budget audit trail. */
export interface LedgerEntry {
  callId: string
  phase: string
  lane: 'luna-flex' | 'terra-flex' | 'standard'
  model: string
  serviceTier: string
  reasoningEffort: string
  estimatedWorstCaseUsd: number
  reportedUsage?: {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
  }
  reportedUsd?: number // reportedUsage priced with the table
  pricingTableVersion: string
  attempts: number
}
