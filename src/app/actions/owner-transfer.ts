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
import { notify } from "@/lib/notifications";
import { redactPii } from "@/lib/soc2";
import { sendOwnerTransferOfferedEmail } from "@/lib/email/templates/owner-transfer-offered";
import { sendOwnerTransferAcceptedEmail } from "@/lib/email/templates/owner-transfer-accepted";
import { sendOwnerTransferCancelledEmail } from "@/lib/email/templates/owner-transfer-cancelled";

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

    // Notify the target so they don't have to navigate to /admin/team
    // unprompted. Failure-isolated — the action succeeds even if the
    // bell or the mailer doesn't ring.
    await safeNotify({
      recipient: { type: "USER", id: result.targetUserId },
      category: "SYSTEM",
      title: `${user.displayName} offered to transfer ownership of ${tenant.name} to you`,
      body: "Visit Team admin to accept or decline.",
      link: "/admin/team",
      actorUserId: user.id,
      recordType: "Tenant",
      recordId: tenant.id,
      tenantId: tenant.id,
    });
    await safeEmailTargetOnInitiate({
      tenantId: tenant.id,
      tenantName: tenant.name,
      targetUserId: result.targetUserId,
      initiatorName: user.displayName,
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

    // Notify the previous OWNER that the swap completed and they are
    // now ADMIN.
    await safeNotify({
      recipient: { type: "USER", id: result.previousOwnerUserId },
      category: "SYSTEM",
      title: `${user.displayName} accepted ownership of ${tenant.name}`,
      body: "You are now an ADMIN on this workspace.",
      link: "/admin/team",
      actorUserId: user.id,
      recordType: "Tenant",
      recordId: tenant.id,
      tenantId: tenant.id,
    });
    await safeEmailPreviousOwnerOnAccept({
      tenantId: tenant.id,
      tenantName: tenant.name,
      previousOwnerUserId: result.previousOwnerUserId,
      accepterName: user.displayName,
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

    // Notify the OTHER party so they know the offer is gone.
    // OWNER cancelled → recipient sees the transfer disappear.
    // TARGET declined → OWNER sees the decline.
    await safeNotify({
      recipient: { type: "USER", id: result.otherPartyUserId },
      category: "SYSTEM",
      title:
        result.cancelledBy === "OWNER"
          ? `${user.displayName} cancelled the ownership transfer of ${tenant.name}`
          : `${user.displayName} declined the ownership transfer of ${tenant.name}`,
      link: "/admin/team",
      actorUserId: user.id,
      recordType: "Tenant",
      recordId: tenant.id,
      tenantId: tenant.id,
    });
    await safeEmailOtherPartyOnCancel({
      tenantId: tenant.id,
      tenantName: tenant.name,
      otherPartyUserId: result.otherPartyUserId,
      cancellerName: user.displayName,
      cancelledBy: result.cancelledBy,
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

// ─── Notification helper ──────────────────────────────────────────────────
//
// Wraps notify() in try/catch — owner-transfer should never roll back
// because the bell didn't ring. Log + continue mirrors the
// reassign-notification + je-approval-notification pattern.

async function safeNotify(
  input: Parameters<typeof notify>[1]
): Promise<void> {
  try {
    await notify(prisma, input);
  } catch (e) {
    console.error("[owner-transfer] notification emit failed:", e);
  }
}

// ─── Email helpers ─────────────────────────────────────────────────────────
//
// Each helper resolves the recipient's email + display name, builds the
// /admin/team URL, and fires the matching template via sendEmail. Failure-
// isolated mirrors the bell-icon notify pattern: the lifecycle already
// committed; the user just doesn't get an email if the mailer is down
// or the recipient was deactivated between transitions.

function teamUrl(): string {
  const base = process.env.APP_BASE_URL || "";
  return `${base}/admin/team`;
}

async function loadRecipient(
  userId: string
): Promise<{ email: string; displayName: string } | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true, isActive: true },
  });
  if (!u || !u.isActive) return null;
  return { email: u.email, displayName: u.displayName };
}

async function safeEmailTargetOnInitiate(args: {
  tenantId: string;
  tenantName: string;
  targetUserId: string;
  initiatorName: string;
}): Promise<void> {
  try {
    const recipient = await loadRecipient(args.targetUserId);
    if (!recipient) return;
    await sendOwnerTransferOfferedEmail({
      to: recipient.email,
      recipientName: recipient.displayName,
      initiatorName: args.initiatorName,
      tenantName: args.tenantName,
      teamUrl: teamUrl(),
      tenantId: args.tenantId,
    });
  } catch (e) {
    // Provider/DB errors can echo the recipient address — redact
    // before logging (Confidentiality TSC).
    console.error("[owner-transfer] email-on-initiate failed:", redactPii(e));
  }
}

async function safeEmailPreviousOwnerOnAccept(args: {
  tenantId: string;
  tenantName: string;
  previousOwnerUserId: string;
  accepterName: string;
}): Promise<void> {
  try {
    const recipient = await loadRecipient(args.previousOwnerUserId);
    if (!recipient) return;
    await sendOwnerTransferAcceptedEmail({
      to: recipient.email,
      recipientName: recipient.displayName,
      accepterName: args.accepterName,
      tenantName: args.tenantName,
      teamUrl: teamUrl(),
      tenantId: args.tenantId,
    });
  } catch (e) {
    // Provider/DB errors can echo the recipient address — redact
    // before logging (Confidentiality TSC).
    console.error("[owner-transfer] email-on-accept failed:", redactPii(e));
  }
}

async function safeEmailOtherPartyOnCancel(args: {
  tenantId: string;
  tenantName: string;
  otherPartyUserId: string;
  cancellerName: string;
  cancelledBy: "OWNER" | "TARGET";
}): Promise<void> {
  try {
    const recipient = await loadRecipient(args.otherPartyUserId);
    if (!recipient) return;
    await sendOwnerTransferCancelledEmail({
      to: recipient.email,
      recipientName: recipient.displayName,
      cancellerName: args.cancellerName,
      cancelledBy: args.cancelledBy,
      tenantName: args.tenantName,
      teamUrl: teamUrl(),
      tenantId: args.tenantId,
    });
  } catch (e) {
    // Provider/DB errors can echo the recipient address — redact
    // before logging (Confidentiality TSC).
    console.error("[owner-transfer] email-on-cancel failed:", redactPii(e));
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
