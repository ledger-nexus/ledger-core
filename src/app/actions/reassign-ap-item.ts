"use server";

// Server Action for manual AP item reassignment. Mirror of
// reassign-ar-item.ts — same shape, different recordType.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  reassignRecordInTx,
  emitReassignmentNotification,
  ReassignError,
} from "@/lib/ownership/reassign";
import { NotAuthenticatedError } from "@/lib/auth/current-user";

import { withTenantContext } from "@/lib/tenant-context";
import { sanitizeActionError } from "@/lib/actions/action-error";
import { requireActor } from "@/lib/auth/authorize";

export interface ReassignApItemState {
  ok: boolean;
  message?: string;
}

export async function reassignApItemAction(input: {
  openItemId: string;
  newOwnerType: "USER" | "QUEUE";
  newOwnerId: string;
  reason?: string;
}): Promise<ReassignApItemState> {
  try {
    const { user, tenant } = await requireActor("ap.item.reassign");

    if (!input.openItemId) return { ok: false, message: "openItemId required" };
    if (!input.newOwnerId) return { ok: false, message: "newOwnerId required" };
    if (input.newOwnerType !== "USER" && input.newOwnerType !== "QUEUE") {
      return { ok: false, message: "newOwnerType must be USER or QUEUE" };
    }

    // RLS Phase 2b Class T: call reassignRecordInTx from inside
    // withTenantContext so the GUC reaches every read/write. Then emit
    // the notification OUTSIDE the tx — failures must not roll back a
    // successful reassignment (preserves the legacy reassignRecord
    // wrapper's contract).
    const reassignInput = {
      recordType: "ApOpenItem" as const,
      recordId: input.openItemId,
      newOwner: { type: input.newOwnerType, id: input.newOwnerId },
      actorUserId: user.id,
      // SECURITY: tenant-scope. See reassign-ar-item.ts for rationale.
      actorTenantId: tenant.id,
      reason: input.reason?.trim() || `manual:by ${user.displayName}`,
      lockFromRules: true,
    };
    await withTenantContext(prisma, tenant.id, async (tx) =>
      reassignRecordInTx(tx, reassignInput)
    );

    // Bell ring — non-fatal. Try/catch so a notification failure doesn't
    // surface as a reassignment failure (the reassignment already committed).
    try {
      await emitReassignmentNotification(prisma, reassignInput);
    } catch (e) {
      // Keep caller-controlled data out of console.warn's format-string
      // position (CodeQL js/tainted-format-string) — pass it structured.
      console.warn("Reassignment succeeded but notification emit failed:", {
        recordType: "ApOpenItem",
        openItemId: input.openItemId.slice(0, 8),
        error: e,
      });
    }

    revalidatePath("/ap");
    return { ok: true };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    if (e instanceof ReassignError) {
      return { ok: false, message: `${e.code}: ${e.message}` };
    }
    return { ok: false, message: sanitizeActionError(e, "Unknown error") };
  }
}
