/** @file Decide whether a worst-case-priced call fits the remaining budget. */

/** Tracks the hard budget, the audit reservation, and cumulative admitted spend. */
export interface AdmissionState {
  budgetUsd: number // hard GBP budget x usdPerGbp from the table
  reservedAuditUsd: number
  spentUsd: number // sum of admitted worst-case estimates
}

/** Reports an admission outcome; refusals carry a human-readable reason. */
export type AdmissionDecision =
  | { admitted: true; worstCaseUsd: number }
  | { admitted: false; reason: string; worstCaseUsd: number }

/**
 * Decides whether a worst-case-priced call is admitted under the current
 * spend. A `luna-transaction` must leave room for the standing audit
 * reservation; a `terra-audit` consumes that reservation itself, so its own
 * worst-case estimate is not added on top of `reservedAuditUsd` again. This
 * function never mutates `state`.
 */
export function admit(
  state: AdmissionState,
  worstCaseUsd: number,
  kind: 'luna-transaction' | 'terra-audit',
): AdmissionDecision {
  const projected =
    kind === 'luna-transaction'
      ? state.spentUsd + worstCaseUsd + state.reservedAuditUsd
      : state.spentUsd + worstCaseUsd

  if (projected <= state.budgetUsd) {
    return { admitted: true, worstCaseUsd }
  }

  const overUsd = projected - state.budgetUsd

  return {
    admitted: false,
    reason: `admitting this ${kind} would exceed the budget by USD ${overUsd.toFixed(5)}`,
    worstCaseUsd,
  }
}
