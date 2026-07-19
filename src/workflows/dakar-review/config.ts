/**
 * Validate workflow arguments and resolve immutable runtime configuration.
 *
 * @module
 */

import { adapterForReasoning, baseModel, DEFAULT_REVIEW_MODELS, isReasoning, modelName, reasoningFromModel } from './model-routing.ts'
import type { AgentInstructions, ModelSpec, Reasoning, UnknownObject } from './types.ts'

/** Summarizes the validated, immutable settings consumed by one workflow run. */
export interface WorkflowConfig {
  /** Validated trusted-base instructions, or null when the raw argument was absent or malformed. */
  readonly agentInstructions: AgentInstructions | null
  /** Non-blank base ref to diff against, defaulting to `origin/main`. */
  readonly baseRef: string
  /** Raw config argument as supplied, defaulting to empty (auto-resolution) when blank. */
  readonly configArg: string
  /** Whether the workflow should short-circuit with the dry-run contract instead of calling agents. */
  readonly dryRun: boolean
  /** Non-blank head ref to review up to, defaulting to `HEAD`. */
  readonly headRef: string
  /** Global cap on normalized candidates, clamped to a positive integer no greater than 1,000. */
  readonly maxCandidates: number
  /** Cap on accepted findings retained in the final report, clamped to a positive integer no greater than 200. */
  readonly maxFindings: number
  /** Cap on review tasks the task graph may schedule, clamped to a positive integer no greater than 64. */
  readonly maxTasks: number
  /** Non-blank repository root, defaulting to `.` when blank. */
  readonly repoRoot: string
  /** Validated model assignments used for task routing; falls back to `DEFAULT_REVIEW_MODELS` when none are configured. */
  readonly reviewModels: readonly Readonly<ModelSpec>[]
  /** Non-blank XDG state root used to locate review-history state, defaulting to empty when unset. */
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
    agentInstructions: configuredAgentInstructions(args.agentInstructions),
    baseRef: nonBlankString(args.base, 'origin/main'),
    configArg: nonBlankString(args.config, ''),
    dryRun: args.dryRun === true,
    headRef: nonBlankString(args.head, 'HEAD'),
    maxCandidates: positiveLimit(args.maxCandidates, 30, 1_000),
    maxFindings: positiveLimit(args.maxFindings, 20, 200),
    maxTasks: positiveLimit(args.maxTasks, 8, 64),
    repoRoot: nonBlankString(args.repoRoot, '.'),
    reviewModels,
    stateRoot: nonBlankString(args.stateRoot, ''),
    synthesisAdapter: adapterForReasoning(synthesisReasoning),
    synthesisModelBase,
    synthesisModelName: modelName({ model: synthesisModelBase, reasoning: synthesisReasoning }),
    synthesisReasoning,
    taskKinds: Object.freeze(['docs', 'config', 'tests', 'source', 'review-summary']),
    workflowVersion: 'divide-and-conquer-v1',
  })
}
