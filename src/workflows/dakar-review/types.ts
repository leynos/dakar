/** @file Declare the data contracts shared by the typed workflow modules. */

export type UnknownObject = Record<string, unknown>
export type Reasoning = 'low' | 'medium' | 'high'

export interface ModelSpec {
  label?: string
  model: string
  reasoning: Reasoning
  role?: string
}

export interface AgentInstructions {
  content?: string
  source?: string
  truncated?: boolean
}

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
  repoRoot?: string
  stateRoot?: string
  synthesisModel?: string
  synthesisReasoning?: string
}

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

export interface BoundCandidateResult {
  result: CandidateResult
  task: ReviewTask
}

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

export interface Discarded {
  candidate: Candidate | { candidateId?: string }
  evidenceChecked: string
  reason: string
  status: string
}

export interface SynthesisResult {
  findings?: unknown[]
  metrics?: UnknownObject
  reportMarkdown?: string
  summary?: string
  verdict?: string
}

export interface ConfigResult {
  config?: string
  checked?: string[]
  error?: string
  ok: boolean
  source?: 'explicit' | 'repository' | 'user' | 'example'
}

export interface RecordResult {
  error?: string
  headCommit?: string
  ok: boolean
  stateFile?: string
  stderr?: string
  stdout?: string
}

export interface PromptContext {
  agentInstructions: AgentInstructions | null
  policyPath: string
  repoRoot: string
}
