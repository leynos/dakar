/**
 * Validate workflow arguments and resolve immutable runtime configuration.
 *
 * @module
 */

import * as z from 'zod'
import { adapterForReasoning, baseModel, DEFAULT_REVIEW_MODELS, isReasoning, modelName, reasoningFromModel } from './model-routing.ts'
import type {
  AgentInstructions,
  JsonValue,
  ModelSpec,
  NormalizedReviewPolicy,
  PreparedReview,
  Reasoning,
  WorkflowArgs,
} from './types.ts'

const numericArgumentSchema = z.union([z.number(), z.string()])
const reasoningSchema = z.enum(['low', 'medium', 'high'])
/** JSON null marks the existing absent-or-invalid agent-instructions contract. */
const NO_AGENT_INSTRUCTIONS: null = JSON.parse('null')
const agentInstructionsSchema = z.object({
  content: z.string().optional(),
  source: z.string().optional(),
  truncated: z.boolean().optional(),
})
const pathInstructionSchema = z.strictObject({
  instructions: z.string(),
  path: z.string(),
  policyRef: z.string(),
})
const customCheckSchema = z.strictObject({
  blocking: z.boolean(),
  command: z.string().optional(),
  gateId: z.string(),
  instructions: z.string().optional(),
  name: z.string(),
})
const reviewPolicySchema = z.strictObject({
  customChecks: z.array(customCheckSchema),
  ignoredKeys: z.array(z.string()),
  language: z.string().optional(),
  pathInstructions: z.array(pathInstructionSchema),
  profile: z.string().optional(),
  toneInstructions: z.string().optional(),
  version: z.literal(1),
})
const modelSpecSchema = z.strictObject({
  label: z.string().optional(),
  model: z.string(),
  reasoning: reasoningSchema,
  role: z.string().optional(),
})
function optionalParsed<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((candidate) => {
    const parsed = schema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }, schema.optional())
}

const modelCandidateSchema = optionalParsed(modelSpecSchema)
const deterministicGateSchema = z.strictObject({
  blocking: z.boolean(),
  command: z.string(),
  exitCode: z.union([z.number(), z.null()]),
  gateId: z.string(),
  name: z.string(),
  signal: z.union([z.string(), z.null()]).optional(),
  status: z.enum(['passed', 'failed', 'error']),
  stderr: z.string(),
  stderrSha256: z.string(),
  stdout: z.string(),
  stdoutSha256: z.string(),
})
/** Prepared review boundary schema. @internal */
export const preparedReviewSchema = z.looseObject({
  alreadyReviewed: z.boolean().optional(),
  changedFiles: z.array(z.string()).optional(),
  commitCount: z.number().optional(),
  deterministicGates: z.array(deterministicGateSchema).optional(),
  diffStat: z.string().optional(),
  headCommit: z.string().optional(),
  ok: z.boolean().optional(),
  reviewBase: z.string().optional(),
  stateFile: z.string().optional(),
  warnings: z.array(z.string()).optional(),
})
const numericArgumentField = optionalParsed(numericArgumentSchema)
const stringArgumentField = optionalParsed(z.string())
const reasoningArgumentField = optionalParsed(reasoningSchema)
/** Workflow argument boundary schema. @internal */
export const workflowArgsSchema = z.looseObject({
  adapterOverheadTokens: numericArgumentField,
  agentInstructions: optionalParsed(agentInstructionsSchema),
  base: stringArgumentField,
  budgetGbp: numericArgumentField,
  config: stringArgumentField,
  dryRun: optionalParsed(z.boolean()),
  flexAttempts: numericArgumentField,
  flexInitialBackoffSeconds: numericArgumentField,
  flexJitterSeconds: numericArgumentField,
  flexMaxBackoffSeconds: numericArgumentField,
  head: stringArgumentField,
  lunaReasoning: reasoningArgumentField,
  maxAuditCandidates: numericArgumentField,
  maxCandidates: numericArgumentField,
  maxFindings: numericArgumentField,
  maxLunaFlexCalls: numericArgumentField,
  maxTasks: numericArgumentField,
  models: optionalParsed(z.array(modelCandidateSchema)),
  perCallTimeoutSeconds: numericArgumentField,
  policy: optionalParsed(z.json()),
  prepared: optionalParsed(preparedReviewSchema),
  repoRoot: stringArgumentField,
  contextGuidance: stringArgumentField,
  routingPolicy: stringArgumentField,
  stateRoot: stringArgumentField,
  synthesisModel: stringArgumentField,
  synthesisReasoning: reasoningArgumentField,
  terraMaxInputTokens: numericArgumentField,
  terraMaxOutputTokens: numericArgumentField,
  transactionMaxFiles: numericArgumentField,
  transactionMaxInputTokens: numericArgumentField,
  transactionMaxOutputTokens: numericArgumentField,
})

/** Summarizes the validated, immutable settings consumed by one workflow run. */
export interface WorkflowConfig {
  /** Per-call token overhead the adapter reserves, bounded to 0–50,000 tokens. */
  readonly adapterOverheadTokens: number
  /** Validated trusted-base instructions, or null when absent or malformed. */
  readonly agentInstructions: AgentInstructions | null
  /** Non-blank base ref to diff against, defaulting to `origin/main`. */
  readonly baseRef: string
  /** Hard review budget in GBP, bounded to £0.01–£10 and defaulting to £0.10. */
  readonly budgetGbp: number
  /** Raw `config` argument, defaulting to empty (auto-resolution) when blank. */
  readonly configArg: string
  /** Whether the workflow should short-circuit with the dry-run contract instead of calling agents. */
  readonly dryRun: boolean
  /** Number of Flex attempts per model call, a positive integer no greater than 6 and defaulting to 3. */
  readonly flexAttempts: number
  /** Initial Flex retry backoff in seconds, a positive integer no greater than 300. */
  readonly flexInitialBackoffSeconds: number
  /** Random jitter added to the Flex backoff in seconds, bounded to 0–60. */
  readonly flexJitterSeconds: number
  /** Maximum Flex retry backoff in seconds, a positive integer no greater than 900. */
  readonly flexMaxBackoffSeconds: number
  /** Non-blank head ref to review up to, defaulting to `HEAD`. */
  readonly headRef: string
  /** Reasoning level for the Luna Flex finder lane, defaulting to `high`. */
  readonly lunaReasoning: 'low' | 'medium' | 'high'
  /** Per-agent-call timeout in seconds, bounded to 30–900. */
  readonly perCallTimeoutSeconds: number
  /** Whether the supplied review-policy hand-off validated successfully. */
  readonly policyValid: boolean
  /** Cap on candidates retained for the audit pass, a positive integer no greater than 100. */
  readonly maxAuditCandidates: number
  /** Global cap on normalized candidates, a positive integer no greater than 1,000. */
  readonly maxCandidates: number
  /** Cap on accepted findings retained in the final report, clamped to a positive integer no greater than 200. */
  readonly maxFindings: number
  /** Cap on Luna Flex finder calls the review may issue, a positive integer no greater than 16 and defaulting to 4. */
  readonly maxLunaFlexCalls: number
  /** Cap on review tasks the task graph may schedule, a positive integer no greater than 64. */
  readonly maxTasks: number
  /** Pre-resolved review range and state supplied by the caller, or undefined to prepare it during the run. */
  readonly prepared: PreparedReview | undefined
  /** Non-blank repository root, defaulting to `.` when blank. */
  readonly repoRoot: string
  /** Optional host-translated context capability guidance for finder prompts. */
  readonly contextGuidance: string
  /** Validated, normalized review policy governing scope, tone, and custom checks. */
  readonly reviewPolicy: Readonly<NormalizedReviewPolicy>
  /** Validated review model specifications, falling back to `DEFAULT_REVIEW_MODELS` when none are configured. */
  readonly reviewModels: readonly Readonly<ModelSpec>[]
  /** Live routing policy identifier, constrained to a known value and defaulting to `deterministic-flex-v1`. */
  readonly routingPolicy: string
  /** XDG state root for review-history state, defaulting to empty when unset or blank. */
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
  /** Maximum input tokens for a Terra audit call, bounded to 1–1,000,000 and defaulting to 48,000. */
  readonly terraMaxInputTokens: number
  /** Maximum output tokens for a Terra task call, bounded to 1–100,000. */
  readonly terraMaxOutputTokens: number
  /** Cap on files bundled into one transaction, a positive integer no greater than 20. */
  readonly transactionMaxFiles: number
  /** Maximum input tokens for a transaction call, bounded to 1–200,000. */
  readonly transactionMaxInputTokens: number
  /** Maximum output tokens for a transaction call, bounded to 1–100,000. */
  readonly transactionMaxOutputTokens: number
  /** Fixed workflow-strategy version identifier surfaced in run metrics. */
  readonly workflowVersion: string
}

/**
 * Tests whether an untrusted value is a non-null object.
 *
 * @param value - Value crossing the workflow argument boundary.
 * @returns Whether the value can be inspected as an object.
 */
/**
 * Normalizes an untrusted numeric limit to a positive bounded integer.
 *
 * @param value - Candidate number or numeric string from workflow arguments.
 * @param fallback - Positive value used when the candidate is invalid.
 * @param ceiling - Inclusive upper bound for a valid result.
 * @returns A positive integer no greater than the ceiling.
 */
function positiveLimit(value: number | string | undefined, fallback: number, ceiling: number): number {
  const parsed = Number(value)
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
function boundedInteger(value: number | string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
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
function boundedNumber(value: number | string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
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
function liveRoutingPolicy(value: string | undefined): string {
  return value !== undefined && LIVE_ROUTING_POLICIES.has(value) ? value : LIVE_ROUTING_POLICY
}

/**
 * Selects a non-blank string or a trusted fallback.
 *
 * @param value - Untrusted candidate value.
 * @param fallback - Value used when the candidate is not a non-blank string.
 * @returns The candidate string or fallback.
 */
function nonBlankString(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== '' ? value : fallback
}

/**
 * Validates optional trusted-base agent instructions supplied by the CLI.
 *
 * @param value - Untrusted workflow argument to validate field by field.
 * @returns A frozen instruction object, or null when the value is absent or malformed.
 */
function configuredAgentInstructions(value: AgentInstructions | undefined): AgentInstructions | null {
  return value === undefined ? NO_AGENT_INSTRUCTIONS : Object.freeze(value)
}

/** Empty normalized policy used when direct workflow callers omit the hand-off. */
const EMPTY_REVIEW_POLICY: Readonly<NormalizedReviewPolicy> = Object.freeze({
  version: 1,
  pathInstructions: Object.freeze([]),
  customChecks: Object.freeze([]),
  ignoredKeys: Object.freeze([]),
})

/**
 * Validate the normalized review-policy hand-off supplied by the CLI.
 *
 * @param value - untrusted workflow argument.
 * @returns Frozen policy and a validity flag; omission is a valid empty policy.
 */
interface ConfiguredReviewPolicy {
  policy: Readonly<NormalizedReviewPolicy>
  valid: boolean
}

function configuredReviewPolicy(value: JsonValue | undefined): ConfiguredReviewPolicy {
  if (value === undefined) return { policy: EMPTY_REVIEW_POLICY, valid: true }
  const parsed = reviewPolicySchema.safeParse(value)
  if (!parsed.success) return { policy: EMPTY_REVIEW_POLICY, valid: false }
  const policy: NormalizedReviewPolicy = {
    version: 1,
    pathInstructions: Object.freeze(parsed.data.pathInstructions.map((entry) => Object.freeze(entry))),
    customChecks: Object.freeze(parsed.data.customChecks.map((entry) => Object.freeze(entry))),
    ignoredKeys: Object.freeze([...parsed.data.ignoredKeys]),
  }
  if (parsed.data.language !== undefined) policy.language = parsed.data.language
  if (parsed.data.toneInstructions !== undefined) policy.toneInstructions = parsed.data.toneInstructions
  if (parsed.data.profile !== undefined) policy.profile = parsed.data.profile
  return {
    valid: true,
    policy: Object.freeze(policy),
  }
}

/**
 * Checks a model identifier and its optional reasoning suffix.
 *
 * @param value - Untrusted model identifier candidate.
 * @returns Whether the value is a non-blank model with at most one valid suffix.
 */
function validModelIdentifier(value: string | undefined): value is string {
  if (value === undefined || value.trim() !== value || value.length === 0 || /\s/u.test(value)) return false
  const [model, reasoning, extra] = value.split('/')
  return Boolean(model) && extra === undefined && (reasoning === undefined || isReasoning(reasoning))
}

/**
 * Filters untrusted model entries to internally consistent specifications.
 *
 * @param value - Candidate model list from workflow arguments.
 * @returns Valid model specifications in their supplied order.
 */
function configuredModels(value: Array<ModelSpec | undefined> | undefined): ModelSpec[] {
  return (value || []).flatMap((model) => {
    if (model === undefined || !validModelIdentifier(model.model)) return []
    if (reasoningFromModel(model.model, model.reasoning) !== model.reasoning) return []
    return [Object.freeze(model)]
  })
}

/**
 * Resolves untrusted workflow arguments into bounded, immutable configuration.
 *
 * @param value - Raw ODW arguments; malformed fields fall back to safe defaults.
 * @returns A frozen configuration whose limits and model identifiers are valid.
 */
export function resolveWorkflowConfig(value: JsonValue | WorkflowArgs | undefined): WorkflowConfig {
  const input = workflowArgsSchema.safeParse(value)
  const args = input.success ? input.data : {}
  const policy = configuredReviewPolicy(args.policy)
  const customModels = configuredModels(args.models)
  const reviewModels: readonly Readonly<ModelSpec>[] = customModels.length > 0
    ? Object.freeze(customModels.map((model) => Object.freeze({ ...model })))
    : DEFAULT_REVIEW_MODELS
  const synthesisModel = validModelIdentifier(args.synthesisModel) ? args.synthesisModel : 'gpt-5.5'
  const requestedReasoning = reasoningFromModel(
    synthesisModel,
    args.synthesisReasoning ?? 'high',
  )
  const synthesisReasoning = isReasoning(requestedReasoning) ? requestedReasoning : 'high'
  const synthesisModelBase = baseModel(synthesisModel)
  return Object.freeze({
    // ADR 002 Flex admission knobs; all bounded so untrusted arguments cannot
    // widen the cost envelope beyond the documented ceilings.
    adapterOverheadTokens: boundedInteger(args.adapterOverheadTokens, 13_000, 0, 50_000),
    agentInstructions: configuredAgentInstructions(args.agentInstructions),
    baseRef: nonBlankString(args.base, 'origin/main'),
    // Default 0.15: at pricing table 2026-07-18 the reserve-first audit
    // (USD 0.1140625) plus one maximum finder pack (USD 0.017875, with
    // prompt, adapter-overhead, and output caps) exceeds ADR 002's original
    // GBP 0.10 (USD 0.127), which refused every pack; see its 2026-08-13 amendment.
    budgetGbp: boundedNumber(args.budgetGbp, 0.15, 0.01, 10),
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
    // High by default since the 2026-08-13 Flex repricing made Luna five
    // times cheaper; 'medium' and 'low' remain as de-escalation values.
    lunaReasoning: args.lunaReasoning ?? 'high',
    maxAuditCandidates: positiveLimit(args.maxAuditCandidates, 30, 100),
    maxCandidates: positiveLimit(args.maxCandidates, 30, 1000),
    maxFindings: positiveLimit(args.maxFindings, 20, 200),
    maxLunaFlexCalls: positiveLimit(args.maxLunaFlexCalls, 4, 16),
    maxTasks: positiveLimit(args.maxTasks, 8, 64),
    perCallTimeoutSeconds: boundedInteger(args.perCallTimeoutSeconds, 300, 30, 900),
    policyValid: policy.valid,
    // The host-prepared range is parsed by preparedReviewSchema and checked
    // against the required commit identity and changed-file invariants in main.ts.
    prepared: args.prepared,
    repoRoot: nonBlankString(args.repoRoot, '.'),
    contextGuidance: nonBlankString(args.contextGuidance, ''),
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
    // Reasoning tokens bill as output; the high-reasoning defaults need more
    // output headroom than the low-reasoning bounds these replaced (2,500 and
    // 750 respectively).
    terraMaxOutputTokens: boundedInteger(args.terraMaxOutputTokens, 5000, 1, 100_000),
    transactionMaxFiles: positiveLimit(args.transactionMaxFiles, 5, 20),
    transactionMaxInputTokens: boundedInteger(args.transactionMaxInputTokens, 12_000, 1, 200_000),
    transactionMaxOutputTokens: boundedInteger(args.transactionMaxOutputTokens, 2000, 1, 100_000),
    workflowVersion: 'divide-and-conquer-v1',
  })
}
