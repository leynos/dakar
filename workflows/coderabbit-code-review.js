export const meta = {
  name: 'coderabbit-code-review',
  description:
    'Review only previously unreviewed commits using CodeRabbit YAML guidance, routed Codex review tasks, verification, synthesis, and XDG review history.',
  whenToUse:
    'Use on a git branch when a CodeRabbit YAML file should drive an incremental AI code review and reviews.toml should prevent duplicate commit coverage.',
  phases: [
    { title: 'Prepare' },
    { title: 'Plan' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
    { title: 'Record' },
  ],
}

const cfg = args || {}
const WORKFLOW_VERSION = 'divide-and-conquer-v1'
const CODE_RABBIT_CONFIG = cfg.config || 'examples/df12-code-review.yaml'
const REPO_ROOT = cfg.repoRoot || '.'
const BASE_REF = cfg.base || 'origin/main'
const HEAD_REF = cfg.head || 'HEAD'
const STATE_ROOT_ARG = cfg.stateRoot ? ` --state-root ${shellWord(cfg.stateRoot)}` : ''
const MAX_TASKS = Number(cfg.maxTasks || 8)
const MAX_CANDIDATES = Number(cfg.maxCandidates || 30)
const MAX_FINDINGS = Number(cfg.maxFindings || 20)
const REVIEW_MODELS = cfg.models || [
  { label: 'codex-low', model: 'gpt-5.5', reasoning: 'low', role: 'light' },
  { label: 'codex-medium', model: 'gpt-5.5', reasoning: 'medium', role: 'medium' },
  { label: 'codex-high', model: 'gpt-5.5', reasoning: 'high', role: 'high' },
  { label: 'codex-mini', model: 'gpt-5.4-mini', reasoning: 'medium', role: 'mini' },
  { label: 'codex-spark', model: 'gpt-5.3-codex-spark', reasoning: 'medium', role: 'spark' },
]
const SYNTHESIS_MODEL = cfg.synthesisModel || 'gpt-5.5'
const SYNTHESIS_REASONING = reasoningFromModel(SYNTHESIS_MODEL, cfg.synthesisReasoning || 'high')
const SYNTHESIS_MODEL_BASE = baseModel(SYNTHESIS_MODEL)
const SYNTHESIS_MODEL_NAME = modelName({
  model: SYNTHESIS_MODEL_BASE,
  reasoning: SYNTHESIS_REASONING,
})
const SYNTHESIS_ADAPTER = adapterForReasoning(SYNTHESIS_REASONING)
const TASK_KINDS = ['docs', 'config', 'tests', 'source', 'review-summary']

const PREPARE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    stateFile: { type: 'string' },
    reviewBase: { type: 'string' },
    headCommit: { type: 'string' },
    commitCount: { type: 'integer' },
    commits: { type: 'array', items: { type: 'string' } },
    changedFiles: { type: 'array', items: { type: 'string' } },
    diffStat: { type: 'string' },
    alreadyReviewed: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok'],
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string' },
    summary: { type: 'string' },
    noFindingsReason: { type: 'string' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          path: { type: 'string' },
          line: { type: 'integer' },
          detail: { type: 'string' },
          evidence: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          policyRefs: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'severity', 'path', 'detail', 'evidence', 'confidence'],
      },
    },
    metrics: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filesInspected: { type: 'integer' },
        findingsProposed: { type: 'integer' },
        noFindings: { type: 'boolean' },
      },
      required: ['filesInspected', 'findingsProposed'],
    },
  },
  required: ['taskId', 'summary', 'candidates', 'metrics'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidateId: { type: 'string' },
    status: {
      type: 'string',
      enum: [
        'accepted',
        'duplicate',
        'out_of_scope',
        'not_applicable',
        'insufficient_evidence',
        'speculative',
        'tool_false_positive',
        'severity_downgraded',
        'needs_human',
      ],
    },
    acceptedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    reason: { type: 'string' },
    evidenceChecked: { type: 'string' },
  },
  required: ['candidateId', 'status', 'reason', 'evidenceChecked'],
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes-requested'] },
    summary: { type: 'string' },
    reportMarkdown: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          path: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          detail: { type: 'string' },
          evidence: { type: 'string' },
          sourceTasks: { type: 'array', items: { type: 'string' } },
        },
        required: ['severity', 'path', 'title', 'detail', 'evidence', 'sourceTasks'],
      },
    },
    metrics: {
      type: 'object',
      additionalProperties: true,
      properties: {
        taskCount: { type: 'integer' },
        candidateFindings: { type: 'integer' },
        confirmedFindings: { type: 'integer' },
        discardedFindings: { type: 'integer' },
      },
      required: ['taskCount', 'candidateFindings', 'confirmedFindings', 'discardedFindings'],
    },
  },
  required: ['verdict', 'summary', 'reportMarkdown', 'findings', 'metrics'],
}

const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    stateFile: { type: 'string' },
    headCommit: { type: 'string' },
  },
  required: ['ok'],
}

function modelName(spec) {
  const model = String(spec.model || spec)
  if (model.includes('/')) {
    return model
  }
  return `${model}/${spec.reasoning || 'default'}`
}

function baseModel(model) {
  return String(model).split('/')[0]
}

function reasoningFromModel(model, fallback) {
  const parts = String(model).split('/')
  return parts[1] || fallback
}

function adapterForReasoning(reasoning) {
  return ['low', 'medium', 'high'].includes(reasoning) ? `codex-${reasoning}` : 'codex-medium'
}

function shellWord(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`
}

function modelForRole(role) {
  return REVIEW_MODELS.find((spec) => spec.role === role) || REVIEW_MODELS[0]
}

function classifyPath(path) {
  if (/\b(test|tests|spec|__tests__)\b/u.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path)) {
    return 'tests'
  }
  if (/\.(md|mdx|rst|adoc)$/u.test(path) || path.startsWith('docs/')) {
    return 'docs'
  }
  if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/u.test(path)) {
    return 'dependency'
  }
  if (/\.(ya?ml|toml|json|ini|conf)$/u.test(path) || path.startsWith('.github/')) {
    return 'config'
  }
  if (/\.(c|cc|cpp|cs|go|java|js|jsx|mjs|py|rb|rs|ts|tsx)$/u.test(path)) {
    return 'source'
  }
  return 'unknown'
}

function chunk(values, size) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function taskSpec(kind, files, index) {
  const role =
    kind === 'source' || kind === 'dependency'
      ? 'high'
      : kind === 'tests'
        ? 'medium'
        : kind === 'docs' || kind === 'config'
          ? 'mini'
          : 'spark'
  const assigned = modelForRole(role)
  return {
    taskId: `${kind}-${index + 1}`,
    kind,
    files,
    assignedModel: modelName(assigned),
    adapter: adapterForReasoning(assigned.reasoning || 'medium'),
    model: baseModel(assigned.model),
    modelLabel: assigned.label,
    role,
    maxFindings: Math.max(1, Math.min(MAX_FINDINGS, kind === 'source' ? 6 : 3)),
    verificationPolicy: role === 'high' ? 'verify-all' : 'verify-non-low-and-sampled-low',
  }
}

function buildTaskGraph(prepared) {
  const groups = new Map()
  for (const file of prepared.changedFiles || []) {
    const kind = classifyPath(file)
    const key = kind === 'dependency' || kind === 'unknown' ? 'source' : kind
    groups.set(key, [...(groups.get(key) || []), file])
  }
  const tasks = []
  for (const kind of ['source', 'tests', 'config', 'docs']) {
    const files = groups.get(kind) || []
    for (const [index, part] of chunk(files, 8).entries()) {
      tasks.push(taskSpec(kind, part, index))
    }
  }
  tasks.push(taskSpec('review-summary', prepared.changedFiles || [], 0))
  return tasks.slice(0, Math.max(1, MAX_TASKS))
}

function defaultTaskGraph() {
  return [
    taskSpec('source', ['src/example.js'], 0),
    taskSpec('tests', ['tests/example.test.js'], 0),
    taskSpec('config', ['examples/df12-code-review.yaml'], 0),
    taskSpec('docs', ['docs/users-guide.md'], 0),
    taskSpec('review-summary', ['src/example.js', 'tests/example.test.js'], 0),
  ].slice(0, Math.max(1, MAX_TASKS))
}

function taskPrompt(task, prepared) {
  const files = task.files.join(', ') || '(no changed files)'
  const fileArgs = task.files.map(shellWord).join(' ')
  return [
    'You are a Codex code-review finder inside the Dakar routed review workflow.',
    'Return only JSON matching the provided schema. Do not edit files.',
    '',
    `Task id: ${task.taskId}`,
    `Task kind: ${task.kind}`,
    `Assigned model label: ${task.modelLabel}`,
    `Requested model: ${task.assignedModel}`,
    `Repository root: ${REPO_ROOT}`,
    `CodeRabbit YAML: ${CODE_RABBIT_CONFIG}`,
    `Review range: ${prepared.reviewBase}..${prepared.headCommit}`,
    `Changed files for this task: ${files}`,
    `Maximum findings from this task: ${task.maxFindings}`,
    '',
    'Instructions:',
    '1. Apply CodeRabbit path instructions, pre-merge checks, review tone, and labels from the YAML file.',
    '2. Inspect only the changed range and files assigned to this task.',
    '3. Return candidates, not final conclusions. A later high-reasoning verifier may reject them.',
    '4. It is correct to return zero candidates. Use noFindingsReason when the task is not applicable.',
    '5. Prefer correctness, security, broken tests, behavioural gaps, and explicit policy violations over style comments.',
    '6. Every candidate must cite concrete evidence from a changed file, diff hunk, command output, or policy rule.',
    '',
    'Suggested commands:',
    `git -C ${shellWord(REPO_ROOT)} diff --stat ${prepared.reviewBase}..${prepared.headCommit}`,
    `git -C ${shellWord(REPO_ROOT)} diff ${prepared.reviewBase}..${prepared.headCommit} -- ${fileArgs}`,
  ].join('\n')
}

function candidateKey(candidate) {
  return [
    candidate.path || '',
    candidate.line || 0,
    String(candidate.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  ].join(':')
}

function normalizeCandidates(taskResults, taskGraph) {
  const seen = new Set()
  const byTask = new Map(taskGraph.map((task) => [task.taskId, task]))
  const candidates = []
  for (const result of taskResults.filter(Boolean)) {
    const task = byTask.get(result.taskId) || {}
    for (const raw of result.candidates || []) {
      const candidate = {
        candidateId: `${result.taskId}:${candidateKey(raw)}`,
        taskId: result.taskId,
        taskKind: task.kind || 'unknown',
        sourceModel: task.assignedModel || '',
        title: raw.title,
        severity: raw.severity,
        path: raw.path,
        line: raw.line || 0,
        detail: raw.detail,
        evidence: raw.evidence,
        confidence: raw.confidence,
        policyRefs: raw.policyRefs || [],
      }
      const key = candidateKey(candidate)
      if (!candidate.title || !candidate.path || seen.has(key)) {
        continue
      }
      seen.add(key)
      candidates.push(candidate)
      if (candidates.length >= MAX_CANDIDATES) {
        return candidates
      }
    }
  }
  return candidates
}

function verificationPrompt(candidate, prepared) {
  const sourcePath = `${REPO_ROOT}/${candidate.path}`
  return [
    'You are the high-reasoning verifier for Dakar code review.',
    'Try to refute this candidate finding before accepting it.',
    'Return only JSON matching the verdict schema.',
    '',
    `Candidate JSON:\n${JSON.stringify(candidate, null, 2)}`,
    '',
    `Repository root: ${REPO_ROOT}`,
    `Review range: ${prepared.reviewBase}..${prepared.headCommit}`,
    `CodeRabbit YAML: ${CODE_RABBIT_CONFIG}`,
    '',
    'Verification rules:',
    '1. Accept only if the issue is in scope for the changed range and actionable.',
    '2. Reject findings whose evidence does not match the current source, diff, or policy.',
    '3. Reject speculative issues and task-role pressure. no finding is better than a weak finding.',
    '4. Use severity_downgraded when real but overstated.',
    '',
    'Suggested commands:',
    `git -C ${shellWord(REPO_ROOT)} diff ${prepared.reviewBase}..${prepared.headCommit} -- ${shellWord(candidate.path)}`,
    `sed -n '${Math.max(1, Number(candidate.line || 1) - 20)},${Number(candidate.line || 1) + 20}p' ${shellWord(sourcePath)}`,
  ].join('\n')
}

function discardReasonCounts(discarded) {
  const counts = {}
  for (const item of discarded) {
    counts[item.status] = (counts[item.status] || 0) + 1
  }
  return counts
}

function acceptedFromVerdicts(candidates, verdicts) {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]))
  return verdicts
    .filter(Boolean)
    .filter((verdict) => verdict.status === 'accepted' || verdict.status === 'severity_downgraded')
    .map((verdict) => {
      const candidate = byId.get(verdict.candidateId)
      return {
        ...candidate,
        severity: verdict.acceptedSeverity || candidate.severity,
        verificationStatus: verdict.status,
        verificationReason: verdict.reason,
        evidenceChecked: verdict.evidenceChecked,
      }
    })
    .slice(0, MAX_FINDINGS)
}

function discardedFromVerdicts(candidates, verdicts) {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]))
  return verdicts
    .filter(Boolean)
    .filter((verdict) => verdict.status !== 'accepted' && verdict.status !== 'severity_downgraded')
    .map((verdict) => ({
      candidate: byId.get(verdict.candidateId),
      status: verdict.status,
      reason: verdict.reason,
      evidenceChecked: verdict.evidenceChecked,
    }))
}

if (cfg.dryRun === true) {
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
    defaultTaskGraph: defaultTaskGraph(),
    candidateSchema: CANDIDATE_SCHEMA,
    verdictSchema: VERDICT_SCHEMA,
    synthesisSchema: SYNTHESIS_SCHEMA,
  }
}

phase('Prepare')
const prepared = await agent(
  [
    'Run the deterministic Dakar state helper and return its JSON result exactly.',
    '',
    'Command:',
    `node scripts/review-state.mjs prepare --repo-root ${shellWord(REPO_ROOT)} --base ${BASE_REF} --head ${HEAD_REF}${STATE_ROOT_ARG}`,
    '',
    'Do not edit files. If the command fails, explain the failure in schema-compatible JSON with ok=false.',
  ].join('\n'),
  {
        label: 'state-prepare',
        phase: 'Prepare',
        adapter: SYNTHESIS_ADAPTER,
        model: SYNTHESIS_MODEL_BASE,
        schema: PREPARE_SCHEMA,
      },
)

if (!prepared || prepared.ok === false) {
  return { ok: false, stage: 'prepare', prepared }
}

if (prepared.alreadyReviewed || prepared.commitCount === 0) {
  return {
    ok: true,
    skipped: true,
    reason: 'No unreviewed commits remain for this branch.',
    stateFile: prepared.stateFile,
    headCommit: prepared.headCommit,
  }
}

phase('Plan')
const taskGraph = buildTaskGraph(prepared)

phase('Review')
const taskResults = (
  await parallel(
    taskGraph.map((task) => () =>
      agent(taskPrompt(task, prepared), {
        label: task.taskId,
        phase: 'Review',
        adapter: task.adapter,
        model: task.model,
        schema: CANDIDATE_SCHEMA,
      }),
    ),
  )
).filter(Boolean)
const candidates = normalizeCandidates(taskResults, taskGraph)

phase('Verify')
const verdicts =
  candidates.length === 0
    ? []
    : (
        await pipeline(candidates, (candidate) =>
          agent(verificationPrompt(candidate, prepared), {
            label: `verify-${candidate.candidateId.slice(0, 40)}`,
            phase: 'Verify',
            adapter: SYNTHESIS_ADAPTER,
            model: SYNTHESIS_MODEL_BASE,
            schema: VERDICT_SCHEMA,
          }),
        )
      ).filter(Boolean)
const accepted = acceptedFromVerdicts(candidates, verdicts)
const discarded = discardedFromVerdicts(candidates, verdicts)

phase('Synthesize')
const synthesis = await agent(
  [
    'Create the final Dakar code-review report.',
    'Return only JSON matching the synthesis schema.',
    '',
    `Review range: ${prepared.reviewBase}..${prepared.headCommit}`,
    `Changed files: ${(prepared.changedFiles || []).join(', ')}`,
    `Accepted candidates:\n${JSON.stringify(accepted, null, 2)}`,
    `Discarded candidate summary:\n${JSON.stringify(discardReasonCounts(discarded), null, 2)}`,
    '',
    'Report rules:',
    '1. Include only accepted findings in findings and reportMarkdown.',
    '2. If no findings are accepted, say that no blocking findings were accepted.',
    '3. Mention discarded-count totals without listing weak discarded claims as findings.',
    '4. Make each accepted finding actionable and evidence-backed.',
  ].join('\n'),
  {
    label: 'synthesis',
    phase: 'Synthesize',
    adapter: SYNTHESIS_ADAPTER,
    model: SYNTHESIS_MODEL_BASE,
    schema: SYNTHESIS_SCHEMA,
  },
)

const metrics = {
  ...synthesis.metrics,
  workflowVersion: WORKFLOW_VERSION,
  taskCount: taskGraph.length,
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
  stateFile: prepared.stateFile,
  reviewId: `${prepared.headCommit.slice(0, 12)}-${Date.now()}`,
  baseCommit: prepared.reviewBase,
  headCommit: prepared.headCommit,
  commitCount: prepared.commitCount,
  changedFiles: prepared.changedFiles,
  models: REVIEW_MODELS.map(modelName),
  findingsTotal: synthesis.findings.length,
  summary: synthesis.summary,
  metrics,
}
const recorded = await agent(
  [
    'Record the completed review in Dakar review history by passing this JSON to the helper on stdin.',
    'Return the helper JSON output exactly.',
    '',
    'Command pattern:',
    "cat > /tmp/dakar-review-record.json <<'JSON'",
    JSON.stringify(recordInput, null, 2),
    'JSON',
    'node scripts/review-state.mjs record < /tmp/dakar-review-record.json',
  ].join('\n'),
  {
    label: 'state-record',
    phase: 'Record',
    adapter: SYNTHESIS_ADAPTER,
    model: SYNTHESIS_MODEL_BASE,
    schema: RECORD_SCHEMA,
  },
)

return {
  ok: recorded && recorded.ok === true,
  workflowVersion: WORKFLOW_VERSION,
  stateFile: prepared.stateFile,
  reviewBase: prepared.reviewBase,
  headCommit: prepared.headCommit,
  commitCount: prepared.commitCount,
  changedFiles: prepared.changedFiles,
  taskGraph,
  taskResults,
  candidates,
  verdicts,
  findings: synthesis.findings,
  discarded,
  reportMarkdown: synthesis.reportMarkdown,
  metrics,
  recorded,
}
