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
  /** Instruction text applied to files matching `path`. */
  instructions: string
  /** Glob pattern selecting the files this instruction applies to. */
  path: string
  /** Policy reference identifying this instruction in prompt citations. */
  policyRef: string
}

/** Describes one validated deterministic or model-mediated custom check. */
export interface PolicyCustomCheck {
  /** Whether a failing check blocks the review outcome. */
  blocking: boolean
  /** Shell command run for a deterministic host-executed check. */
  command?: string
  /** Stable identifier correlating this check with its gate result. */
  gateId: string
  /** Model-facing instructions for a model-mediated check. */
  instructions?: string
  /** Human-readable check name. */
  name: string
}

/** Carries the normalized, serializable CodeRabbit policy subset. */
export interface NormalizedReviewPolicy {
  /** Validated custom checks, whether deterministic or model-mediated. */
  customChecks: readonly PolicyCustomCheck[]
  /** Raw policy keys dropped during normalization, retained for provenance. */
  ignoredKeys: readonly string[]
  /** Configured natural language for reviews, when specified. */
  language?: string
  /** Validated path-scoped review instructions. */
  pathInstructions: readonly PolicyPathInstruction[]
  /** CodeRabbit reviews profile, when specified. */
  profile?: string
  /** Reviewer tone guidance, when specified. */
  toneInstructions?: string
  /** Schema version literal for this normalized policy. */
  version: 1
}

/** Describes untrusted external arguments accepted by the workflow entry. */
export interface WorkflowArgs {
  /** Raw per-call adapter token overhead; validated and bounded during config resolution. */
  adapterOverheadTokens?: unknown
  /** Unvalidated instruction candidate; only trusted after `config.ts` field-checks it. */
  agentInstructions?: AgentInstructions
  /** Raw base ref argument, before falling back to the default when blank. */
  base?: string
  /** Raw review budget in GBP; validated and bounded before use. */
  budgetGbp?: unknown
  /** Raw CodeRabbit config path or name argument, passed through to config resolution. */
  config?: string
  /** Raw dry-run flag; only `true` (strict equality) enables dry-run mode. */
  dryRun?: boolean
  /** Raw Flex-attempt count; validated and clamped by `positiveLimit` before use. */
  flexAttempts?: unknown
  /** Raw initial Flex-retry backoff in seconds; validated and clamped before use. */
  flexInitialBackoffSeconds?: unknown
  /** Raw Flex-retry jitter ceiling in seconds; validated and bounded before use. */
  flexJitterSeconds?: unknown
  /** Raw maximum Flex-retry backoff in seconds; validated and clamped before use. */
  flexMaxBackoffSeconds?: unknown
  /** Raw head ref argument, before falling back to `HEAD` when blank. */
  head?: string
  /** Raw Luna finder reasoning level; only `medium` overrides the `low` default. */
  lunaReasoning?: unknown
  /** Raw audit-candidate cap; validated and clamped by `positiveLimit` before use. */
  maxAuditCandidates?: unknown
  /** Raw candidate cap; validated and clamped by `positiveLimit` before use. */
  maxCandidates?: unknown
  /** Raw findings cap; validated and clamped by `positiveLimit` before use. */
  maxFindings?: unknown
  /** Raw Luna Flex call cap; validated and clamped by `positiveLimit` before use. */
  maxLunaFlexCalls?: unknown
  /** Raw task cap; validated and clamped by `positiveLimit` before use. */
  maxTasks?: unknown
  /** Raw model list; entries are individually validated by `configuredModels`. */
  models?: unknown
  /** Raw per-call timeout in seconds; validated and bounded before use. */
  perCallTimeoutSeconds?: unknown
  /** Raw normalized review policy; validated at the workflow boundary before use. */
  policy?: unknown
  /** Optional host-prepared review range, reused instead of recomputing the diff. */
  prepared?: PreparedReview
  /** Raw repository root argument, before falling back to `.` when blank. */
  repoRoot?: string
  /** Raw live routing policy identifier; constrained to a known value before use. */
  routingPolicy?: unknown
  /** Raw XDG state root argument used to locate review-history state. */
  stateRoot?: string
  /** Raw synthesis model identifier, validated against `validModelIdentifier`. */
  synthesisModel?: string
  /** Raw synthesis reasoning override, validated against the supported levels. */
  synthesisReasoning?: string
  /** Raw input-token cap for the Terra audit lane; validated and bounded before use. */
  terraMaxInputTokens?: unknown
  /** Raw output-token cap for the Terra audit lane; validated and bounded before use. */
  terraMaxOutputTokens?: unknown
  /** Raw per-pack file cap for the Luna finder lane; validated and clamped before use. */
  transactionMaxFiles?: unknown
  /** Raw input-token cap for the Luna finder lane; validated and bounded before use. */
  transactionMaxInputTokens?: unknown
  /** Raw output-token cap for the Luna finder lane; validated and bounded before use. */
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
  /** Host-executed deterministic gate results carried into the review. */
  deterministicGates?: DeterministicGateResult[]
}

/** Captures one host-executed deterministic check without secret-bearing environment data. */
export interface DeterministicGateResult {
  /** Whether a failing gate blocks the review outcome. */
  blocking: boolean
  /** Shell command that was executed for this gate. */
  command: string
  /** Process exit code, or null when the gate was terminated by a signal. */
  exitCode: number | null
  /** Stable identifier for this gate, mirroring the policy check id. */
  gateId: string
  /** Human-readable gate name. */
  name: string
  /** Terminating signal name, or null when the process exited normally. */
  signal?: string | null
  /** Gate outcome: passed, failed, or errored before completion. */
  status: 'passed' | 'failed' | 'error'
  /** Captured standard-error output. */
  stderr: string
  /** Hex SHA-256 digest of the captured standard-error output. */
  stderrSha256: string
  /** Captured standard output. */
  stdout: string
  /** Hex SHA-256 digest of the captured standard output. */
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
  /** Reasoning effort from the assigned Flex lane, mirrored into task metrics. */
  reasoningEffort?: string
  /** Logical review role (`high`, `medium`, `mini`, or `spark`) selected from the task kind. */
  role: string
  /** Service tier from the assigned Flex lane, mirrored into task metrics. */
  serviceTier?: string
  /** Stable identifier correlating this task with its result, verdicts, and metrics. */
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
  /** Remediation cluster assigned to the candidate once a verdict has been reconciled. */
  clusterId?: string
  /** Evidence the verifier examined; set once a verdict has been reconciled. */
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
  /** Remediation cluster this verdict was grouped into during audit reconciliation. */
  clusterId?: string
  /** Evidence the verifier examined to reach this decision; must be non-blank for a valid verdict. */
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
  /** Verifier decisions for the audited candidates. */
  verdicts: Verdict[]
  /** Optional natural-language summary of the audit. */
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
  /** Resolved, normalized review policy shared across prompts. */
  policy: NormalizedReviewPolicy
  /** Resolved review-policy or config path shared across prompts. */
  policyPath: string
  /** Repository root shared across prompts. */
  repoRoot: string
}

/** Records one refused model call and why admission control rejected it. */
export interface AdmissionRefusal {
  /** Identifier of the refused call. */
  callId: string
  /** Which Flex lane the refused call belonged to. */
  kind: 'luna-transaction' | 'terra-audit'
  /** Human-readable explanation for the refusal. */
  reason: string
  /** Estimated worst-case cost in US dollars that would have exceeded the budget. */
  worstCaseUsd: number
}

/** Records one finder pack that exhausted its Flex retries and was downgraded. */
export interface LunaDowngrade {
  /** Identifier of the finder pack that was downgraded. */
  taskId: string
  /** Human-readable explanation for the downgrade. */
  reason: string
  /** Number of Flex attempts made before the pack was downgraded. */
  attempts: number
}

/** Records one priced, admitted call for the budget audit trail. */
export interface LedgerEntry {
  /** Identifier of the priced, admitted call. */
  callId: string
  /** Workflow phase in which the call was made. */
  phase: string
  /** Flex lane or standard tier the call was routed through. */
  lane: 'luna-flex' | 'terra-flex' | 'standard'
  /** Model identifier used for the call. */
  model: string
  /** Service tier the call was admitted under. */
  serviceTier: string
  /** Reasoning level applied to the call. */
  reasoningEffort: string
  /** Cumulative estimated worst-case cost in US dollars charged across the call's attempts. */
  estimatedWorstCaseUsd: number
  /** Version of the pricing table used to estimate the cost. */
  pricingTableVersion: string
  /** Number of attempts admitted and charged for the call. */
  attempts: number
}
