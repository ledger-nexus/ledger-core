"use server";

// Admin user-lifecycle Server Actions. Deactivating a user is what creates
// orphan records — the orphan dashboard's prevention-side counterpart.
//
// deactivateUserAction is the in-miniature version of the role-change
// preflight UX from docs/ownership-and-rules.md:
//
//   1. Admin picks a user to deactivate
//   2. UI previews the user's currently-owned records (via
//      previewOrphansForUserChange)
//   3. Admin chooses to either:
//      a. Reassign all owned records to a queue/user first, then deactivate
//         (no orphans created — the preferred path)
//      b. Deactivate anyway (orphans created; admin triages on the orphan
//         dashboard later)
//
// reactivateUserAction reverses deactivation. Does NOT auto-restore
// ownership — records that were reassigned away during deactivation stay
// with their new owners. The user comes back active but with an empty
// queue, which is the right semantic.
//
// Permission: requireAdmin.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  reassignRecordInTx,
  ReassignError,
} from "@/lib/ownership/reassign";
import { previewOrphansForUserChange } from "@/lib/ownership/orphan-detection";
import {
  requireAdmin,
  NotAuthenticatedError,
  NotAuthorizedError,
} from "@/lib/auth/current-user";
import { withTenantContext } from "@/lib/db/tenant-context";

export interface DeactivateUserInput {
  userId: string;
  /**
   * If set, reassigns ALL records currently owned by this user to the
   * target before flipping isActive=false. Prevents orphan creation.
   * If null/undefined, the deactivation proceeds without reassignment
   * and orphans are created (admin will see them on /admin/orphans).
   */
  reassignTo?: { type: "USER" | "QUEUE"; id: string };
  reason?: string;
}

export interface DeactivateUserState {
  ok: boolean;
  message?: string;
  /** Count of records reassigned away from the user before deactivation. */
  reassignedCount?: number;
  /** Count of records that failed to reassign (still orphans after action). */
  failedCount?: number;
}

export async function deactivateUserAction(
  input: DeactivateUserInput
): Promise<DeactivateUserState> {
  try {
    const admin = await requireAdmin();

    if (!input.userId) return { ok: false, message: "userId required" };
    if (input.userId === admin.id) {
      return { ok: false, message: "You can't deactivate yourself" };
    }

    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, isActive: true, displayName: true },
    });
    if (!user) return { ok: false, message: "User not found" };
    if (!user.isActive) {
      return { ok: false, message: `${user.displayName} is already deactivated` };
    }

    let reassignedCount = 0;
    let failedCount = 0;

    // Step 1 (optional): bulk-reassign owned records before flipping.
    //
    // RLS Phase 2b — multi-tenant batch shape: this action is NOT scoped
    // to a single tenant. A globally-deactivated user can own records
    // across multiple tenants, so each loop iteration sets its OWN GUC
    // via withTenantContext(rec.tenantId, ...). OrphanedRecord was
    // extended to carry tenantId so the loop has it without re-querying.
    //
    // Each iteration runs in its own short transaction (the substrate
    // contract for reassignRecord — per-record atomicity, no batch
    // rollback). A single failure just lands in failedCount; the user
    // is still deactivated in step 2.
    if (input.reassignTo) {
      const owned = await previewOrphansForUserChange(prisma, input.userId);
      const reason =
        input.reason?.trim() ||
        `lifecycle:user-deactivation by ${admin.displayName}`;
      for (const rec of owned) {
        const reassignInput = {
          recordType: rec.recordType,
          recordId: rec.recordId,
          newOwner: input.reassignTo,
          actorUserId: admin.id,
          // Same record-tenant scope as the GUC — record lookup tenant
          // predicate retained as defense in depth.
          actorTenantId: rec.tenantId,
          reason,
          // Lifecycle reassignments do NOT lock — the new owner should
          // still be subject to rule firings (e.g., aging escalation).
          lockFromRules: false,
          // Suppress per-record notifications during bulk deactivation —
          // a Carla-deactivates-Anna flow that moves 50 records would
          // otherwise flood the new owner's inbox.
          silent: true,
        };
        try {
          await withTenantContext(rec.tenantId, async (tx) =>
            reassignRecordInTx(tx, reassignInput)
          );
          // Notification emit is suppressed via silent:true — no
          // emitReassignmentNotification call here.
          reassignedCount += 1;
        } catch (e) {
          // Best-effort bulk reassignment. A single failure shouldn't
          // block deactivation — the failed records will surface as
          // orphans afterward.
          failedCount += 1;
          if (e instanceof ReassignError) {
            console.warn(
              `Skipping reassignment of ${rec.recordType} ${rec.recordId.slice(0, 8)}: ${e.code} ${e.message}`
            );
          } else {
            console.warn(
              `Skipping reassignment of ${rec.recordType} ${rec.recordId.slice(0, 8)}:`,
              e
            );
          }
        }
      }
    }

    // Step 2: flip the user to inactive.
    // User table is shared/global (no tenantId per RLS Phase 1 design),
    // so no withTenantContext wrap is needed for this write.
    await prisma.user.update({
      where: { id: input.userId },
      data: { isActive: false, deactivatedAt: new Date() },
    });

    revalidatePath("/admin/users");
    revalidatePath("/admin/orphans");
    revalidatePath("/", "layout"); // refresh the user-switcher in the header
    return {
      ok: true,
      message: input.reassignTo
        ? `Deactivated ${user.displayName} · reassigned ${reassignedCount} record(s)${failedCount > 0 ? ` · ${failedCount} failed (now orphans)` : ""}`
        : `Deactivated ${user.displayName} · their owned records are now orphans`,
      reassignedCount,
      failedCount,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    if (e instanceof NotAuthorizedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function reactivateUserAction(
  userId: string
): Promise<DeactivateUserState> {
  try {
    await requireAdmin();
    if (!userId) return { ok: false, message: "userId required" };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true, displayName: true },
    });
    if (!user) return { ok: false, message: "User not found" };
    if (user.isActive) {
      return { ok: false, message: `${user.displayName} is already active` };
    }

    await prisma.user.update({
      where: { id: userId },
      data: { isActive: true, deactivatedAt: null },
    });

    revalidatePath("/admin/users");
    revalidatePath("/admin/orphans");
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `Reactivated ${user.displayName}. (Their previous records were NOT auto-restored; reassign manually if needed.)`,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    if (e instanceof NotAuthorizedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
