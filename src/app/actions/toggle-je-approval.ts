"use server";

// Toggle the tenant's requireJeApproval flag + set/clear the optional
// jeApprovalMinAmount threshold. ADMIN+ only.
//
// When the flag is on, journal entries posted by MEMBERS flow to
// PENDING_APPROVAL instead of POSTED. ADMINs and OWNERs still post
// directly (they're the approvers). The threshold further filters
// which entries actually queue — entries below it post directly even
// from MEMBERS. Null/zero threshold = original binary behavior.

import { revalidatePath } from "next/cache";
import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import {
  requireCurrentTenant,
  NoTenantSelectedError,
} from "@/lib/auth/tenant";
import {
  canViewAdminPages,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { sanitizeActionError } from "@/lib/actions/action-error";

export async function toggleRequireJeApprovalAction(
  enabled: boolean
): Promise<{ ok: boolean; message?: string }> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("toggle_je_approval", tenant.role, canViewAdminPages);

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { requireJeApproval: enabled },
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "tenant.toggle_je_approval",
      resource: "Tenant",
      resourceId: tenant.id,
      metadata: { newValue: enabled },
    });

    revalidatePath("/admin/team");
    revalidatePath("/journal-entries/pending");

    return {
      ok: true,
      message: enabled
        ? "MEMBER-posted entries now flow through the approval queue."
        : "Approval queue disabled — MEMBER posts go straight to the ledger.",
    };
  } catch (e) {
    return mapError(e);
  }
}

export async function setJeApprovalThresholdAction(
  rawAmount: string
): Promise<{ ok: boolean; message?: string }> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("toggle_je_approval", tenant.role, canViewAdminPages);

    // Normalize: empty / whitespace / non-positive number → clear it
    // (null in the DB = original binary behavior). Anything else must
    // parse as a finite, positive Decimal — reject silently-bad
    // input so the operator notices.
    const trimmed = rawAmount.trim();
    let parsed: Decimal | null = null;
    if (trimmed.length > 0) {
      try {
        const d = new Decimal(trimmed);
        if (!d.isFinite() || d.isNaN()) {
          return { ok: false, message: "Threshold must be a number." };
        }
        if (d.lessThanOrEqualTo(0)) {
          // Operator clearing the field; null is the cleanest storage.
          parsed = null;
        } else {
          parsed = d;
        }
      } catch {
        return { ok: false, message: "Threshold must be a number." };
      }
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { jeApprovalMinAmount: parsed ? parsed.toFixed(4) : null },
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "tenant.set_je_approval_threshold",
      resource: "Tenant",
      resourceId: tenant.id,
      metadata: { newValue: parsed ? parsed.toFixed(2) : null },
    });

    revalidatePath("/admin/team");
    revalidatePath("/journal-entries/pending");

    return {
      ok: true,
      message: parsed
        ? `Threshold set: only entries of ${parsed.toFixed(2)} or more will require approval.`
        : `Threshold cleared: every non-admin entry will require approval when the flag is on.`,
    };
  } catch (e) {
    return mapError(e);
  }
}

function mapError(e: unknown): { ok: boolean; message?: string } {
  if (e instanceof NotAuthenticatedError)
    return { ok: false, message: "You must be signed in." };
  if (e instanceof NoTenantSelectedError)
    return { ok: false, message: e.message };
  if (e instanceof PermissionDeniedError)
    return { ok: false, message: e.message };
  return { ok: false, message: sanitizeActionError(e, "Unknown error") };
}
