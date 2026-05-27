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
  reassignRecord,
  ReassignError,
  type ReassignableRecordType,
} from "@/lib/ownership/reassign";
import {
  requireAdmin,
  NotAuthenticatedError,
  NotAuthorizedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";

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
    const admin = await requireAdmin();
    const tenant = await requireCurrentTenant();

    if (!input.recordId) return { ok: false, message: "recordId required" };
    if (!input.newOwnerId) return { ok: false, message: "newOwnerId required" };
    if (input.newOwnerType !== "USER" && input.newOwnerType !== "QUEUE") {
      return { ok: false, message: "newOwnerType must be USER or QUEUE" };
    }
    if (input.recordType !== "JournalEntry" && input.recordType !== "ArOpenItem") {
      return { ok: false, message: `recordType ${input.recordType} not reassignable` };
    }

    await reassignRecord(prisma, {
      recordType: input.recordType,
      recordId: input.recordId,
      newOwner: { type: input.newOwnerType, id: input.newOwnerId },
      actorUserId: admin.id,
      // SECURITY: scope to the admin's current tenant. An admin
      // signed in to tenant A can't reach into tenant B's orphans.
      actorTenantId: tenant.id,
      reason: input.reason?.trim() || `admin:orphan repair by ${admin.displayName}`,
      lockFromRules: true,
    });

    revalidatePath("/admin/orphans");
    return { ok: true };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    if (e instanceof NotAuthorizedError) return { ok: false, message: e.message };
    if (e instanceof ReassignError) {
      return { ok: false, message: `${e.code}: ${e.message}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
