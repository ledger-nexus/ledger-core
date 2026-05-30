// Ownership transfer lifecycle for a tenant. Three transitions:
//
//   initiate(tenantId, currentOwnerId, targetUserId)
//     Records a pending offer. Current OWNER → target user.
//     Refuses if:
//       - the initiator is not the current OWNER of the tenant
//       - target is the same as the initiator
//       - target is not an active TenantMembership on this tenant
//       - a transfer is already pending (cancel + re-initiate to
//         change the target — keeps the offer trail honest)
//
//   accept(tenantId, accepterUserId)
//     Swaps roles atomically. Only the pending target can accept.
//     Refuses if no pending transfer or accepter ≠ pendingTarget.
//     In one $transaction:
//       - target's membership role: ADMIN/MEMBER/VIEWER → OWNER
//       - previous owner's membership role: OWNER → ADMIN
//       - Tenant.ownerUserId rotated to the new owner
//       - Pending columns cleared
//
//   cancel(tenantId, cancellerUserId)
//     Clears the pending columns. Either side (current OWNER or the
//     pending target) can cancel. Refuses if no pending transfer or
//     canceller is neither party.
//
// Every transition emits an AuditLog row via the caller (Server
// Action) so the chain is recoverable from /admin/audit-log.
//
// Pure functions on prisma; no UI / auth / email dependencies.

import type { PrismaClient } from "@prisma/client";

export class NotCurrentOwnerError extends Error {
  constructor() {
    super("Only the current OWNER can initiate an ownership transfer.");
    this.name = "NotCurrentOwnerError";
  }
}

export class SelfTransferError extends Error {
  constructor() {
    super("You can't transfer ownership to yourself — nothing would change.");
    this.name = "SelfTransferError";
  }
}

export class TargetNotMemberError extends Error {
  constructor() {
    super(
      "Ownership can only be transferred to an existing active member. " +
        "Invite the user first, then re-initiate the transfer."
    );
    this.name = "TargetNotMemberError";
  }
}

export class TransferAlreadyPendingError extends Error {
  constructor() {
    super(
      "Another ownership transfer is already pending. Cancel it before initiating a new one."
    );
    this.name = "TransferAlreadyPendingError";
  }
}

export class NoTransferPendingError extends Error {
  constructor() {
    super("No ownership transfer is pending on this tenant.");
    this.name = "NoTransferPendingError";
  }
}

export class NotTransferPartyError extends Error {
  constructor() {
    super(
      "Only the current OWNER or the pending recipient can act on this transfer."
    );
    this.name = "NotTransferPartyError";
  }
}

// ─── initiate ──────────────────────────────────────────────────────────────

export interface InitiateOwnerTransferInput {
  tenantId: string;
  /** The user attempting to initiate. Must match Tenant.ownerUserId. */
  currentOwnerUserId: string;
  /** Target — must be an active member of this tenant; must not be the initiator. */
  targetUserId: string;
}

export interface InitiateOwnerTransferResult {
  tenantId: string;
  targetUserId: string;
  initiatedAt: Date;
}

export async function initiateOwnerTransfer(
  prisma: PrismaClient,
  input: InitiateOwnerTransferInput
): Promise<InitiateOwnerTransferResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: {
      id: true,
      ownerUserId: true,
      pendingOwnerTransferToUserId: true,
    },
  });
  if (!tenant) {
    // Treat unknown-tenant the same as "not the owner" — don't leak
    // existence to a caller that has no claim on it.
    throw new NotCurrentOwnerError();
  }
  if (tenant.ownerUserId !== input.currentOwnerUserId) {
    throw new NotCurrentOwnerError();
  }
  if (input.targetUserId === input.currentOwnerUserId) {
    throw new SelfTransferError();
  }
  if (tenant.pendingOwnerTransferToUserId) {
    throw new TransferAlreadyPendingError();
  }
  // No soft-delete on tenantMembership — rows are hard-deleted when a
  // member is removed. Presence is enough to prove active membership.
  const targetMembership = await prisma.tenantMembership.findFirst({
    where: {
      tenantId: input.tenantId,
      userId: input.targetUserId,
    },
    select: { id: true },
  });
  if (!targetMembership) {
    throw new TargetNotMemberError();
  }

  const initiatedAt = new Date();
  await prisma.tenant.update({
    where: { id: input.tenantId },
    data: {
      pendingOwnerTransferToUserId: input.targetUserId,
      pendingOwnerTransferInitiatedAt: initiatedAt,
    },
  });

  return {
    tenantId: input.tenantId,
    targetUserId: input.targetUserId,
    initiatedAt,
  };
}

// ─── accept ────────────────────────────────────────────────────────────────

export interface AcceptOwnerTransferInput {
  tenantId: string;
  /** The user accepting — must match Tenant.pendingOwnerTransferToUserId. */
  accepterUserId: string;
}

export interface AcceptOwnerTransferResult {
  tenantId: string;
  /** Previous owner — now demoted to ADMIN. */
  previousOwnerUserId: string;
  /** New owner — was the accepter. */
  newOwnerUserId: string;
}

export async function acceptOwnerTransfer(
  prisma: PrismaClient,
  input: AcceptOwnerTransferInput
): Promise<AcceptOwnerTransferResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: {
      id: true,
      ownerUserId: true,
      pendingOwnerTransferToUserId: true,
    },
  });
  if (!tenant || !tenant.pendingOwnerTransferToUserId) {
    throw new NoTransferPendingError();
  }
  if (tenant.pendingOwnerTransferToUserId !== input.accepterUserId) {
    // The accepter is signed in but not the pending recipient. Treat
    // it like "no pending" rather than leak the recipient's identity.
    throw new NoTransferPendingError();
  }

  const previousOwnerUserId = tenant.ownerUserId;
  const newOwnerUserId = input.accepterUserId;

  // Atomic swap: rotate roles + Tenant.ownerUserId + clear pending
  // columns in one transaction. If any step fails the rollback leaves
  // ownership consistent.
  await prisma.$transaction(async (tx) => {
    await tx.tenantMembership.updateMany({
      where: { tenantId: input.tenantId, userId: newOwnerUserId },
      data: { role: "OWNER" },
    });
    await tx.tenantMembership.updateMany({
      where: { tenantId: input.tenantId, userId: previousOwnerUserId },
      data: { role: "ADMIN" },
    });
    await tx.tenant.update({
      where: { id: input.tenantId },
      data: {
        ownerUserId: newOwnerUserId,
        pendingOwnerTransferToUserId: null,
        pendingOwnerTransferInitiatedAt: null,
      },
    });
  });

  return {
    tenantId: input.tenantId,
    previousOwnerUserId,
    newOwnerUserId,
  };
}

// ─── cancel ────────────────────────────────────────────────────────────────

export interface CancelOwnerTransferInput {
  tenantId: string;
  /** Must be the current OWNER or the pending target. */
  cancellerUserId: string;
}

export interface CancelOwnerTransferResult {
  tenantId: string;
  /** Who clicked the cancel button — OWNER or pending TARGET. */
  cancelledBy: "OWNER" | "TARGET";
}

export async function cancelOwnerTransfer(
  prisma: PrismaClient,
  input: CancelOwnerTransferInput
): Promise<CancelOwnerTransferResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: {
      id: true,
      ownerUserId: true,
      pendingOwnerTransferToUserId: true,
    },
  });
  if (!tenant || !tenant.pendingOwnerTransferToUserId) {
    throw new NoTransferPendingError();
  }
  const isOwner = tenant.ownerUserId === input.cancellerUserId;
  const isTarget =
    tenant.pendingOwnerTransferToUserId === input.cancellerUserId;
  if (!isOwner && !isTarget) {
    throw new NotTransferPartyError();
  }

  await prisma.tenant.update({
    where: { id: input.tenantId },
    data: {
      pendingOwnerTransferToUserId: null,
      pendingOwnerTransferInitiatedAt: null,
    },
  });

  return {
    tenantId: input.tenantId,
    cancelledBy: isOwner ? "OWNER" : "TARGET",
  };
}
