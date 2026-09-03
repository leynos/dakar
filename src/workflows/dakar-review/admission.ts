/**
 * Decide whether a worst-case-priced call fits the remaining budget.
 *
 * @module
 */

/** Tracks the hard budget, the audit reservation, and cumulative admitted spend. */
export interface AdmissionState {
  /** Hard GBP budget multiplied by `usdPerGbp` from the pricing table. */
  budgetUsd: number // hard GBP budget x usdPerGbp from the table
  /** USD reservation held back for the standing audit call. */
  reservedAuditUsd: number
  /** Sum of admitted worst-case estimates. */
  spentUsd: number // sum of admitted worst-case estimates
}

/** Reports an admission outcome; refusals carry a human-readable reason. */
export type AdmissionDecision =
  | {
      /** Whether the call was admitted. */
      admitted: true
      /** Worst-case USD estimate for the admitted call. */
      worstCaseUsd: number
    }
  | {
      /** Whether the call was admitted. */
      admitted: false
      /** Human-readable explanation for the refusal. */
      reason: string
      /** Worst-case USD estimate that would have exceeded the budget. */
      worstCaseUsd: number
    }

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
