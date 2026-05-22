"use server";

// Server Action for manual AP item reassignment. Mirror of
// reassign-ar-item.ts — same shape, different recordType.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { reassignRecord, ReassignError } from "@/lib/ownership/reassign";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";

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
    const user = await requireCurrentUser();

    if (!input.openItemId) return { ok: false, message: "openItemId required" };
    if (!input.newOwnerId) return { ok: false, message: "newOwnerId required" };
    if (input.newOwnerType !== "USER" && input.newOwnerType !== "QUEUE") {
      return { ok: false, message: "newOwnerType must be USER or QUEUE" };
    }

    await reassignRecord(prisma, {
      recordType: "ApOpenItem",
      recordId: input.openItemId,
      newOwner: { type: input.newOwnerType, id: input.newOwnerId },
      actorUserId: user.id,
      reason: input.reason?.trim() || `manual:by ${user.displayName}`,
      lockFromRules: true,
    });

    revalidatePath("/ap");
    return { ok: true };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    if (e instanceof ReassignError) {
      return { ok: false, message: `${e.code}: ${e.message}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
