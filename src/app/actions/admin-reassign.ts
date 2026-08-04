"use server";

// Generic reassignment Server Action for the admin orphan dashboard.
// Unlike reassignArItemAction (which is AR-specific and used inline on
// /ar), this one dispatches by recordType and is gated by requireAdmin.
//
// Why admin-gated: the AR list page lets any authenticated user reassign
// items within AR — that's a normal workflow action. The orphan dashboard
// surfaces records across modules in problematic state, which is an
// administrative repair operation.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  reassignRecordInTx,
  emitReassignmentNotification,
  ReassignError,
  type ReassignableRecordType,
} from "@/lib/ownership/reassign";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import {
  canManageReassignmentRules,
  PermissionDeniedError,
} from "@/lib/auth/policy";
import { withTenantContext } from "@/lib/tenant-context";

export interface AdminReassignState {
  ok: boolean;
  message?: string;
}

export async function adminReassignAction(input: {
  recordType: ReassignableRecordType;
  recordId: string;
  newOwnerType: "USER" | "QUEUE";
  newOwnerId: string;
  reason?: string;
}): Promise<AdminReassignState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "reassignment.execute",
      canManageReassignmentRules
    );

    if (!input.recordId) return { ok: false, message: "recordId required" };
    if (!input.newOwnerId) return { ok: false, message: "newOwnerId required" };
    if (input.newOwnerType !== "USER" && input.newOwnerType !== "QUEUE") {
      return { ok: false, message: "newOwnerType must be USER or QUEUE" };
    }
    if (input.recordType !== "JournalEntry" && input.recordType !== "ArOpenItem") {
      return { ok: false, message: `recordType ${input.recordType} not reassignable` };
    }

    // RLS Phase 2b Class T: tx-scoped reassignRecordInTx +
    // outside-tx notification emit. See reassign-ap-item.ts for the
    // two-phase rationale.
    const reassignInput = {
      recordType: input.recordType,
      recordId: input.recordId,
      newOwner: { type: input.newOwnerType, id: input.newOwnerId },
      actorUserId: admin.id,
      // SECURITY: scope to the admin's current tenant. An admin
      // signed in to tenant A can't reach into tenant B's orphans.
      actorTenantId: tenant.id,
      reason: input.reason?.trim() || `admin:orphan repair by ${admin.displayName}`,
      lockFromRules: true,
    };
    await withTenantContext(prisma, tenant.id, async (tx) =>
      reassignRecordInTx(tx, reassignInput)
    );

    try {
      await emitReassignmentNotification(prisma, reassignInput);
    } catch (e) {
      // Keep caller-controlled data out of console.warn's format-string
      // position (CodeQL js/tainted-format-string) — pass it structured.
      console.warn("Admin reassignment succeeded but notification emit failed:", {
        recordType: input.recordType,
        recordId: input.recordId.slice(0, 8),
        error: e,
      });
    }

    revalidatePath("/admin/orphans");
    return { ok: true };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    if (e instanceof PermissionDeniedError) return { ok: false, message: e.message };
    if (e instanceof ReassignError) {
      return { ok: false, message: `${e.code}: ${e.message}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
