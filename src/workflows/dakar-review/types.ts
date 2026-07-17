/**
 * Declare the data contracts shared by the typed workflow modules.
 *
 * @module
 */

/** Represents an untrusted object whose fields require runtime narrowing. */
export type UnknownObject = Record<string, unknown>

/** Enumerates the reasoning levels supported by Dakar's Codex adapters. */
export type Reasoning = 'low' | 'medium' | 'high'

/** Describes one configured model, reasoning level, label, and review role. */
export interface ModelSpec {
  /** Human-readable name surfaced in dry-run output and task metrics. */
  label?: string
  /** Base model identifier, with or without a `/reasoning` suffix. */
  model: string
  /** Reasoning level used to pick the adapter and, when absent, the model suffix. */
  reasoning: Reasoning
  /** Logical review role (e.g. `high`, `medium`, `mini`, `spark`) matched by `modelForRole`. */
  role?: string
}

/** Carries trusted-base repository instructions and truncation provenance. */
export interface AgentInstructions {
  /** Trusted-base instruction text to inject into review and synthesis prompts. */
  content?: string
  /** Provenance label describing where the instructions were sourced from. */
  source?: string
  /** Whether the content was cut down before being included, so prompts can note the loss. */
  truncated?: boolean
}

/** Describes one validated path-scoped instruction from review policy. */
export interface PolicyPathInstruction {
  instructions: string
  path: string
  policyRef: string
}

/** Describes one validated deterministic or model-mediated custom check. */
export interface PolicyCustomCheck {
  blocking: boolean
  command?: string
  gateId: string
  instructions?: string
  name: string
}

/** Carries the normalized, serializable CodeRabbit policy subset. */
export interface NormalizedReviewPolicy {
  customChecks: readonly PolicyCustomCheck[]
  ignoredKeys: readonly string[]
  language?: string
  pathInstructions: readonly PolicyPathInstruction[]
  profile?: string
  toneInstructions?: string
  version: 1
}

/** Describes untrusted external arguments accepted by the workflow entry. */
export interface WorkflowArgs {
  adapterOverheadTokens?: unknown
  /** Unvalidated instruction candidate; only trusted after `config.ts` field-checks it. */
  agentInstructions?: AgentInstructions
  /** Raw base ref argument, before falling back to the default when blank. */
  base?: string
  /** Raw config path/name argument passed through to config resolution. */
  budgetGbp?: unknown
  config?: string
  /** Raw dry-run flag; only `true` (strict equality) enables dry-run mode. */
  dryRun?: boolean
  /** Raw head ref argument, before falling back to `HEAD` when blank. */
  flexAttempts?: unknown
  flexInitialBackoffSeconds?: unknown
  flexJitterSeconds?: unknown
  flexMaxBackoffSeconds?: unknown
  head?: string
  /** Raw candidate cap; validated and clamped by `positiveLimit` before use. */
  lunaReasoning?: unknown
  maxAuditCandidates?: unknown
  maxCandidates?: unknown
  /** Raw findings cap; validated and clamped by `positiveLimit` before use. */
  maxFindings?: unknown
  /** Raw task-budget cap; validated and clamped by `positiveLimit` before use. */
  maxLunaFlexCalls?: unknown
  maxTasks?: unknown
  /** Raw model list; entries are individually validated by `configuredModels`. */
  models?: unknown
  /** Raw repository root argument, before falling back to `.` when blank. */
  perCallTimeoutSeconds?: unknown
  policy?: unknown
  prepared?: PreparedReview
  repoRoot?: string
  /** Raw XDG state root argument used to locate review-history state. */
  routingPolicy?: unknown
  stateRoot?: string
  /** Raw synthesis model identifier, validated against `validModelIdentifier`. */
  synthesisModel?: string
  /** Raw synthesis reasoning override, validated against the supported levels. */
  synthesisReasoning?: string
  terraMaxInputTokens?: unknown
  terraMaxOutputTokens?: unknown
  transactionMaxFiles?: unknown
  transactionMaxInputTokens?: unknown
  transactionMaxOutputTokens?: unknown
}

/** Captures the deterministic review range returned by the state helper. */
export interface PreparedReview {
  /** True when this head commit was already recorded reviewed; the workflow returns early. */
  alreadyReviewed?: boolean
  /** Repository-relative changed-file paths; doubles as the containment whitelist for candidates. */
  changedFiles?: string[]
  /** Count of unreviewed commits in the range; zero alongside `alreadyReviewed` also short-circuits the run. */
  commitCount?: number
  /** Human-readable diff summary carried through unchanged into the final metrics. */
  diffStat?: string
  /** Resolved head commit hash; validated as a 40- or 64-hex-character sha before use. */
  headCommit?: string
  /** Whether the prepare step itself succeeded. */
  ok?: boolean
  /** Resolved base commit hash the diff and task graph are computed against. */
  reviewBase?: string
  /** Path to the review-history state file the record step will update. */
  stateFile?: string
  /** Non-fatal prepare-stage warnings surfaced verbatim in the final run metrics. */
  warnings?: string[]
  deterministicGates?: DeterministicGateResult[]
}

/** Captures one host-executed deterministic check without secret-bearing environment data. */
export interface DeterministicGateResult {
  blocking: boolean
  command: string
  exitCode: number | null
  gateId: string
  name: string
  signal?: string | null
  status: 'passed' | 'failed' | 'error'
  stderr: string
  stderrSha256: string
  stdout: string
  stdoutSha256: string
}

/** Defines one bounded, model-routed unit of changed-file review work. */
export interface ReviewTask {
  /** Codex adapter name derived from the assigned model's reasoning level. */
  adapter: string
  /** Full `model/reasoning` identifier passed to the agent primitive. */
  assignedModel: string
  /** Changed files assigned exclusively to this task; no file appears in more than one task. */
  files: string[]
  /** `classifyPath` category, or `review-summary` for the mandatory closing task. */
  kind: string
  /** Per-task cap on proposed findings, tighter than the workflow-wide `maxCandidates` clamp. */
  maxFindings: number
  /** Base model identifier (reasoning suffix stripped) used for the adapter call. */
  model: string
  /** Optional friendly label surfaced in dry-run and metrics output. */
  modelLabel?: string
  /** Review role (`high`, `medium`, `mini`, or `spark`) that drove model selection and verification stringency. */
  reasoningEffort?: string
  role: string
  /** Stable identifier correlating this task with its result, verdicts, and metrics. */
  serviceTier?: string
  taskId: string
  /** `verify-all` or `verify-non-low-and-sampled-low`, consumed by `candidatesForVerification`. */
  verificationPolicy: string
}

/** Describes a schema-validated finding proposed by a review task. */
export interface RawCandidate {
  /** Finder's self-reported confidence; not itself verified before use. */
  confidence: 'high' | 'medium' | 'low'
  /** Finder's explanation of the issue. */
  detail: string
  /** Finder's cited support for the finding, later echoed into the verification prompt. */
  evidence: string
  /** Optional 1-based line number within `path`; defaults to 0 when absent. */
  line?: number
  /** Untrusted candidate path; must be checked against the reviewed changed-file set before use. */
  path: string
  /** Optional review-policy citations tied to the finding. */
  policyRefs?: string[]
  /** Finder's reported severity, used for sorting and later possibly downgraded by a verifier. */
  severity: 'critical' | 'high' | 'medium' | 'low'
  /** Short finding title; also feeds the deduplication key in `candidateKey`. */
  title: string
}

/** Captures one review task's candidate output and coverage metrics. */
export interface CandidateResult {
  /** Untrusted findings proposed by the task; validated and trimmed by `normalizeCandidates`. */
  candidates: RawCandidate[]
  /** Coverage counters echoed into the run-level metrics. */
  metrics: {
    /** Number of files the task actually examined. */
    filesInspected: number
    /** Number of findings the task proposed before deduplication and capping. */
    findingsProposed: number
    /** Explicit "nothing to report" signal, distinguishing an empty result from an omission. */
    noFindings?: boolean
  }
  /** Explanation supplied when the task explicitly found nothing. */
  noFindingsReason?: string
  /** Task-level natural-language summary. */
  summary: string
  /** Identifier correlating this result with its scheduled task. */
  taskId: string
}

/** Binds a candidate result to the trusted task that produced it. */
export interface BoundCandidateResult {
  /** Untrusted candidate result returned by the agent call. */
  result: CandidateResult
  /** Trusted task specification that produced `result`. */
  task: ReviewTask
}

/** Enriches a raw candidate with trusted task and verification metadata. */
export interface Candidate extends RawCandidate {
  /** Stable identity combining the task id with a normalized path/line/title key. */
  candidateId: string
  /** Line number, defaulted to 0 when the finder omitted one. */
  line: number
  /** Candidate path, narrowed to required after passing the changed-file whitelist check. */
  path: string
  /** Policy citations, defaulted to an empty array when the finder omitted them. */
  policyRefs: string[]
  /** Model identifier of the task that proposed this candidate. */
  sourceModel: string
  /** Identifier of the task that proposed this candidate. */
  taskId: string
  /** Review kind of the task that proposed this candidate (mirrors `ReviewTask.kind`). */
  taskKind: string
  /** Finding title, narrowed to required after passing validation. */
  title: string
  /** Verification policy inherited from the originating task. */
  verificationPolicy: string
  /** Evidence the verifier examined; set once a verdict has been reconciled. */
  clusterId?: string
  evidenceChecked?: string
  /** Verifier's justification; set once a verdict has been reconciled. */
  verificationReason?: string
  /** Verifier's disposition; set once a verdict has been reconciled. */
  verificationStatus?: string
}

/** Describes one verifier decision for a scheduled candidate identifier. */
export interface Verdict {
  /** Downgraded severity for a `severity_downgraded` verdict; must rank less severe than the original. */
  acceptedSeverity?: 'critical' | 'high' | 'medium' | 'low'
  /** Identifier of the scheduled candidate this verdict decides. */
  candidateId: string
  /** Evidence the verifier examined to reach this decision; must be non-blank for a valid verdict. */
  clusterId?: string
  evidenceChecked: string
  /** Verifier's free-text justification; must be non-blank for a valid verdict. */
  reason: string
  /** Verifier's disposition for the candidate. */
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

/** Captures the single issue-set audit response returned by the audit lane. */
export interface AuditResult {
  verdicts: Verdict[]
  summary?: string
}

/** Records why a candidate or unknown verifier reference was not accepted. */
export interface Discarded {
  /** The discarded candidate, or a minimal stub when a verdict referenced an unknown candidate id. */
  candidate: Candidate | {
    /** Candidate id copied from an unrecognized verdict, kept for audit traceability. */
    candidateId?: string
  }
  /** Evidence backing the discard decision; empty for sampling and overflow discards that had no verdict. */
  evidenceChecked: string
  /** Human-readable explanation for the discard. */
  reason: string
  /** Discard category: mirrors `Verdict.status` plus workflow-specific reasons such as `max_findings_exceeded`. */
  status: string
}

/** Bundles trusted repository, policy, and instruction data for prompt builders. */
export interface PromptContext {
  /** Trusted-base instructions to weave into every prompt built from this context. */
  agentInstructions: AgentInstructions | null
  /** Resolved review-policy/config path shared across prompts. */
  policy: NormalizedReviewPolicy
  policyPath: string
  /** Repository root shared across prompts. */
  repoRoot: string
}

/** Records one refused model call and why admission control rejected it. */
export interface AdmissionRefusal {
  callId: string
  kind: 'luna-transaction' | 'terra-audit'
  reason: string
  worstCaseUsd: number
}

/** Records one finder pack that exhausted its Flex retries and was downgraded. */
export interface LunaDowngrade {
  taskId: string
  reason: string
  attempts: number
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
  pricingTableVersion: string
  attempts: number
}
