// Server Action for posting a period-end FX revaluation.
//
// This is the human-approval gate the repo's "AI suggests; humans
// approve; the system posts" rule requires. computeRevaluation +
// postRevaluation are machine logic; nothing posts until a tenant admin
// clicks "Post revaluation" on /reports/fx-revaluation, which lands
// here. The underlying postRevaluation then posts source=AI_APPROVED.
//
// SOC 2:
//   CC6.1  scope (entity, book) resolved from the session, never client input
//   CC6.3  canClosePeriods (ADMIN+) — authenticated AND authorized; non-admins
//          get a structured NOT_ADMIN error + an ACCESS_DENIED audit row
//   CC6.8  periodCode validated (YYYY-MM / YYYY-Qn shape) before use
//   CC7.2  postRevaluation writes the fx.revaluation.post audit row; the
//          access-denied path audits here

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { canClosePeriods } from "@/lib/auth/policy";
import { auditAccessDenied } from "@/lib/audit/log";
import { postRevaluation } from "@/lib/accounting/revaluation-posting";
import { sanitizeActionError } from "@/lib/actions/action-error";

// Period codes are "2026-06" (monthly) or "2026-Q2" (quarterly). Keep the
// validation permissive of both but reject free-form input.
const Input = z.object({
  periodCode: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/, "periodCode must be YYYY-MM or YYYY-Qn"),
});

export type FxRevaluationActionResult =
  | {
      ok: true;
      posted: boolean;
      wasDuplicate: boolean;
      noop: boolean;
      adjustmentEntryNumber?: string;
      reversalEntryNumber?: string;
      totalGainLoss: string;
    }
  | { ok: false; code: string; error: string };

export async function postFxRevaluationAction(
  input: z.infer<typeof Input>
): Promise<FxRevaluationActionResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      error: parsed.error.errors[0]?.message ?? "Invalid input",
    };
  }

  let user: { id: string; email: string };
  try {
    user = await requireCurrentUser();
  } catch {
    await auditAccessDenied({
      attemptedAction: "fx.revaluation.post",
      reason: "Not authenticated",
      resource: "JournalEntry",
    });
    return { ok: false, code: "UNAUTHENTICATED", error: "Sign in required" };
  }

  let tenant;
  try {
    tenant = await requireCurrentTenant();
  } catch {
    return { ok: false, code: "NO_TENANT", error: "No active tenant" };
  }

  // Same floor as period close — an FX revaluation posts adjustment +
  // reversal JEs that land directly in reported balances.
  if (!canClosePeriods(tenant.role)) {
    await auditAccessDenied({
      attemptedAction: "fx.revaluation.post",
      actor: { id: user.id, email: user.email },
      reason: "Not a tenant admin",
      resource: "JournalEntry",
    });
    return {
      ok: false,
      code: "NOT_ADMIN",
      error: "Only a tenant admin can post an FX revaluation",
    };
  }

  // Scope is session-derived (never client input) — closes the
  // cross-tenant write the raw cookie could otherwise enable.
  const scope = await getCurrentScope();
  if (!scope) {
    return { ok: false, code: "NO_SCOPE", error: "Select a tenant + entity first" };
  }

  try {
    const result = await postRevaluation(
      prisma,
      {
        tenantId: scope.tenantId,
        entityCode: scope.entityCode,
        bookCode: scope.bookCode,
        periodCode: parsed.data.periodCode,
      },
      { createdBy: user.email, ownerUserId: user.id, actor: user }
    );

    revalidatePath("/reports/fx-revaluation");
    revalidatePath("/journal-entries");
    revalidatePath("/close/tasks");

    return {
      ok: true,
      posted: result.posted,
      wasDuplicate: result.wasDuplicate,
      noop: result.noop,
      adjustmentEntryNumber: result.adjustmentEntryNumber,
      reversalEntryNumber: result.reversalEntryNumber,
      totalGainLoss: result.computed.totalUnrealizedGainLoss.toString(),
    };
  } catch (e) {
    return {
      ok: false,
      code: "POST_FAILED",
      error: sanitizeActionError(e, "Unknown error posting revaluation"),
    };
  }
}
