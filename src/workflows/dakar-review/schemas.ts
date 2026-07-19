/**
 * Define JSON Schemas for every structured ODW agent hand-off.
 *
 * @module
 */

/**
 * Validates structured configuration-resolution results from the Config phase.
 *
 * @internal
 */
export const CONFIG_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean' }, config: { type: 'string' },
    source: { type: 'string', enum: ['explicit', 'repository', 'user', 'example'] },
    checked: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
  },
  required: ['ok'],
}

/**
 * Validates review-range and state metadata returned by the Prepare phase.
 *
 * @internal
 */
export const PREPARE_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    ok: { type: 'boolean' }, stateFile: { type: 'string' }, reviewBase: { type: 'string' },
    headCommit: { type: 'string' }, commitCount: { type: 'integer' },
    commits: { type: 'array', items: { type: 'string' } },
    changedFiles: { type: 'array', items: { type: 'string' } }, diffStat: { type: 'string' },
    alreadyReviewed: { type: 'boolean' }, warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok'],
}

/**
 * Validates bounded candidate findings returned by each Review task.
 *
 * @internal
 */
export const CANDIDATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    taskId: { type: 'string' }, summary: { type: 'string' }, noFindingsReason: { type: 'string' },
    candidates: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      path: { type: 'string' }, line: { type: 'integer' }, detail: { type: 'string' },
      evidence: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      policyRefs: { type: 'array', items: { type: 'string' } },
    }, required: ['title', 'severity', 'path', 'detail', 'evidence', 'confidence'] } },
    metrics: { type: 'object', additionalProperties: false, properties: {
      filesInspected: { type: 'integer' }, findingsProposed: { type: 'integer' }, noFindings: { type: 'boolean' },
    }, required: ['filesInspected', 'findingsProposed'] },
  },
  required: ['taskId', 'summary', 'candidates', 'metrics'],
}

/**
 * Validates one adversarial verification decision for a candidate finding.
 *
 * @internal
 */
export const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    candidateId: { type: 'string' },
    status: { type: 'string', enum: ['accepted', 'duplicate', 'out_of_scope', 'not_applicable', 'insufficient_evidence', 'speculative', 'tool_false_positive', 'severity_downgraded', 'needs_human'] },
    acceptedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    reason: { type: 'string' }, evidenceChecked: { type: 'string' },
  },
  required: ['candidateId', 'status', 'reason', 'evidenceChecked'],
}

/**
 * Validates the final report and presentation metadata from synthesis.
 *
 * @internal
 */
export const SYNTHESIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes-requested'] }, summary: { type: 'string' },
    reportMarkdown: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, path: { type: 'string' },
        line: { type: 'integer' }, title: { type: 'string' }, detail: { type: 'string' }, evidence: { type: 'string' },
        sourceTasks: { type: 'array', items: { type: 'string' } } },
      required: ['severity', 'path', 'title', 'detail', 'evidence', 'sourceTasks'] } },
    metrics: { type: 'object', additionalProperties: true, properties: {
      taskCount: { type: 'integer' }, candidateFindings: { type: 'integer' }, confirmedFindings: { type: 'integer' },
      discardedFindings: { type: 'integer' },
    } },
  },
  required: ['verdict', 'summary', 'reportMarkdown', 'findings', 'metrics'],
}

/**
 * Validates review-history recording success or diagnostic output.
 *
 * @internal
 */
export const RECORD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { ok: { type: 'boolean' }, stateFile: { type: 'string' }, headCommit: { type: 'string' },
    error: { type: 'string' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
  required: ['ok', 'stateFile', 'headCommit'],
}
