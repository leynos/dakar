/** @file Orchestrate Dakar's ODW phases through the injected runtime primitives. */

import {
  acceptedFromVerdicts,
  candidatesForVerification,
  compactForAudit,
  discardReasonCounts,
  discardedFromVerdicts,
  normalizeCandidates,
  SEVERITY_RANK,
} from './candidates.ts'
import { resolveWorkflowConfig } from './config.ts'
import { modelName } from './model-routing.ts'
import { auditPrompt, taskPrompt } from './prompts.ts'
import { AUDIT_SCHEMA, CANDIDATE_SCHEMA, VERDICT_SCHEMA } from './schemas.ts'
import { buildTaskGraph, defaultTaskGraph } from './task-graph.ts'
import type {
  AuditResult,
  BoundCandidateResult,
  Candidate,
  CandidateResult,
  Discarded,
  PreparedReview,
  PromptContext,
  ReviewTask,
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
  maxAuditCandidates: MAX_AUDIT_CANDIDATES,
  maxCandidates: MAX_CANDIDATES,
  maxFindings: MAX_FINDINGS,
  maxTasks: MAX_TASKS,
  prepared: PREPARED,
  repoRoot: REPO_ROOT,
  reviewModels: REVIEW_MODELS,
  routingPolicy: ROUTING_POLICY,
  synthesisAdapter: SYNTHESIS_ADAPTER,
  synthesisModelBase: SYNTHESIS_MODEL_BASE,
  synthesisModelName: SYNTHESIS_MODEL_NAME,
  taskKinds: TASK_KINDS,
  workflowVersion: WORKFLOW_VERSION,
} = config
const TASK_GRAPH_CONFIG = { maxFindings: MAX_FINDINGS, maxTasks: MAX_TASKS, reviewModels: REVIEW_MODELS }
// Configuration is resolved host-side by the CLI and supplied verbatim; the
// workflow no longer re-resolves it through an agent call.
const CODE_RABBIT_CONFIG = CONFIG_ARG || 'auto'
const promptContext: PromptContext = Object.freeze({
  agentInstructions: AGENT_INSTRUCTIONS,
  policyPath: CODE_RABBIT_CONFIG,
  repoRoot: REPO_ROOT,
})
// Hard budget admission is wired in M4; for now the audit is told plainly that
// it is the final model call and is not rewarded for issue volume.
const REMAINING_BUDGET_NOTE =
  'Remaining budget: this issue-set audit is the only remaining model call for this review; you are not rewarded for issue volume.'

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
    routingPolicy: ROUTING_POLICY,
    taskKinds: TASK_KINDS,
    limits: {
      maxTasks: MAX_TASKS,
      maxCandidates: MAX_CANDIDATES,
      maxFindings: MAX_FINDINGS,
      maxAuditCandidates: MAX_AUDIT_CANDIDATES,
    },
    defaultTaskGraph: defaultTaskGraph(TASK_GRAPH_CONFIG),
    candidateSchema: CANDIDATE_SCHEMA,
    verdictSchema: VERDICT_SCHEMA,
    auditSchema: AUDIT_SCHEMA,
    agentInstructionsIncluded: Boolean(AGENT_INSTRUCTIONS && AGENT_INSTRUCTIONS.content),
  }
}

// The deterministic review range is prepared host-side by the CLI and passed
// in as args.prepared. The workflow validates it fail-closed before use; the
// CLI normally pre-empts the skip guard below, which is retained belt-and-braces.
const prepared: PreparedReview = PREPARED || {}
if (
  prepared.ok === false ||
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
    prepared,
  }
}

if (prepared.alreadyReviewed || prepared.commitCount === 0) {
  return {
    ok: true,
    skipped: true,
    reason: 'No unreviewed commits remain for this branch.',
    config: CODE_RABBIT_CONFIG,
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
    prepared,
    taskGraph,
    failedTaskIds,
  }
}
const candidates = normalizeCandidates(taskResults, prepared.changedFiles, MAX_CANDIDATES)
// The verification policy still selects what is eligible (verify-all plus one
// sampled low finding per non-high task); compaction then orders, deduplicates,
// and caps the eligible set for a single issue-set audit.
const auditCandidatePool = [
  ...new Map(candidatesForVerification(candidates).map((candidate) => [candidate.candidateId, candidate])).values(),
]
const { auditCandidates, overCap } = compactForAudit(auditCandidatePool, MAX_AUDIT_CANDIDATES)

phase('Audit')
// One issue-set audit replaces per-candidate verification. Skipping the call
// entirely when there are zero audit candidates is a valid, zero-model-call
// outcome; the standard-tier adapter is retained until M4 introduces Flex lanes.
const auditResult: AuditResult =
  auditCandidates.length === 0
    ? { verdicts: [] }
    : await agent<AuditResult>(auditPrompt(auditCandidates, prepared, promptContext, REMAINING_BUDGET_NOTE), {
        label: 'audit',
        phase: 'Audit',
        adapter: SYNTHESIS_ADAPTER,
        model: SYNTHESIS_MODEL_BASE,
        schema: AUDIT_SCHEMA,
      })
const rawVerdicts: Verdict[] = auditResult && Array.isArray(auditResult.verdicts) ? auditResult.verdicts : []

// Re-pair returned verdicts to audit candidates by candidateId. Verdicts citing
// unknown ids are auditable noise counted in metrics, not discards (they have no
// candidate to attach to); duplicate verdicts for one id keep the first and
// count the rest.
const auditById = new Map(auditCandidates.map((candidate): [string, Candidate] => [candidate.candidateId, candidate]))
const chosenVerdicts = new Map<string, Verdict>()
let unknownAuditVerdictCount = 0
let duplicateAuditVerdictCount = 0
for (const verdict of rawVerdicts.filter(Boolean)) {
  const candidateId = typeof verdict.candidateId === 'string' ? verdict.candidateId : ''
  if (!auditById.has(candidateId)) {
    unknownAuditVerdictCount += 1
    continue
  }
  if (chosenVerdicts.has(candidateId)) {
    duplicateAuditVerdictCount += 1
    continue
  }
  chosenVerdicts.set(candidateId, verdict)
}

const boundVerdicts = auditCandidates
  .map((candidate) => ({ scheduledCandidate: candidate, verdict: chosenVerdicts.get(candidate.candidateId) }))
  .filter((pair): pair is { scheduledCandidate: Candidate; verdict: Verdict } => pair.verdict !== undefined)

// An incomplete required audit must not record: every audit candidate needs one
// valid verdict, and a severity_downgraded verdict must actually lower severity.
const auditComplete =
  boundVerdicts.length === auditCandidates.length &&
  boundVerdicts.every(({ scheduledCandidate, verdict }) => {
    if (
      typeof verdict.reason !== 'string' || verdict.reason.trim() === '' ||
      typeof verdict.evidenceChecked !== 'string' || verdict.evidenceChecked.trim() === ''
    ) return false
    if (verdict.status === 'severity_downgraded') {
      if (typeof verdict.acceptedSeverity !== 'string') return false
      if ((SEVERITY_RANK[verdict.acceptedSeverity] ?? -1) <= (SEVERITY_RANK[scheduledCandidate.severity || ''] ?? 4)) return false
    }
    return true
  })
if (!auditComplete) {
  return {
    ok: false,
    stage: 'audit',
    error: 'audit did not return a verdict for every candidate',
    config: CODE_RABBIT_CONFIG,
    prepared,
    taskGraph,
    candidates: auditCandidates,
    verdicts: rawVerdicts,
    metrics: {
      auditCandidateCount: auditCandidates.length,
      overAuditCapCount: overCap.length,
      unknownAuditVerdictCount,
      duplicateAuditVerdictCount,
      routingPolicy: ROUTING_POLICY,
    },
  }
}
const verdicts = boundVerdicts.map(({ verdict }) => verdict)
const reconciledAccepted = acceptedFromVerdicts(boundVerdicts)
const accepted = reconciledAccepted.slice(0, MAX_FINDINGS)
const overflow = reconciledAccepted.slice(MAX_FINDINGS).map((candidate): Discarded => ({
  candidate,
  status: 'max_findings_exceeded',
  reason: `Accepted candidate exceeded the configured maximum of ${MAX_FINDINGS} findings.`,
  evidenceChecked: candidate.evidenceChecked || '',
}))
const auditableIds = new Set(auditCandidatePool.map((candidate) => candidate.candidateId))
const sampledOut = candidates
  .filter((candidate) => !auditableIds.has(candidate.candidateId))
  .map((candidate): Discarded => ({
    candidate,
    status: 'verification_not_sampled',
    reason: 'Low-severity candidate was not selected by the task verification policy.',
    evidenceChecked: '',
  }))
const discarded = [...discardedFromVerdicts(candidates, verdicts), ...sampledOut, ...overflow, ...overCap]
const authoritativeFindings = accepted.map((candidate) => ({
  severity: candidate.severity,
  path: candidate.path,
  line: candidate.line || undefined,
  title: candidate.title,
  detail: candidate.detail || '',
  evidence: candidate.evidence || '',
  clusterId: candidate.clusterId || undefined,
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

// Rendering is deterministic host code: authoritativeReport above is the only
// rendering path. The former Synthesize agent call produced a report the
// authoritative construction already superseded, so it has been removed.
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
  auditCandidateCount: auditCandidates.length,
  overAuditCapCount: overCap.length,
  unknownAuditVerdictCount,
  duplicateAuditVerdictCount,
  routingPolicy: ROUTING_POLICY,
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

// Review-history recording is deterministic host code: the CLI records the
// completed head through the trusted state root after this workflow returns.
// The workflow supplies recordInput and no longer performs an agent-mediated
// record phase.
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

return {
  ok: true,
  workflowVersion: WORKFLOW_VERSION,
  verdict: finalVerdict,
  config: CODE_RABBIT_CONFIG,
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
  recordInput,
}

}
