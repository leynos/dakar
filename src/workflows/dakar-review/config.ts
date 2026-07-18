/** @file Validate workflow arguments and resolve immutable runtime configuration. */

import { adapterForReasoning, baseModel, DEFAULT_REVIEW_MODELS, isReasoning, modelName, reasoningFromModel } from './model-routing.ts'
import type { AgentInstructions, ModelSpec, PreparedReview, Reasoning, UnknownObject } from './types.ts'

/** Summarizes the validated, immutable settings consumed by one workflow run. */
export interface WorkflowConfig {
  readonly adapterOverheadTokens: number
  readonly agentInstructions: AgentInstructions | null
  readonly baseRef: string
  readonly budgetGbp: number
  readonly configArg: string
  readonly dryRun: boolean
  readonly headRef: string
  readonly lunaReasoning: 'low' | 'medium'
  readonly maxAuditCandidates: number
  readonly maxCandidates: number
  readonly maxFindings: number
  readonly maxLunaFlexCalls: number
  readonly maxTasks: number
  readonly prepared: PreparedReview | undefined
  readonly repoRoot: string
  readonly reviewModels: readonly Readonly<ModelSpec>[]
  readonly routingPolicy: string
  readonly stateRoot: string
  readonly synthesisAdapter: string
  readonly synthesisModelBase: string
  readonly synthesisModelName: string
  readonly synthesisReasoning: Reasoning
  readonly taskKinds: readonly string[]
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
    headRef: nonBlankString(args.head, 'HEAD'),
    lunaReasoning: args.lunaReasoning === 'medium' ? 'medium' : 'low',
    maxAuditCandidates: positiveLimit(args.maxAuditCandidates, 30, 100),
    maxCandidates: positiveLimit(args.maxCandidates, 30, 1_000),
    maxFindings: positiveLimit(args.maxFindings, 20, 200),
    maxLunaFlexCalls: positiveLimit(args.maxLunaFlexCalls, 4, 16),
    maxTasks: positiveLimit(args.maxTasks, 8, 64),
    // Unvalidated passthrough: the CLI prepares the review range host-side and
    // main.ts validates these fields fail-closed before any downstream use.
    prepared: isObject(args.prepared) ? (args.prepared as PreparedReview) : undefined,
    repoRoot: nonBlankString(args.repoRoot, '.'),
    reviewModels,
    // String passthrough recorded in metrics; the sole live value is
    // 'deterministic-flex-v1' once M4 lands the Flex lanes.
    routingPolicy: nonBlankString(args.routingPolicy, 'deterministic-flex-v1'),
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
