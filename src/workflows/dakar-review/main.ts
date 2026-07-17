/** @file Orchestrate Dakar's ODW phases through the injected runtime primitives. */

import {
  acceptedFromVerdicts,
  candidatesForVerification,
  discardReasonCounts,
  discardedFromVerdicts,
  normalizeCandidates,
  SEVERITY_RANK,
} from './candidates.ts'
import { resolveWorkflowConfig } from './config.ts'
import { modelName } from './model-routing.ts'
import {
  preparePrompt,
  recordPrompt as makeRecordPrompt,
  resolveConfigPrompt,
  synthesisPrompt,
  taskPrompt,
  verificationPrompt,
} from './prompts.ts'
import { CANDIDATE_SCHEMA, CONFIG_SCHEMA, PREPARE_SCHEMA, RECORD_SCHEMA, SYNTHESIS_SCHEMA, VERDICT_SCHEMA } from './schemas.ts'
import { buildTaskGraph, defaultTaskGraph } from './task-graph.ts'
import type {
  BoundCandidateResult,
  Candidate,
  CandidateResult,
  ConfigResult,
  Discarded,
  PreparedReview,
  PromptContext,
  RecordResult,
  ReviewTask,
  SynthesisResult,
  Verdict,
} from './types.ts'

/**
 * Runs the complete Dakar review workflow through the ambient ODW primitives.
 *
 * @returns The dry-run contract, an early-stage failure, or the final review result.
 * @throws When a direct ODW agent call or another injected primitive fails.
 */
async function workflowMain() {
const config = resolveWorkflowConfig(args)
const {
  agentInstructions: AGENT_INSTRUCTIONS,
  baseRef: BASE_REF,
  configArg: CONFIG_ARG,
  dryRun: DRY_RUN,
  headRef: HEAD_REF,
  maxCandidates: MAX_CANDIDATES,
  maxFindings: MAX_FINDINGS,
  maxTasks: MAX_TASKS,
  repoRoot: REPO_ROOT,
  reviewModels: REVIEW_MODELS,
  stateRoot: STATE_ROOT,
  synthesisAdapter: SYNTHESIS_ADAPTER,
  synthesisModelBase: SYNTHESIS_MODEL_BASE,
  synthesisModelName: SYNTHESIS_MODEL_NAME,
  taskKinds: TASK_KINDS,
  workflowVersion: WORKFLOW_VERSION,
} = config
const TASK_GRAPH_CONFIG = { maxFindings: MAX_FINDINGS, maxTasks: MAX_TASKS, reviewModels: REVIEW_MODELS }
let CODE_RABBIT_CONFIG = CONFIG_ARG || 'auto'
const initialPromptContext: PromptContext = {
  agentInstructions: AGENT_INSTRUCTIONS,
  policyPath: CODE_RABBIT_CONFIG,
  repoRoot: REPO_ROOT,
}

if (DRY_RUN) {
  return {
    ok: true,
    dryRun: true,
    workflowVersion: WORKFLOW_VERSION,
    config: CODE_RABBIT_CONFIG,
    repoRoot: REPO_ROOT,
    base: BASE_REF,
    head: HEAD_REF,
    models: REVIEW_MODELS.map(modelName),
    synthesisModel: SYNTHESIS_MODEL_NAME,
    synthesisAdapter: SYNTHESIS_ADAPTER,
    taskKinds: TASK_KINDS,
    limits: {
      maxTasks: MAX_TASKS,
      maxCandidates: MAX_CANDIDATES,
      maxFindings: MAX_FINDINGS,
    },
    defaultTaskGraph: defaultTaskGraph(TASK_GRAPH_CONFIG),
    candidateSchema: CANDIDATE_SCHEMA,
    verdictSchema: VERDICT_SCHEMA,
    synthesisSchema: SYNTHESIS_SCHEMA,
    agentInstructionsIncluded: Boolean(AGENT_INSTRUCTIONS && AGENT_INSTRUCTIONS.content),
  }
}

phase('Resolve Config')
let resolvedConfig: ConfigResult
try {
  resolvedConfig = await agent<ConfigResult>(
    resolveConfigPrompt(initialPromptContext, CONFIG_ARG),
    {
      label: 'config-resolve',
      phase: 'Resolve Config',
      adapter: SYNTHESIS_ADAPTER,
      model: SYNTHESIS_MODEL_BASE,
      schema: CONFIG_SCHEMA,
    },
  )
} catch (error) {
  return { ok: false, stage: 'config', error: error instanceof Error ? error.message : String(error) }
}

if (
  !resolvedConfig ||
  resolvedConfig.ok === false ||
  typeof resolvedConfig.config !== 'string' ||
  resolvedConfig.config.trim() === ''
) {
  return { ok: false, stage: 'config', resolvedConfig }
}
CODE_RABBIT_CONFIG = resolvedConfig.config
const promptContext: PromptContext = Object.freeze({
  agentInstructions: AGENT_INSTRUCTIONS,
  policyPath: CODE_RABBIT_CONFIG,
  repoRoot: REPO_ROOT,
})

phase('Prepare')
let prepared: PreparedReview
try {
  prepared = await agent<PreparedReview>(
    preparePrompt(promptContext, BASE_REF, HEAD_REF, STATE_ROOT),
    {
      label: 'state-prepare',
      phase: 'Prepare',
      adapter: SYNTHESIS_ADAPTER,
      model: SYNTHESIS_MODEL_BASE,
      schema: PREPARE_SCHEMA,
    },
  )
} catch (error) {
  return { ok: false, stage: 'prepare', error: error instanceof Error ? error.message : String(error) }
}

if (!prepared || prepared.ok === false) {
  return { ok: false, stage: 'prepare', config: CODE_RABBIT_CONFIG, resolvedConfig, prepared }
}

if (
  typeof prepared.headCommit !== 'string' ||
  !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(prepared.headCommit) ||
  typeof prepared.reviewBase !== 'string' ||
  !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(prepared.reviewBase) ||
  typeof prepared.stateFile !== 'string' ||
  prepared.stateFile.length === 0 ||
  !Number.isInteger(prepared.commitCount) ||
  Number(prepared.commitCount) < 0 ||
  !Array.isArray(prepared.changedFiles)
) {
  return {
    ok: false,
    stage: 'prepare',
    error: 'prepare step did not return the required review range fields',
    config: CODE_RABBIT_CONFIG,
    resolvedConfig,
    prepared,
  }
}

if (prepared.alreadyReviewed || prepared.commitCount === 0) {
  return {
    ok: true,
    skipped: true,
    reason: 'No unreviewed commits remain for this branch.',
    config: CODE_RABBIT_CONFIG,
    resolvedConfig,
    stateFile: prepared.stateFile,
    headCommit: prepared.headCommit,
  }
}

phase('Plan')
let taskGraph: ReviewTask[]
try {
  taskGraph = buildTaskGraph(prepared, TASK_GRAPH_CONFIG)
} catch (error) {
  return {
    ok: false,
    stage: 'plan',
    error: error instanceof Error ? error.message : String(error),
    config: CODE_RABBIT_CONFIG,
    resolvedConfig,
    prepared,
  }
}

phase('Review')
const reviewAttempts = await parallel(
    taskGraph.map((task) => async () => ({
      task,
      result: await agent<CandidateResult | null>(taskPrompt(task, prepared, promptContext), {
        label: task.taskId,
        phase: 'Review',
        adapter: task.adapter,
        model: task.model,
        schema: CANDIDATE_SCHEMA,
      }),
    })),
  )
const failedTaskIds = reviewAttempts
  .map((value, index) => (value === null || value.result === null ? taskGraph[index]?.taskId : undefined))
  .filter((taskId): taskId is string => typeof taskId === 'string')
const taskResults = reviewAttempts.filter(
  (value): value is BoundCandidateResult => value !== null && value.result !== null,
)
if (failedTaskIds.length > 0) {
  return {
    ok: false,
    stage: 'review',
    error: 'one or more scheduled review tasks failed; refusing to record incomplete coverage',
    config: CODE_RABBIT_CONFIG,
    resolvedConfig,
    prepared,
    taskGraph,
    failedTaskIds,
  }
}
const candidates = normalizeCandidates(taskResults, prepared.changedFiles, MAX_CANDIDATES)
const verificationCandidates = [
  ...new Map(candidatesForVerification(candidates).map((candidate) => [candidate.candidateId, candidate])).values(),
]

phase('Verify')
const boundVerdicts =
  verificationCandidates.length === 0
    ? []
    : (
        // ODW pipeline advances candidates independently with scheduler-bounded
        // concurrency; it is not an intentional serial rate limiter.
        await pipeline(verificationCandidates.map((candidate, index) => ({ candidate, ordinal: index + 1 })), ({ candidate, ordinal }) =>
          agent<Verdict>(verificationPrompt(candidate, prepared, promptContext), {
              label: `verify-${candidate.candidateId.slice(0, 30)}-${ordinal}`,
              phase: 'Verify',
              adapter: SYNTHESIS_ADAPTER,
              model: SYNTHESIS_MODEL_BASE,
              schema: VERDICT_SCHEMA,
            }).then((verdict) => ({ scheduledCandidate: candidate, verdict })),
        )
      ).filter((value): value is { scheduledCandidate: Candidate; verdict: Verdict } => value !== null)
const verdicts = boundVerdicts.map(({ verdict }) => verdict)
const expectedVerdictIds = new Set(verificationCandidates.map((candidate) => candidate.candidateId))
const verificationById = new Map(verificationCandidates.map((candidate): [string, Candidate] => [candidate.candidateId, candidate]))
const seenVerdictIds = new Set<string>()
const verdictsComplete =
  boundVerdicts.length === verificationCandidates.length &&
  boundVerdicts.every(({ scheduledCandidate, verdict }) => {
    if (
      typeof verdict.candidateId !== 'string' ||
      typeof verdict.reason !== 'string' ||
      verdict.reason.trim() === '' ||
      typeof verdict.evidenceChecked !== 'string' ||
      verdict.evidenceChecked.trim() === '' ||
      (verdict.status === 'severity_downgraded' &&
        (typeof verdict.acceptedSeverity !== 'string' ||
          (SEVERITY_RANK[verdict.acceptedSeverity] ?? -1) <=
            (SEVERITY_RANK[verificationById.get(verdict.candidateId)?.severity || ''] ?? 4))) ||
      !expectedVerdictIds.has(verdict.candidateId) ||
      verdict.candidateId !== scheduledCandidate.candidateId ||
      seenVerdictIds.has(verdict.candidateId)
    ) {
      return false
    }
    seenVerdictIds.add(verdict.candidateId)
    return true
  })
if (!verdictsComplete) {
  return {
    ok: false,
    stage: 'verify',
    error: 'verification did not return exactly one verdict for every scheduled candidate',
    config: CODE_RABBIT_CONFIG,
    resolvedConfig,
    prepared,
    taskGraph,
    candidates: verificationCandidates,
    verdicts,
  }
}
const reconciledAccepted = acceptedFromVerdicts(boundVerdicts)
const accepted = reconciledAccepted.slice(0, MAX_FINDINGS)
const overflow = reconciledAccepted.slice(MAX_FINDINGS).map((candidate): Discarded => ({
  candidate,
  status: 'max_findings_exceeded',
  reason: `Accepted candidate exceeded the configured maximum of ${MAX_FINDINGS} findings.`,
  evidenceChecked: candidate.evidenceChecked || '',
}))
const verificationIds = new Set(verificationCandidates.map((candidate) => candidate.candidateId))
const sampledOut = candidates
  .filter((candidate) => !verificationIds.has(candidate.candidateId))
  .map((candidate): Discarded => ({
    candidate,
    status: 'verification_not_sampled',
    reason: 'Low-severity candidate was not selected by the task verification policy.',
    evidenceChecked: '',
  }))
const discarded = [...discardedFromVerdicts(candidates, verdicts), ...sampledOut, ...overflow]
const authoritativeFindings = accepted.map((candidate) => ({
  severity: candidate.severity,
  path: candidate.path,
  line: candidate.line || undefined,
  title: candidate.title,
  detail: candidate.detail || '',
  evidence: candidate.evidence || '',
  sourceTasks: [candidate.taskId],
}))
const authoritativeSummary =
  authoritativeFindings.length === 0
    ? 'No blocking findings were accepted.'
    : `${authoritativeFindings.length} confirmed finding${authoritativeFindings.length === 1 ? '' : 's'} require changes.`
const authoritativeReport = [
  '# Dakar review',
  '',
  authoritativeSummary,
  ...authoritativeFindings.flatMap((finding) => [
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

phase('Synthesize')
let synthesis: SynthesisResult
try {
  synthesis = await agent<SynthesisResult>(
    synthesisPrompt(accepted, discardReasonCounts(discarded), prepared, promptContext),
    {
      label: 'synthesis',
      phase: 'Synthesize',
      adapter: SYNTHESIS_ADAPTER,
      model: SYNTHESIS_MODEL_BASE,
      schema: SYNTHESIS_SCHEMA,
    },
  )
} catch (error) {
  return { ok: false, stage: 'synthesize', error: error instanceof Error ? error.message : String(error) }
}

if (!synthesis || !Array.isArray(synthesis.findings) || !synthesis.metrics) {
  return {
    ok: false,
    stage: 'synthesize',
    error: 'synthesis step did not return a schema-compatible review result',
    verdict: authoritativeFindings.length > 0 ? 'changes-requested' : 'pass',
    workflowVersion: WORKFLOW_VERSION,
    config: CODE_RABBIT_CONFIG,
    resolvedConfig,
    stateFile: prepared.stateFile,
    reviewBase: prepared.reviewBase,
    headCommit: prepared.headCommit,
    commitCount: prepared.commitCount,
    changedFiles: prepared.changedFiles,
    taskGraph,
    taskResults,
    candidates,
    verdicts,
    accepted,
    discarded,
    synthesis,
  }
}
const finalVerdict = authoritativeFindings.length > 0 ? 'changes-requested' : 'pass'

const metrics = {
  workflowVersion: WORKFLOW_VERSION,
  verdict: finalVerdict,
  taskCount: taskGraph.length,
  plannedTaskCount: taskGraph.length,
  completedTaskCount: taskResults.length,
  failedTaskCount: failedTaskIds.length,
  failedTaskIds,
  candidateFindings: candidates.length,
  confirmedFindings: accepted.length,
  discardedFindings: discarded.length,
  discardReasonCounts: discardReasonCounts(discarded),
  modelAssignments: taskGraph.map((task) => ({
    taskId: task.taskId,
    kind: task.kind,
    model: task.assignedModel,
    adapter: task.adapter,
  })),
  diffStat: prepared.diffStat,
  warnings: prepared.warnings || [],
}

phase('Record')
const recordInput = {
  reviewId: `head-${prepared.headCommit}`,
  baseCommit: prepared.reviewBase,
  headCommit: prepared.headCommit,
  commitCount: prepared.commitCount,
  changedFiles: prepared.changedFiles,
  models: REVIEW_MODELS.map(modelName),
  findingsTotal: authoritativeFindings.length,
  summary: authoritativeSummary,
  metrics,
}
const recordPrompt = makeRecordPrompt(recordInput, promptContext, STATE_ROOT)
let recorded: RecordResult | null = null
let recordAttempts = 0
const isCompleteRecord = (value: RecordResult | null): value is RecordResult & { stateFile: string; headCommit: string } =>
  value?.ok === true &&
  typeof value.stateFile === 'string' &&
  value.stateFile.trim().length > 0 &&
  value.headCommit === prepared.headCommit
for (let attempt = 1; attempt <= 3 && !isCompleteRecord(recorded); attempt += 1) {
  recordAttempts = attempt
  if (attempt > 1) {
    log(`Review-history recording attempt ${attempt} of 3 after an unsuccessful attempt.`)
    await sleep(100 * (attempt - 1))
  }
  try {
    recorded = await agent<RecordResult>(recordPrompt, {
      label: `state-record-${attempt}`,
      phase: 'Record',
      adapter: SYNTHESIS_ADAPTER,
      model: SYNTHESIS_MODEL_BASE,
      schema: RECORD_SCHEMA,
    })
  } catch (error) {
    recorded = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
const recordSucceeded = isCompleteRecord(recorded)

return {
  ok: recordSucceeded,
  stage: recordSucceeded ? undefined : 'record',
  error: recordSucceeded ? undefined : recorded?.error || 'failed to record review history',
  workflowVersion: WORKFLOW_VERSION,
  verdict: finalVerdict,
  config: CODE_RABBIT_CONFIG,
  resolvedConfig,
  stateFile: recorded?.stateFile,
  reviewBase: prepared.reviewBase,
  headCommit: prepared.headCommit,
  commitCount: prepared.commitCount,
  changedFiles: prepared.changedFiles,
  taskGraph,
  taskResults,
  candidates,
  verdicts,
  findings: authoritativeFindings,
  discarded,
  summary: authoritativeSummary,
  reportMarkdown: authoritativeReport,
  metrics,
  recorded,
  recordAttempts,
  recordInput,
}

}
