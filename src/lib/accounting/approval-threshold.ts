// Decides whether a new journal entry should land directly POSTED or
// go through the PENDING_APPROVAL queue, based on the tenant's
// requireJeApproval flag + optional jeApprovalMinAmount threshold +
// the actor's role.
//
// Pure function (no DB, no I/O) so the matrix below is testable in
// isolation. Server Actions resolve the inputs from prisma + currentUser
// and call this — keeps the policy in one place.

import Decimal from "decimal.js";

export interface ResolveApprovalRouteInput {
  /** Tenant.requireJeApproval — false short-circuits to POSTED. */
  requireJeApproval: boolean;
  /**
   * Tenant.jeApprovalMinAmount — null OR ≤ 0 means "every non-approver
   * entry requires approval" (the original binary behavior). When > 0,
   * only entries whose total >= threshold require approval; smaller
   * entries POST directly.
   */
  jeApprovalMinAmount: Decimal | null | undefined;
  /**
   * Sum of debit lines on the candidate entry (== sum of credit lines
   * for a balanced entry). Caller is responsible for computing this in
   * the entry's currency.
   */
  entryTotal: Decimal;
  /**
   * True when the current actor can approve journal entries. Admins
   * + owners bypass the queue — their own direct postings are trusted.
   */
  actorIsApprover: boolean;
}

export type ApprovalRoute = "POSTED" | "PENDING_APPROVAL";

export function resolveApprovalRoute(
  input: ResolveApprovalRouteInput
): ApprovalRoute {
  // Approver bypass: ADMIN+ direct posts go straight to the ledger
  // regardless of the flag or threshold.
  if (input.actorIsApprover) return "POSTED";

  // Flag off: every entry POSTS directly.
  if (!input.requireJeApproval) return "POSTED";

  // Flag on, no threshold (or threshold ≤ 0): the binary behavior —
  // all non-approver entries go to the queue.
  const threshold = input.jeApprovalMinAmount;
  if (threshold == null || threshold.lessThanOrEqualTo(0)) {
    return "PENDING_APPROVAL";
  }

  // Threshold gate: queue only when total ≥ threshold. We compare on
  // the entry's currency-units; ledger-core's invariant is one
  // currency per entry, so this is unambiguous.
  return input.entryTotal.greaterThanOrEqualTo(threshold)
    ? "PENDING_APPROVAL"
    : "POSTED";
}
