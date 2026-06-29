export const meta = {
  name: 'coderabbit-code-review',
  description:
    'Review only previously unreviewed commits using CodeRabbit YAML guidance, multiple Codex reviewers, synthesis, and XDG review history.',
  whenToUse:
    'Use on a git branch when a CodeRabbit YAML file should drive an incremental AI code review and reviews.toml should prevent duplicate commit coverage.',
  phases: [
    { title: 'Prepare' },
    { title: 'Review' },
    { title: 'Synthesize' },
    { title: 'Record' },
  ],
}

const cfg = args || {}
const CODE_RABBIT_CONFIG = cfg.config || 'examples/df12-code-review.yaml'
const BASE_REF = cfg.base || 'origin/main'
const HEAD_REF = cfg.head || 'HEAD'
const STATE_ROOT_ARG = cfg.stateRoot ? ` --state-root ${cfg.stateRoot}` : ''
const MAX_FINDINGS = cfg.maxFindings || 20
const REVIEW_MODELS = cfg.models || [
  { label: 'codex-low', model: 'gpt-5.5', reasoning: 'low' },
  { label: 'codex-medium', model: 'gpt-5.5', reasoning: 'medium' },
  { label: 'codex-high', model: 'gpt-5.5', reasoning: 'high' },
  { label: 'codex-mini', model: 'gpt-5.4-mini', reasoning: 'medium' },
  { label: 'codex-spark', model: 'gpt-5.3-codex-spark', reasoning: 'medium' },
]
const SYNTHESIS_MODEL = cfg.synthesisModel || 'gpt-5.5'

const PREPARE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
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

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    modelLabel: { type: 'string' },
    summary: { type: 'string' },
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
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['severity', 'path', 'title', 'detail', 'evidence', 'confidence'],
      },
    },
    metrics: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filesInspected: { type: 'integer' },
        findingsProposed: { type: 'integer' },
        falsePositiveRisks: { type: 'integer' },
      },
      required: ['filesInspected', 'findingsProposed'],
    },
  },
  required: ['modelLabel', 'summary', 'findings', 'metrics'],
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes-requested'] },
    summary: { type: 'string' },
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
          supportingModels: { type: 'array', items: { type: 'string' } },
        },
        required: ['severity', 'path', 'title', 'detail', 'evidence', 'supportingModels'],
      },
    },
    metrics: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reviewerCount: { type: 'integer' },
        candidateFindings: { type: 'integer' },
        confirmedFindings: { type: 'integer' },
        duplicateFindingGroups: { type: 'integer' },
      },
      required: ['reviewerCount', 'candidateFindings', 'confirmedFindings'],
    },
  },
  required: ['verdict', 'summary', 'findings', 'metrics'],
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
  return `${spec.model}/${spec.reasoning || 'default'}`
}

function reviewPrompt(spec, prepared) {
  return [
    'You are a Codex code-review agent in the Dakar ODW review workflow.',
    'Return only JSON matching the provided schema.',
    '',
    `Reviewer identity: ${spec.label}`,
    `Codex model requested by ODW: ${modelName(spec)}`,
    `CodeRabbit YAML: ${CODE_RABBIT_CONFIG}`,
    `Review range: ${prepared.reviewBase}..${prepared.headCommit}`,
    `Changed files: ${prepared.changedFiles.join(', ') || '(none)'}`,
    '',
    'Instructions:',
    '1. Read the CodeRabbit YAML file and apply its language, tone, path instructions, and pre-merge checks as review criteria.',
    '2. Inspect only commits and diffs in the review range above. Do not report issues that exist only outside this range.',
    '3. Prioritise correctness bugs, security risks, broken tests, missing behavioural coverage, and violations of explicit CodeRabbit checks.',
    `4. Return no more than ${MAX_FINDINGS} findings. Use exact file paths and line numbers when available.`,
    '5. Do not edit files, commit, or write review history.',
    '',
    'Suggested commands:',
    `git diff --stat ${prepared.reviewBase}..${prepared.headCommit}`,
    `git diff ${prepared.reviewBase}..${prepared.headCommit} -- ${prepared.changedFiles.join(' ')}`,
  ].join('\n')
}

if (cfg.dryRun === true) {
  return {
    ok: true,
    dryRun: true,
    config: CODE_RABBIT_CONFIG,
    base: BASE_REF,
    head: HEAD_REF,
    models: REVIEW_MODELS.map(modelName),
  }
}

phase('Prepare')
const prepared = await agent(
  [
    'Run the deterministic Dakar state helper and return its JSON result exactly.',
    '',
    'Command:',
    `node scripts/review-state.mjs prepare --repo-root . --base ${BASE_REF} --head ${HEAD_REF}${STATE_ROOT_ARG}`,
    '',
    'Do not edit files. If the command fails, explain the failure in schema-compatible JSON with ok=false.',
  ].join('\n'),
  {
    label: 'state-prepare',
    phase: 'Prepare',
    adapter: 'codex',
    model: SYNTHESIS_MODEL,
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

phase('Review')
const reviews = await parallel(
  REVIEW_MODELS.map((spec) => () =>
    agent(reviewPrompt(spec, prepared), {
      label: spec.label,
      phase: 'Review',
      adapter: 'codex',
      model: spec.model,
      schema: REVIEW_SCHEMA,
    }),
  ),
)
const validReviews = reviews.filter(Boolean)

phase('Synthesize')
const synthesis = await agent(
  [
    'Synthesize the independent code-review results into one reviewer-facing report.',
    'Keep only findings that are supported by concrete evidence in the reviewed diff.',
    'Deduplicate equivalent findings. Preserve severity from the strongest well-evidenced report.',
    '',
    `Review range: ${prepared.reviewBase}..${prepared.headCommit}`,
    `Changed files: ${prepared.changedFiles.join(', ')}`,
    '',
    `Raw review JSON:\n${JSON.stringify(validReviews, null, 2)}`,
  ].join('\n'),
  {
    label: 'synthesis',
    phase: 'Synthesize',
    adapter: 'codex',
    model: SYNTHESIS_MODEL,
    schema: SYNTHESIS_SCHEMA,
  },
)

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
  metrics: {
    ...synthesis.metrics,
    diffStat: prepared.diffStat,
    warnings: prepared.warnings || [],
  },
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
    adapter: 'codex',
    model: SYNTHESIS_MODEL,
    schema: RECORD_SCHEMA,
  },
)

return {
  ok: recorded && recorded.ok === true,
  stateFile: prepared.stateFile,
  reviewBase: prepared.reviewBase,
  headCommit: prepared.headCommit,
  commitCount: prepared.commitCount,
  changedFiles: prepared.changedFiles,
  reviews: validReviews,
  synthesis,
  recorded,
}
