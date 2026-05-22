"use server";

// Server Action for manually reassigning an open AR item to another user
// or queue. Backs the "Reassign" control in the AR list UI.
//
// Permission model (interim): any logged-in user can reassign. When the
// granular permission catalog from docs/ownership-and-rules.md lands,
// this checks `can_reassign:subledger.ar` before proceeding.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { reassignRecord, ReassignError } from "@/lib/ownership/reassign";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";

export interface ReassignArItemState {
  ok: boolean;
  message?: string;
}

export async function reassignArItemAction(input: {
  openItemId: string;
  newOwnerType: "USER" | "QUEUE";
  newOwnerId: string;
  reason?: string;
}): Promise<ReassignArItemState> {
  try {
    const user = await requireCurrentUser();

    if (!input.openItemId) return { ok: false, message: "openItemId required" };
    if (!input.newOwnerId) return { ok: false, message: "newOwnerId required" };
    if (input.newOwnerType !== "USER" && input.newOwnerType !== "QUEUE") {
      return { ok: false, message: "newOwnerType must be USER or QUEUE" };
    }

    await reassignRecord(prisma, {
      recordType: "ArOpenItem",
      recordId: input.openItemId,
      newOwner: { type: input.newOwnerType, id: input.newOwnerId },
      actorUserId: user.id,
      reason: input.reason?.trim() || `manual:by ${user.displayName}`,
      lockFromRules: true, // manual reassignments lock the record from rules
    });

    revalidatePath("/ar");
    return { ok: true };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    if (e instanceof ReassignError) {
      return { ok: false, message: `${e.code}: ${e.message}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
