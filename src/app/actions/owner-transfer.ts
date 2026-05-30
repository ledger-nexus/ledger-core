"use server";

// Ownership transfer Server Actions. Three transitions:
//   initiateOwnerTransferAction — current OWNER initiates an offer
//   acceptOwnerTransferAction   — pending TARGET accepts (atomic swap)
//   cancelOwnerTransferAction   — either side can cancel a pending offer
//
// Auth model:
//   - all three require a signed-in user with a current tenant
//   - the lifecycle module enforces the substantive checks
//     (only-OWNER initiates, only-TARGET accepts, etc.) so this layer
//     stays thin
//
// Audit: every transition emits auditPrivilegedAction so the
// audit-log page captures the chain (SOC 2 CC4 / CC6).

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
  initiateOwnerTransfer,
  acceptOwnerTransfer,
  cancelOwnerTransfer,
  NotCurrentOwnerError,
  SelfTransferError,
  TargetNotMemberError,
  TransferAlreadyPendingError,
  NoTransferPendingError,
  NotTransferPartyError,
} from "@/lib/auth/owner-transfer";
import { auditPrivilegedAction } from "@/lib/audit/log";

export interface OwnerTransferActionState {
  ok: boolean;
  message?: string;
}

// ─── initiate ──────────────────────────────────────────────────────────────

export async function initiateOwnerTransferAction(
  targetUserId: string
): Promise<OwnerTransferActionState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const result = await initiateOwnerTransfer(prisma, {
      tenantId: tenant.id,
      currentOwnerUserId: user.id,
      targetUserId,
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "tenant.owner_transfer_initiate",
      resource: "Tenant",
      resourceId: tenant.id,
      metadata: { targetUserId: result.targetUserId },
    });

    revalidatePath("/admin/team");

    return {
      ok: true,
      message:
        "Transfer offered. The recipient must accept from /admin/team to complete the hand-off.",
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── accept ────────────────────────────────────────────────────────────────

export async function acceptOwnerTransferAction(): Promise<OwnerTransferActionState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const result = await acceptOwnerTransfer(prisma, {
      tenantId: tenant.id,
      accepterUserId: user.id,
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "tenant.owner_transfer_accept",
      resource: "Tenant",
      resourceId: tenant.id,
      metadata: {
        previousOwnerUserId: result.previousOwnerUserId,
        newOwnerUserId: result.newOwnerUserId,
      },
    });

    revalidatePath("/admin/team");
    revalidatePath("/admin");
    revalidatePath("/");

    return {
      ok: true,
      message:
        "Ownership transferred. You are now the OWNER; the previous OWNER is now ADMIN.",
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── cancel ────────────────────────────────────────────────────────────────

export async function cancelOwnerTransferAction(): Promise<OwnerTransferActionState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const result = await cancelOwnerTransfer(prisma, {
      tenantId: tenant.id,
      cancellerUserId: user.id,
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "tenant.owner_transfer_cancel",
      resource: "Tenant",
      resourceId: tenant.id,
      metadata: { cancelledBy: result.cancelledBy },
    });

    revalidatePath("/admin/team");

    return {
      ok: true,
      message:
        result.cancelledBy === "OWNER"
          ? "Transfer cancelled. The recipient has been removed."
          : "Transfer declined. The current OWNER stays in place.",
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── Error mapping ─────────────────────────────────────────────────────────

function mapError(e: unknown): OwnerTransferActionState {
  if (e instanceof NotAuthenticatedError)
    return { ok: false, message: "You must be signed in." };
  if (e instanceof NoTenantSelectedError)
    return { ok: false, message: e.message };
  if (e instanceof NotCurrentOwnerError)
    return { ok: false, message: e.message };
  if (e instanceof SelfTransferError)
    return { ok: false, message: e.message };
  if (e instanceof TargetNotMemberError)
    return { ok: false, message: e.message };
  if (e instanceof TransferAlreadyPendingError)
    return { ok: false, message: e.message };
  if (e instanceof NoTransferPendingError)
    return { ok: false, message: e.message };
  if (e instanceof NotTransferPartyError)
    return { ok: false, message: e.message };
  return {
    ok: false,
    message: e instanceof Error ? e.message : "Unknown error",
  };
}
