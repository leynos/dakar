/** @file Define JSON Schemas for every structured ODW agent hand-off. */

/** Validates bounded candidate findings returned by each Review task. */
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

/** Validates one adversarial verification decision for a candidate finding. */
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

/** Validates review-history recording success or diagnostic output. */
export const RECORD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { ok: { type: 'boolean' }, stateFile: { type: 'string' }, headCommit: { type: 'string' },
    error: { type: 'string' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
  required: ['ok', 'stateFile', 'headCommit'],
}
