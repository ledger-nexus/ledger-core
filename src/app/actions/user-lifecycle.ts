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
// Permission: canManageUsers (ADMIN+ in the current tenant), and the
// target user must be a member of the current tenant. User.isActive is
// GLOBAL (no tenantId on app_user per RLS Phase 1), so without the
// membership check a tenant admin could deactivate any user in the
// system by UUID. The membership requirement narrows the blast radius
// to "your own team"; true per-tenant removal (revoking a membership
// instead of flipping the global flag) arrives with team management.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  reassignRecordInTx,
  ReassignError,
} from "@/lib/ownership/reassign";
import { previewOrphansForUserChange } from "@/lib/ownership/orphan-detection";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import { canManageUsers, PermissionDeniedError } from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { withTenantContext } from "@/lib/tenant-context";
import { sanitizeActionError } from "@/lib/actions/action-error";

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
    const { user: admin, tenant } = await requirePermitted(
      "user.manage",
      canManageUsers
    );

    if (!input.userId) return { ok: false, message: "userId required" };
    if (input.userId === admin.id) {
      return { ok: false, message: "You can't deactivate yourself" };
    }

    // Target must share the admin's CURRENT tenant — admin is a
    // per-tenant role, not a global one. Same "User not found" message
    // as the null case so the action doesn't leak which user UUIDs
    // exist outside the caller's tenant.
    const targetMembership = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenant.id, userId: input.userId },
      select: { id: true },
    });
    if (!targetMembership) return { ok: false, message: "User not found" };

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
    // via withTenantContext(prisma, rec.tenantId, ...). OrphanedRecord was
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
          await withTenantContext(prisma, rec.tenantId, async (tx) =>
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
          // Caller-controlled record fields go to console.warn as
          // structured args, never the format-string position (CodeQL
          // js/tainted-format-string).
          if (e instanceof ReassignError) {
            console.warn("Skipping reassignment (ReassignError):", {
              recordType: rec.recordType,
              recordId: rec.recordId.slice(0, 8),
              code: e.code,
              message: e.message,
            });
          } else {
            console.warn("Skipping reassignment:", {
              recordType: rec.recordType,
              recordId: rec.recordId.slice(0, 8),
              error: e,
            });
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

    await auditPrivilegedAction({
      actor: { id: admin.id, email: admin.email },
      action: "user.deactivate",
      resource: "User",
      resourceId: input.userId,
      tenantId: tenant.id,
      metadata: {
        reassignedTo: input.reassignTo ?? null,
        reassignedCount,
        failedCount,
      },
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
    if (e instanceof PermissionDeniedError) return { ok: false, message: e.message };
    return { ok: false, message: sanitizeActionError(e, "Unknown error") };
  }
}

export async function reactivateUserAction(
  userId: string
): Promise<DeactivateUserState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "user.manage",
      canManageUsers
    );
    if (!userId) return { ok: false, message: "userId required" };

    // Same tenant-membership pin as deactivateUserAction above.
    const targetMembership = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenant.id, userId },
      select: { id: true },
    });
    if (!targetMembership) return { ok: false, message: "User not found" };

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

    await auditPrivilegedAction({
      actor: { id: admin.id, email: admin.email },
      action: "user.reactivate",
      resource: "User",
      resourceId: userId,
      tenantId: tenant.id,
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
    if (e instanceof PermissionDeniedError) return { ok: false, message: e.message };
    return { ok: false, message: sanitizeActionError(e, "Unknown error") };
  }
}
