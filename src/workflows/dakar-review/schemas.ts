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

/** Enumerates the per-candidate verdict fields shared by the item and audit schemas. */
const VERDICT_PROPERTIES = {
  candidateId: { type: 'string' },
  status: { type: 'string', enum: ['accepted', 'duplicate', 'out_of_scope', 'not_applicable', 'insufficient_evidence', 'speculative', 'tool_false_positive', 'severity_downgraded', 'needs_human'] },
  acceptedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  reason: { type: 'string' }, evidenceChecked: { type: 'string' },
}

/** Validates one adversarial verification decision for a candidate finding. */
export const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: VERDICT_PROPERTIES,
  required: ['candidateId', 'status', 'reason', 'evidenceChecked'],
}

/** Validates one audit verdict, extending the per-item shape with a remediation cluster. */
export const VERDICT_WITH_CLUSTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { ...VERDICT_PROPERTIES, clusterId: { type: 'string' } },
  required: ['candidateId', 'status', 'reason', 'evidenceChecked'],
}

/** Validates the single issue-set audit response returned by the Terra-class lane. */
export const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: { type: 'array', items: VERDICT_WITH_CLUSTER_SCHEMA },
    summary: { type: 'string' },
  },
}
