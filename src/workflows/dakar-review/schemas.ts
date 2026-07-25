/**
 * Define JSON Schemas for every structured ODW agent hand-off.
 *
 * @module
 */

/**
 * Validates bounded candidate findings returned by each Review task.
 *
 * @internal
 */
export const CANDIDATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Bounded candidate findings returned by one Review task.',
  properties: {
    taskId: { type: 'string', description: 'Identifier of the task that produced these findings.' },
    summary: { type: 'string', description: 'Task-level natural-language summary of the review.' },
    noFindingsReason: { type: 'string', description: 'Explanation supplied when the task deliberately reports no findings.' },
    candidates: { type: 'array', description: 'Proposed findings, each an untrusted candidate for verification.', items: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string', description: 'Short finding title.' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Finder-reported severity of the finding.' },
      path: { type: 'string', description: 'Repository-relative file path the finding refers to.' },
      line: { type: 'integer', description: '1-based line number within the file, when known.' },
      detail: { type: 'string', description: 'Explanation of the issue.' },
      evidence: { type: 'string', description: 'Cited support for the finding.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Finder self-reported confidence in the finding.' },
      policyRefs: { type: 'array', items: { type: 'string' }, description: 'Review-policy references the finding cites.' },
    }, required: ['title', 'severity', 'path', 'detail', 'evidence', 'confidence'] } },
    metrics: { type: 'object', additionalProperties: false, description: 'Coverage counters for the task.', properties: {
      filesInspected: { type: 'integer', description: 'Number of files the task examined.' },
      findingsProposed: { type: 'integer', description: 'Number of findings proposed before deduplication and capping.' },
      noFindings: { type: 'boolean', description: 'Explicit signal that the task deliberately found nothing.' },
    }, required: ['filesInspected', 'findingsProposed'] },
  },
  required: ['taskId', 'summary', 'candidates', 'metrics'],
}

/** Enumerates the per-candidate verdict fields shared by the item and audit schemas. */
const VERDICT_PROPERTIES = {
  candidateId: { type: 'string', description: 'Identifier of the candidate this verdict decides.' },
  status: { type: 'string', enum: ['accepted', 'duplicate', 'out_of_scope', 'not_applicable', 'insufficient_evidence', 'speculative', 'tool_false_positive', 'severity_downgraded', 'needs_human'], description: 'Verifier disposition for the candidate.' },
  acceptedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Downgraded severity when the status is `severity_downgraded`.' },
  reason: { type: 'string', description: 'Verifier justification for the disposition.' },
  evidenceChecked: { type: 'string', description: 'Evidence the verifier examined to reach the decision.' },
}

/**
 * Validates one adversarial verification decision for a candidate finding.
 *
 * @internal
 */
export const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'One adversarial verification decision for a candidate finding.',
  properties: VERDICT_PROPERTIES,
  required: ['candidateId', 'status', 'reason', 'evidenceChecked'],
}

/**
 * Validates one audit verdict, extending the per-item shape with a remediation cluster.
 *
 * @internal
 */
export const VERDICT_WITH_CLUSTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'One audit verdict, extending the per-item verdict with a remediation cluster.',
  properties: { ...VERDICT_PROPERTIES, clusterId: { type: 'string', description: 'Remediation cluster the verdict is grouped into.' } },
  required: ['candidateId', 'status', 'reason', 'evidenceChecked'],
}

/**
 * Validates the single issue-set audit response returned by the Terra-class lane.
 *
 * @internal
 */
export const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Single issue-set audit response from the Terra-class lane.',
  required: ['verdicts'],
  properties: {
    verdicts: { type: 'array', items: VERDICT_WITH_CLUSTER_SCHEMA, description: 'Per-candidate audit verdicts.' },
    summary: { type: 'string', description: 'Optional natural-language summary of the audit.' },
  },
}
