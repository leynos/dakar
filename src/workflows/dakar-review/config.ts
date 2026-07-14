import { adapterForReasoning, baseModel, DEFAULT_REVIEW_MODELS, isReasoning, modelName, reasoningFromModel } from './model-routing.ts'
import type { AgentInstructions, ModelSpec, Reasoning, UnknownObject, WorkflowArgs } from './types.ts'

export interface WorkflowConfig {
  readonly agentInstructions: AgentInstructions | null
  readonly baseRef: string
  readonly configArg: string
  readonly dryRun: boolean
  readonly headRef: string
  readonly maxCandidates: number
  readonly maxFindings: number
  readonly maxTasks: number
  readonly repoRoot: string
  readonly reviewModels: readonly Readonly<ModelSpec>[]
  readonly stateRoot: string
  readonly synthesisAdapter: string
  readonly synthesisModelBase: string
  readonly synthesisModelName: string
  readonly synthesisReasoning: Reasoning
  readonly taskKinds: readonly string[]
  readonly workflowVersion: string
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === 'object' && value !== null
}

function positiveLimit(value: unknown, fallback: number, ceiling: number): number {
  const parsed = Number(value)
  const floored = Math.floor(parsed)
  return Number.isFinite(parsed) && floored > 0 ? Math.min(floored, ceiling) : fallback
}

function configuredModels(value: unknown): ModelSpec[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (candidate): candidate is ModelSpec =>
      isObject(candidate) &&
      (candidate.label === undefined || typeof candidate.label === 'string') &&
      typeof candidate.model === 'string' &&
      candidate.model.length > 0 &&
      (candidate.reasoning === 'low' || candidate.reasoning === 'medium' || candidate.reasoning === 'high') &&
      (candidate.role === undefined || typeof candidate.role === 'string'),
  )
}

export function resolveWorkflowConfig(value: unknown): WorkflowConfig {
  const args = (isObject(value) ? value : {}) as WorkflowArgs
  const customModels = configuredModels(args.models)
  const reviewModels: readonly Readonly<ModelSpec>[] = customModels.length > 0
    ? Object.freeze(customModels.map((model) => Object.freeze({ ...model })))
    : DEFAULT_REVIEW_MODELS
  const synthesisModel = args.synthesisModel || 'gpt-5.5'
  const requestedReasoning = reasoningFromModel(synthesisModel, args.synthesisReasoning || 'high')
  const synthesisReasoning = isReasoning(requestedReasoning) ? requestedReasoning : 'high'
  const synthesisModelBase = baseModel(synthesisModel)
  return Object.freeze({
    agentInstructions: args.agentInstructions || null,
    baseRef: args.base || 'origin/main',
    configArg: args.config || '',
    dryRun: args.dryRun === true,
    headRef: args.head || 'HEAD',
    maxCandidates: positiveLimit(args.maxCandidates, 30, 1_000),
    maxFindings: positiveLimit(args.maxFindings, 20, 200),
    maxTasks: positiveLimit(args.maxTasks, 8, 64),
    repoRoot: args.repoRoot || '.',
    reviewModels,
    stateRoot: args.stateRoot || '',
    synthesisAdapter: adapterForReasoning(synthesisReasoning),
    synthesisModelBase,
    synthesisModelName: modelName({ model: synthesisModelBase, reasoning: synthesisReasoning }),
    synthesisReasoning,
    taskKinds: Object.freeze(['docs', 'config', 'tests', 'source', 'review-summary']),
    workflowVersion: 'divide-and-conquer-v1',
  })
}
