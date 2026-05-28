"use server";

// Toggle the tenant's requireJeApproval flag. ADMIN+ only.
//
// When enabled, journal entries posted by MEMBERS flow to
// PENDING_APPROVAL instead of POSTED. ADMINs and OWNERs still post
// directly (they're the approvers).

import { revalidatePath } from "next/cache";
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
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof PermissionDeniedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
