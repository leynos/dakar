import type { BoundCandidateResult, Candidate, Discarded, RawCandidate, Verdict } from './types.ts'

export const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export function candidateKey(candidate: RawCandidate): string {
  return [candidate.path || '', candidate.line || 0, String(candidate.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')].join(':')
}

export function bySeverity<T extends { severity?: string }>(left: T, right: T): number {
  return (SEVERITY_RANK[left.severity || ''] ?? 4) - (SEVERITY_RANK[right.severity || ''] ?? 4)
}

export function isSafeCandidatePath(path: string, changedFiles: Set<string>): boolean {
  if (typeof path !== 'string' || path === '') return false
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:[\\/]/u.test(path)) return false
  if (path.split(/[\\/]+/u).some((segment) => segment === '..')) return false
  return changedFiles.has(path)
}

export function normalizeCandidates(
  taskResults: BoundCandidateResult[],
  changedFiles: string[],
  maxCandidates: number,
): Candidate[] {
  const seen = new Set<string>()
  const changed = new Set(changedFiles || [])
  const candidates: Candidate[] = []
  for (const { result, task } of taskResults) {
    let acceptedForTask = 0
    for (const raw of result.candidates || []) {
      if (acceptedForTask >= task.maxFindings) break
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
      const key = candidateKey(candidate)
      if (!candidate.title || !candidate.path || seen.has(key)) continue
      if (!task.files.includes(candidate.path) || !isSafeCandidatePath(candidate.path, changed)) continue
      seen.add(key)
      candidates.push(candidate)
      acceptedForTask += 1
    }
  }
  return candidates.sort(bySeverity).slice(0, maxCandidates)
}

export function candidatesForVerification(candidates: Candidate[]): Candidate[] {
  const sampledLowTasks = new Set<string>()
  return candidates.filter((candidate) => {
    if (candidate.verificationPolicy === 'verify-all' || candidate.severity !== 'low') return true
    if (sampledLowTasks.has(candidate.taskId)) return false
    sampledLowTasks.add(candidate.taskId)
    return true
  })
}

export function discardReasonCounts(discarded: Discarded[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of discarded) counts[item.status] = (counts[item.status] || 0) + 1
  return counts
}

export function acceptedFromVerdicts(candidates: Candidate[], verdicts: Verdict[], maxFindings: number): Candidate[] {
  const byId = new Map(candidates.map((candidate): [string, Candidate] => [candidate.candidateId, candidate]))
  const accepted: Candidate[] = []
  for (const verdict of verdicts.filter(Boolean)) {
    if (verdict.status !== 'accepted' && verdict.status !== 'severity_downgraded') continue
    if (typeof verdict.candidateId !== 'string') continue
    const candidate = byId.get(verdict.candidateId)
    if (!candidate) continue
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
  return accepted.sort(bySeverity).slice(0, maxFindings)
}

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
