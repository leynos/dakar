/**
 * Normalize, cap, verify, and reduce candidate review findings.
 *
 * @module
 */

import type { BoundCandidateResult, Candidate, Discarded, RawCandidate, Verdict } from './types.ts'

/** Maps supported severities to stable ascending sort ranks. */
export const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/**
 * Builds the stable identity key used to deduplicate a raw candidate.
 *
 * @param candidate - Candidate whose path, line, and title form its identity.
 * @returns A normalized path/line/title key.
 */
export function candidateKey(candidate: RawCandidate): string {
  const title = String(candidate.title || '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
  return [candidate.path || '', candidate.line || 0, title].join(':')
}

/**
 * Compares two findings by supported severity while preserving stable ties.
 *
 * @param left - First severity-bearing value.
 * @param right - Second severity-bearing value.
 * @returns A negative, zero, or positive comparator result.
 */
export function bySeverity<T extends {
  /** Stable identity used as the final tie-breaker so ties sort deterministically. */
  candidateId?: string
  /** Secondary tie-breaker, applied after path, before candidate id. */
  line?: number
  /** Primary tie-breaker once severity is equal. */
  path?: string
  /** Ranked via `SEVERITY_RANK`; unrecognized or missing severities sort last. */
  severity?: string
}>(left: T, right: T): number {
  const severity = (SEVERITY_RANK[left.severity || ''] ?? 4) - (SEVERITY_RANK[right.severity || ''] ?? 4)
  if (severity !== 0) return severity
  const leftPath = String(left.path || '')
  const rightPath = String(right.path || '')
  if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1
  const line = Number(left.line || 0) - Number(right.line || 0)
  if (line !== 0) return line
  const leftId = String(left.candidateId || '')
  const rightId = String(right.candidateId || '')
  return leftId === rightId ? 0 : leftId < rightId ? -1 : 1
}

/**
 * Checks that a candidate path is contained within the reviewed changed-file set.
 *
 * @param path - Untrusted candidate path, which must be relative and traversal-free.
 * @param changedFiles - Trusted whitelist of reviewed repository-relative paths.
 * @returns Whether the path is safe and present in the whitelist.
 */
export function isSafeCandidatePath(path: string, changedFiles: Set<string>): boolean {
  if (typeof path !== 'string' || path === '') return false
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:[\\/]/u.test(path)) return false
  if (path.split(/[\\/]+/u).some((segment) => segment === '..')) return false
  return changedFiles.has(path)
}

/**
 * Validates, deduplicates, and bounds finder candidates before verification.
 *
 * @param taskResults - Schema-shaped finder results bound to their scheduled tasks.
 * @param changedFiles - Trusted reviewed paths used as the containment whitelist.
 * @param maxCandidates - Non-negative global cap applied after severity sorting.
 * @returns Safe candidates respecting per-task and global finding caps.
 */
export function normalizeCandidates(
  taskResults: BoundCandidateResult[],
  changedFiles: string[],
  maxCandidates: number,
): Candidate[] {
  const seen = new Set<string>()
  const changed = new Set(changedFiles || [])
  const candidates: Candidate[] = []
  for (const { result, task } of taskResults) {
    const validForTask: Candidate[] = []
    for (const raw of result.candidates || []) {
      if (
        typeof raw.title !== 'string' || raw.title.trim() === '' ||
        typeof raw.path !== 'string' || typeof raw.detail !== 'string' || raw.detail.trim() === '' ||
        typeof raw.evidence !== 'string' || raw.evidence.trim() === ''
      ) continue
      const candidate: Candidate = {
        candidateId: `${task.taskId}:${candidateKey(raw)}`, taskId: task.taskId, taskKind: task.kind,
        sourceModel: task.assignedModel, verificationPolicy: task.verificationPolicy, title: raw.title,
        severity: raw.severity, path: raw.path, line: raw.line || 0, detail: raw.detail,
        evidence: raw.evidence, confidence: raw.confidence, policyRefs: raw.policyRefs || [],
      }
      if (!candidate.title || !candidate.path) continue
      if (!task.files.includes(candidate.path) || !isSafeCandidatePath(candidate.path, changed)) continue
      validForTask.push(candidate)
    }
    let acceptedForTask = 0
    for (const candidate of validForTask.sort(bySeverity)) {
      if (acceptedForTask >= task.maxFindings) break
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
      acceptedForTask += 1
    }
  }
  return candidates.sort(bySeverity).slice(0, maxCandidates)
}

/**
 * Applies each task's verification policy to normalized candidates.
 *
 * @param candidates - Safe candidates in deterministic review order.
 * @returns All required candidates plus at most one sampled low finding per task.
 */
export function candidatesForVerification(candidates: Candidate[]): Candidate[] {
  const sampledLowTasks = new Set<string>()
  return candidates.filter((candidate) => {
    if (candidate.verificationPolicy === 'verify-all' || candidate.severity !== 'low') return true
    if (sampledLowTasks.has(candidate.taskId)) return false
    sampledLowTasks.add(candidate.taskId)
    return true
  })
}

/**
 * Counts discarded candidates by their audit status.
 *
 * @param discarded - Completed discard audit entries.
 * @returns A status-to-count record for synthesis and metrics.
 */
export function discardReasonCounts(discarded: Discarded[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of discarded) counts[item.status] = (counts[item.status] || 0) + 1
  return counts
}

/**
 * Reduces accepted verifier verdicts into the authoritative finding set.
 *
 * @param boundVerdicts - Verifier decisions paired with their scheduled candidates.
 * @returns Accepted candidates with verification evidence and valid downgrades.
 */
export function acceptedFromVerdicts(
  boundVerdicts: Array<{ scheduledCandidate: Candidate; verdict: Verdict }>,
): Candidate[] {
  const seen = new Set<string>()
  const accepted: Candidate[] = []
  for (const { scheduledCandidate: candidate, verdict } of boundVerdicts) {
    if (seen.has(candidate.candidateId)) continue
    seen.add(candidate.candidateId)
    if (verdict.candidateId !== candidate.candidateId) continue
    if (verdict.status !== 'accepted' && verdict.status !== 'severity_downgraded') continue
    accepted.push({
      ...candidate,
      severity: verdict.status === 'severity_downgraded' && typeof verdict.acceptedSeverity === 'string' &&
        (SEVERITY_RANK[verdict.acceptedSeverity] ?? -1) > (SEVERITY_RANK[candidate.severity || ''] ?? 4)
        ? verdict.acceptedSeverity : candidate.severity,
      verificationStatus: verdict.status,
      verificationReason: verdict.reason,
      evidenceChecked: verdict.evidenceChecked,
    })
  }
  return accepted.sort(bySeverity)
}

/**
 * Converts rejected or unknown verifier verdicts into audit entries.
 *
 * @param candidates - Normalized candidates available for identifier lookup.
 * @param verdicts - Verifier decisions, including possible unknown identifiers.
 * @returns Deterministic discard entries for every non-accepted verdict.
 */
export function discardedFromVerdicts(candidates: Candidate[], verdicts: Verdict[]): Discarded[] {
  const byId = new Map(candidates.map((candidate): [string, Candidate] => [candidate.candidateId, candidate]))
  const discarded: Discarded[] = []
  for (const verdict of verdicts.filter(Boolean)) {
    const candidate = typeof verdict.candidateId === 'string' ? byId.get(verdict.candidateId) : undefined
    if (!candidate) {
      discarded.push({ candidate: { candidateId: verdict.candidateId }, status: 'unknown_candidate',
        reason: `Verifier referenced an unknown candidate id: ${verdict.candidateId}`, evidenceChecked: verdict.evidenceChecked || '' })
      continue
    }
    if (verdict.status !== 'accepted' && verdict.status !== 'severity_downgraded') {
      discarded.push({ candidate, status: verdict.status || 'unknown_status', reason: verdict.reason || '', evidenceChecked: verdict.evidenceChecked || '' })
    }
  }
  return discarded
}
