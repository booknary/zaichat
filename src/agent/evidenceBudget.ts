import { EvidenceBudgetState } from "../core/types";

export interface BudgetedArrayResult<T> {
  content: {
    items: T[];
    totalAvailable: number;
    truncated: boolean;
    evidenceDelivery: "no-matches" | "delivered" | "budget-truncated";
    instruction: string;
  };
  usedChars: number;
  truncated: boolean;
}

/**
 * Fit complete array entries into a shared evidence budget. Entries are never
 * cut in the middle, so the tool message always remains valid JSON.
 */
export function fitArrayToEvidenceBudget<T>(
  items: T[],
  budget: EvidenceBudgetState,
  perCallLimitChars: number,
): BudgetedArrayResult<T> {
  const allowed = Math.max(
    0,
    Math.min(budget.remainingChars, Math.max(0, perCallLimitChars)),
  );
  const kept: T[] = [];
  for (const item of items) {
    const candidate = envelope([...kept, item], items.length);
    if (jsonChars(candidate) > allowed) break;
    kept.push(item);
  }
  const content = envelope(kept, items.length);
  const usedChars = Math.min(allowed, jsonChars(content));
  budget.remainingChars = Math.max(0, budget.remainingChars - usedChars);
  return {
    content,
    usedChars,
    truncated: kept.length < items.length,
  };
}

export function jsonChars(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Candidate browsing must leave part of the same total budget for verification. */
export function candidateAllowance(budget: EvidenceBudgetState): number {
  budget.candidateRemainingChars ??= Math.floor(budget.remainingChars * 0.6);
  // Earlier abstract reads also spend the shared balance. Preserve a final
  // reading reserve even if the original browsing allowance remains unused.
  const reserve = (budget.verificationReserveChars ??= Math.min(
    12000,
    Math.floor(budget.remainingChars * 0.2),
  ));
  return Math.max(
    0,
    Math.min(budget.remainingChars - reserve, budget.candidateRemainingChars),
  );
}

export function fitCandidatesToEvidenceBudget<T>(
  items: T[],
  budget: EvidenceBudgetState,
  perCallLimit: number,
): BudgetedArrayResult<T> {
  const fitted = fitArrayToEvidenceBudget(
    items,
    budget,
    Math.min(perCallLimit, candidateAllowance(budget)),
  );
  budget.candidateRemainingChars! -= fitted.usedChars;
  if (fitted.truncated && candidateAllowance(budget) < 3_000)
    fitted.content.instruction =
      "Candidate browsing budget is nearly exhausted. Preserve the remaining evidence budget for verify_candidates on promising delivered sources. Unseen matches remain; do not infer absence or keep paging without progress.";
  return fitted;
}

function envelope<T>(items: T[], totalAvailable: number) {
  return {
    items,
    totalAvailable,
    truncated: items.length < totalAvailable,
    evidenceDelivery:
      totalAvailable === 0
        ? ("no-matches" as const)
        : items.length < totalAvailable
          ? ("budget-truncated" as const)
          : ("delivered" as const),
    instruction:
      items.length < totalAvailable
        ? "Local matches exist but the evidence budget prevented delivery of some or all entries. This is NOT a no-match result and cannot establish absence. Use already delivered evidence or report incomplete verification."
        : "This bounded result is not an exhaustive absence finding for the library or document.",
  };
}
