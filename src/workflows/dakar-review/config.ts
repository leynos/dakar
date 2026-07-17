/** @file Validate workflow arguments and resolve immutable runtime configuration. */

import { adapterForReasoning, baseModel, DEFAULT_REVIEW_MODELS, isReasoning, modelName, reasoningFromModel } from './model-routing.ts'
import type {
  AgentInstructions,
  ModelSpec,
  NormalizedReviewPolicy,
  PolicyCustomCheck,
  PolicyPathInstruction,
  PreparedReview,
  Reasoning,
  UnknownObject,
} from './types.ts'


/**
 * Validate workflow arguments and resolve immutable runtime configuration.
 *
 * @module
 */

/** Summarizes the validated, immutable settings consumed by one workflow run. */
export interface WorkflowConfig {
  readonly adapterOverheadTokens: number
  /** Validated trusted-base instructions, or null when the raw argument was absent or malformed. */
  readonly agentInstructions: AgentInstructions | null
  /** Non-blank base ref to diff against, defaulting to `origin/main`. */
  readonly baseRef: string
  /** Raw config argument as supplied, defaulting to empty (auto-resolution) when blank. */
  readonly budgetGbp: number
  readonly configArg: string
  /** Whether the workflow should short-circuit with the dry-run contract instead of calling agents. */
  readonly dryRun: boolean
  /** Non-blank head ref to review up to, defaulting to `HEAD`. */
  readonly flexAttempts: number
  readonly flexInitialBackoffSeconds: number
  readonly flexJitterSeconds: number
  readonly flexMaxBackoffSeconds: number
  readonly headRef: string
  /** Global cap on normalized candidates, clamped to a positive integer no greater than 1,000. */
  readonly lunaReasoning: 'low' | 'medium'
  readonly perCallTimeoutSeconds: number
  readonly policyValid: boolean
  readonly maxAuditCandidates: number
  readonly maxCandidates: number
  /** Cap on accepted findings retained in the final report, clamped to a positive integer no greater than 200. */
  readonly maxFindings: number
  /** Cap on review tasks the task graph may schedule, clamped to a positive integer no greater than 64. */
  readonly maxLunaFlexCalls: number
  readonly maxTasks: number
  /** Non-blank repository root, defaulting to `.` when blank. */
  readonly prepared: PreparedReview | undefined
  readonly repoRoot: string
  /** Validated model assignments used for task routing; falls back to `DEFAULT_REVIEW_MODELS` when none are configured. */
  readonly reviewPolicy: Readonly<NormalizedReviewPolicy>
  readonly reviewModels: readonly Readonly<ModelSpec>[]
  /** Non-blank XDG state root used to locate review-history state, defaulting to empty when unset. */
  readonly routingPolicy: string
  readonly stateRoot: string
  /** Codex adapter selected for the synthesis reasoning level. */
  readonly synthesisAdapter: string
  /** Base synthesis model identifier with any reasoning suffix stripped. */
  readonly synthesisModelBase: string
  /** Full `model/reasoning` identifier used for synthesis agent calls. */
  readonly synthesisModelName: string
  /** Reasoning level applied to synthesis calls, resolved from the requested value or defaulting to `high`. */
  readonly synthesisReasoning: Reasoning
  /** Fixed ordered set of task kinds the workflow can classify changed files into. */
  readonly taskKinds: readonly string[]
  /** Fixed identifier for the current task-graph strategy, surfaced in run metrics. */
  readonly terraMaxInputTokens: number
  readonly terraMaxOutputTokens: number
  readonly transactionMaxFiles: number
  readonly transactionMaxInputTokens: number
  readonly transactionMaxOutputTokens: number
  readonly workflowVersion: string
}

/**
 * Tests whether an untrusted value is a non-null object.
 *
 * @param value - Value crossing the workflow argument boundary.
 * @returns Whether the value can be inspected as an object.
 */
function isObject(value: unknown): value is UnknownObject {
  return typeof value === 'object' && value !== null
}

/**
 * Normalizes an untrusted numeric limit to a positive bounded integer.
 *
 * @param value - Candidate number or numeric string from workflow arguments.
 * @param fallback - Positive value used when the candidate is invalid.
 * @param ceiling - Inclusive upper bound for a valid result.
 * @returns A positive integer no greater than the ceiling.
 */
function positiveLimit(value: unknown, fallback: number, ceiling: number): number {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
  const floored = Math.floor(parsed)
  return Number.isFinite(parsed) && floored > 0 ? Math.min(floored, ceiling) : fallback
}

/**
 * Normalizes an untrusted integer to a bounded range with an inclusive floor.
 *
 * Unlike {@link positiveLimit}, the lower bound may be zero, which suits token
 * overhead knobs whose valid range includes zero.
 *
 * @param value - Candidate number or numeric string from workflow arguments.
 * @param fallback - Value used when the candidate is invalid or below `min`.
 * @param min - Inclusive lower bound for a valid result.
 * @param max - Inclusive upper bound; larger candidates clamp to this value.
 * @returns A bounded integer within `[min, max]`.
 */
function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
  const floored = Math.floor(parsed)
  return Number.isFinite(parsed) && floored >= min ? Math.min(floored, max) : fallback
}

/**
 * Normalizes an untrusted real number to a bounded range with an inclusive floor.
 *
 * @param value - Candidate number or numeric string from workflow arguments.
 * @param fallback - Value used when the candidate is invalid or below `min`.
 * @param min - Inclusive lower bound for a valid result.
 * @param max - Inclusive upper bound; larger candidates clamp to this value.
 * @returns A bounded real number within `[min, max]`.
 */
function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= min ? Math.min(parsed, max) : fallback
}

/** The sole live routing policy; every other value clamps to it. */
const LIVE_ROUTING_POLICY = 'deterministic-flex-v1'

/** The set of live routing policies an untrusted value may resolve to. */
const LIVE_ROUTING_POLICIES: ReadonlySet<string> = new Set([LIVE_ROUTING_POLICY])

/**
 * Clamps an untrusted routing policy to a live policy.
 *
 * @param value - Untrusted routing-policy candidate from workflow arguments.
 * @returns The candidate when it names a live policy, otherwise the default.
 */
function liveRoutingPolicy(value: unknown): string {
  return typeof value === 'string' && LIVE_ROUTING_POLICIES.has(value) ? value : LIVE_ROUTING_POLICY
}

/**
 * Selects a non-blank string or a trusted fallback.
 *
 * @param value - Untrusted candidate value.
 * @param fallback - Value used when the candidate is not a non-blank string.
 * @returns The candidate string or fallback.
 */
function nonBlankString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/**
 * Validates optional trusted-base agent instructions supplied by the CLI.
 *
 * @param value - Untrusted workflow argument to validate field by field.
 * @returns A frozen instruction object, or null when the value is malformed.
 */
function configuredAgentInstructions(value: unknown): AgentInstructions | null {
  if (!isObject(value)) return null
  if (value.content !== undefined && typeof value.content !== 'string') return null
  if (value.source !== undefined && typeof value.source !== 'string') return null
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') return null
  return Object.freeze({
    content: value.content,
    source: value.source,
    truncated: value.truncated,
  })
}

/** Empty normalized policy used when direct workflow callers omit the hand-off. */
const EMPTY_REVIEW_POLICY: Readonly<NormalizedReviewPolicy> = Object.freeze({
  version: 1,
  pathInstructions: Object.freeze([]),
  customChecks: Object.freeze([]),
  ignoredKeys: Object.freeze([]),
})

/** Tests whether an object contains only the normalized contract's named keys. */
function hasOnlyKeys(value: UnknownObject, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

/** Validates one normalized path-instruction entry. */
function configuredPathInstruction(value: unknown): PolicyPathInstruction | null {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ['instructions', 'path', 'policyRef']) ||
    typeof value.instructions !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.policyRef !== 'string'
  ) return null
  return Object.freeze({ instructions: value.instructions, path: value.path, policyRef: value.policyRef })
}

/** Validates one normalized deterministic or model-mediated custom check. */
function configuredCustomCheck(value: unknown): PolicyCustomCheck | null {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ['blocking', 'command', 'gateId', 'instructions', 'name']) ||
    typeof value.blocking !== 'boolean' ||
    typeof value.gateId !== 'string' ||
    typeof value.name !== 'string' ||
    (value.command !== undefined && typeof value.command !== 'string') ||
    (value.instructions !== undefined && typeof value.instructions !== 'string')
  ) return null
  return Object.freeze({
    blocking: value.blocking,
    gateId: value.gateId,
    name: value.name,
    ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.instructions === undefined ? {} : { instructions: value.instructions }),
  })
}

/**
 * Validate the normalized review-policy hand-off supplied by the CLI.
 *
 * @param value - untrusted workflow argument.
 * @returns Frozen policy and a validity flag; omission is a valid empty policy.
 */
function configuredReviewPolicy(value: unknown): {
  policy: Readonly<NormalizedReviewPolicy>
  valid: boolean
} {
  if (value === undefined) return { policy: EMPTY_REVIEW_POLICY, valid: true }
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ['customChecks', 'ignoredKeys', 'language', 'pathInstructions', 'profile', 'toneInstructions', 'version']) ||
    value.version !== 1 ||
    !Array.isArray(value.pathInstructions) ||
    !Array.isArray(value.customChecks) ||
    !Array.isArray(value.ignoredKeys) ||
    !value.ignoredKeys.every((entry) => typeof entry === 'string') ||
    (value.language !== undefined && typeof value.language !== 'string') ||
    (value.profile !== undefined && typeof value.profile !== 'string') ||
    (value.toneInstructions !== undefined && typeof value.toneInstructions !== 'string')
  ) return { policy: EMPTY_REVIEW_POLICY, valid: false }
  const pathInstructions = value.pathInstructions.map(configuredPathInstruction)
  const customChecks = value.customChecks.map(configuredCustomCheck)
  if (pathInstructions.includes(null) || customChecks.includes(null)) {
    return { policy: EMPTY_REVIEW_POLICY, valid: false }
  }
  return {
    valid: true,
    policy: Object.freeze({
      version: 1,
      ...(value.language === undefined ? {} : { language: value.language }),
      ...(value.toneInstructions === undefined ? {} : { toneInstructions: value.toneInstructions }),
      ...(value.profile === undefined ? {} : { profile: value.profile }),
      pathInstructions: Object.freeze(pathInstructions) as readonly PolicyPathInstruction[],
      customChecks: Object.freeze(customChecks) as readonly PolicyCustomCheck[],
      ignoredKeys: Object.freeze([...value.ignoredKeys]),
    }),
  }
}

/**
 * Checks a model identifier and its optional reasoning suffix.
 *
 * @param value - Untrusted model identifier candidate.
 * @returns Whether the value is a non-blank model with at most one valid suffix.
 */
function validModelIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || /\s/u.test(value)) return false
  const [model, reasoning, extra] = value.split('/')
  return Boolean(model) && extra === undefined && (reasoning === undefined || isReasoning(reasoning))
}

/**
 * Filters untrusted model entries to internally consistent specifications.
 *
 * @param value - Candidate model list from workflow arguments.
 * @returns Valid model specifications in their supplied order.
 */
function configuredModels(value: unknown): ModelSpec[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (candidate): candidate is ModelSpec =>
      isObject(candidate) &&
      (candidate.label === undefined || typeof candidate.label === 'string') &&
      validModelIdentifier(candidate.model) &&
      (candidate.reasoning === 'low' || candidate.reasoning === 'medium' || candidate.reasoning === 'high') &&
      reasoningFromModel(candidate.model, candidate.reasoning) === candidate.reasoning &&
      (candidate.role === undefined || typeof candidate.role === 'string'),
  )
}

/**
 * Resolves untrusted workflow arguments into bounded, immutable configuration.
 *
 * @param value - Raw ODW arguments; malformed fields fall back to safe defaults.
 * @returns A frozen configuration whose limits and model identifiers are valid.
 */
export function resolveWorkflowConfig(value: unknown): WorkflowConfig {
  const args = isObject(value) ? value : {}
  const policy = configuredReviewPolicy(args.policy)
  const customModels = configuredModels(args.models)
  const reviewModels: readonly Readonly<ModelSpec>[] = customModels.length > 0
    ? Object.freeze(customModels.map((model) => Object.freeze({ ...model })))
    : DEFAULT_REVIEW_MODELS
  const synthesisModel = validModelIdentifier(args.synthesisModel) ? args.synthesisModel : 'gpt-5.5'
  const requestedReasoning = reasoningFromModel(
    synthesisModel,
    isReasoning(args.synthesisReasoning) ? args.synthesisReasoning : 'high',
  )
  const synthesisReasoning = isReasoning(requestedReasoning) ? requestedReasoning : 'high'
  const synthesisModelBase = baseModel(synthesisModel)
  return Object.freeze({
    // ADR 002 Flex admission knobs; all bounded so untrusted arguments cannot
    // widen the cost envelope beyond the documented ceilings.
    adapterOverheadTokens: boundedInteger(args.adapterOverheadTokens, 13_000, 0, 50_000),
    agentInstructions: configuredAgentInstructions(args.agentInstructions),
    baseRef: nonBlankString(args.base, 'origin/main'),
    budgetGbp: boundedNumber(args.budgetGbp, 0.1, 0.01, 10),
    configArg: nonBlankString(args.config, ''),
    dryRun: args.dryRun === true,
    // ADR 002 Flex retry and timeout budget (M5). This slice reduces the ADR's
    // default flexAttempts from 6 to 3 so the worst-case review wall clock fits
    // the harness's outer --timeout; all four knobs are bounded so untrusted
    // arguments cannot widen the retry envelope.
    flexAttempts: positiveLimit(args.flexAttempts, 3, 6),
    flexInitialBackoffSeconds: positiveLimit(args.flexInitialBackoffSeconds, 30, 300),
    flexJitterSeconds: boundedInteger(args.flexJitterSeconds, 10, 0, 60),
    flexMaxBackoffSeconds: positiveLimit(args.flexMaxBackoffSeconds, 120, 900),
    headRef: nonBlankString(args.head, 'HEAD'),
    lunaReasoning: args.lunaReasoning === 'medium' ? 'medium' : 'low',
    maxAuditCandidates: positiveLimit(args.maxAuditCandidates, 30, 100),
    maxCandidates: positiveLimit(args.maxCandidates, 30, 1_000),
    maxFindings: positiveLimit(args.maxFindings, 20, 200),
    maxLunaFlexCalls: positiveLimit(args.maxLunaFlexCalls, 4, 16),
    maxTasks: positiveLimit(args.maxTasks, 8, 64),
    perCallTimeoutSeconds: boundedInteger(args.perCallTimeoutSeconds, 300, 30, 900),
    policyValid: policy.valid,
    // Unvalidated passthrough: the CLI prepares the review range host-side and
    // main.ts validates these fields fail-closed before any downstream use.
    prepared: isObject(args.prepared) ? (args.prepared as PreparedReview) : undefined,
    repoRoot: nonBlankString(args.repoRoot, '.'),
    reviewPolicy: policy.policy,
    reviewModels,
    // Recorded in metrics and used (via the CLI) to gate the OPENAI_API_KEY
    // warning. Only 'deterministic-flex-v1' is a live policy, so any other value
    // clamps to it rather than passing through: an unknown policy must never be
    // recorded in metrics nor suppress the CLI's missing-key warning gate. This
    // module's style is clamp-with-default, so this never throws.
    routingPolicy: liveRoutingPolicy(args.routingPolicy),
    stateRoot: nonBlankString(args.stateRoot, ''),
    synthesisAdapter: adapterForReasoning(synthesisReasoning),
    synthesisModelBase,
    synthesisModelName: modelName({ model: synthesisModelBase, reasoning: synthesisReasoning }),
    synthesisReasoning,
    taskKinds: Object.freeze(['docs', 'config', 'tests', 'source', 'review-summary']),
    terraMaxInputTokens: boundedInteger(args.terraMaxInputTokens, 48_000, 1, 1_000_000),
    terraMaxOutputTokens: boundedInteger(args.terraMaxOutputTokens, 2_500, 1, 100_000),
    transactionMaxFiles: positiveLimit(args.transactionMaxFiles, 5, 20),
    transactionMaxInputTokens: boundedInteger(args.transactionMaxInputTokens, 12_000, 1, 200_000),
    transactionMaxOutputTokens: boundedInteger(args.transactionMaxOutputTokens, 750, 1, 100_000),
    workflowVersion: 'divide-and-conquer-v1',
  })
}
