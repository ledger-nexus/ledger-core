"use server";

// Maker-checker Server Actions: approve / reject a PENDING_APPROVAL
// journal entry. Both require ADMIN+ in the current tenant via the
// policy module. The lifecycle module enforces the substantive
// guarantees (status check, separation of duties, period-close
// re-check).
//
// Audit: every approve/reject emits auditPrivilegedAction so the
// audit-log page captures the maker-checker chain (SOC 2 CC4 / CC6).

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
import { canApproveJournalEntries, PermissionDeniedError } from "@/lib/auth/policy";
import {
  approveJournalEntry,
  rejectJournalEntry,
  withdrawJournalEntry,
  EntryNotPendingError,
  SelfApprovalError,
  NotSubmitterError,
  RejectionReasonRequiredError,
} from "@/lib/accounting/approval";
import { PeriodClosedError } from "@/lib/accounting/types";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { sendJeApprovedEmail } from "@/lib/email/templates/je-approved";
import { sendJeRejectedEmail } from "@/lib/email/templates/je-rejected";
import { sanitizeActionError } from "@/lib/actions/action-error";
import { requirePermitted } from "@/lib/auth/authorize";

export interface ApprovalActionState {
  ok: boolean;
  message?: string;
}

// ─── approveJournalEntryAction ─────────────────────────────────────────────

export interface ApproveInput {
  entryId: string;
}

export async function approveJournalEntryAction(
  input: ApproveInput
): Promise<ApprovalActionState> {
  try {
    const { user, tenant } = await requirePermitted(
      "approve_journal_entries",
      canApproveJournalEntries
    );

    const result = await approveJournalEntry(prisma, {
      entryId: input.entryId,
      tenantId: tenant.id,
      approverUserId: user.id,
      approverEmail: user.email,
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "journal_entry.approve",
      resource: "JournalEntry",
      resourceId: result.entryId,
      metadata: {
        entryNumber: result.entryNumber,
        transition: `${result.previousStatus} -> ${result.newStatus}`,
      },
    });

    // Notify the submitter. Failure-isolated — a Resend outage or
    // missing env doesn't break the approval flow. The email helper
    // already swallows its own errors; we just await it before
    // revalidating so the EmailDelivery row lands first.
    await notifySubmitter(result.entryId, tenant.id, "approved", user.displayName);

    revalidatePath("/journal-entries");
    revalidatePath("/journal-entries/pending");
    revalidatePath(`/journal-entries/${result.entryId}`);

    return {
      ok: true,
      message: `Approved ${result.entryNumber}. The entry is now POSTED.`,
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── rejectJournalEntryAction ──────────────────────────────────────────────

export interface RejectInput {
  entryId: string;
  reason: string;
}

export async function rejectJournalEntryAction(
  input: RejectInput
): Promise<ApprovalActionState> {
  try {
    const { user, tenant } = await requirePermitted(
      "approve_journal_entries",
      canApproveJournalEntries
    );

    const result = await rejectJournalEntry(prisma, {
      entryId: input.entryId,
      tenantId: tenant.id,
      rejectorUserId: user.id,
      rejectorEmail: user.email,
      reason: input.reason,
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "journal_entry.reject",
      resource: "JournalEntry",
      resourceId: result.entryId,
      metadata: {
        entryNumber: result.entryNumber,
        reason: input.reason,
      },
    });

    await notifySubmitter(
      result.entryId,
      tenant.id,
      "rejected",
      user.displayName,
      input.reason
    );

    revalidatePath("/journal-entries");
    revalidatePath("/journal-entries/pending");
    revalidatePath(`/journal-entries/${result.entryId}`);

    return {
      ok: true,
      message: `Rejected ${result.entryNumber}. The submitter has been emailed.`,
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── withdrawJournalEntryAction ────────────────────────────────────────────
//
// The submitter cancels their own pending submission. Distinct from
// reject: no admin involvement, no separation-of-duties block, no
// notification email (the actor is the would-be recipient).
//
// Permission gate is just "signed in to a tenant" — the lifecycle
// module's `submittedById === withdrawerUserId` check is the real
// guardrail. Any tenant member can withdraw their own submission;
// they could not have submitted it in the first place without the
// requisite permission, so we don't re-check here.

export interface WithdrawInput {
  entryId: string;
  /** Optional free-text reason ("wrong period", "found a typo", etc.). */
  reason?: string;
}

export async function withdrawJournalEntryAction(
  input: WithdrawInput
): Promise<ApprovalActionState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const result = await withdrawJournalEntry(prisma, {
      entryId: input.entryId,
      tenantId: tenant.id,
      withdrawerUserId: user.id,
      withdrawerEmail: user.email,
      reason: input.reason,
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "journal_entry.withdraw",
      resource: "JournalEntry",
      resourceId: result.entryId,
      metadata: {
        entryNumber: result.entryNumber,
        reason: input.reason ?? null,
      },
    });

    revalidatePath("/journal-entries");
    revalidatePath("/journal-entries/pending");
    revalidatePath(`/journal-entries/${result.entryId}`);

    return {
      ok: true,
      message: `Withdrew ${result.entryNumber}. It will not be approved.`,
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── Submitter notification ────────────────────────────────────────────────
//
// Fetches the entry + submitter + tenant info needed for the email
// template, then fires the right template. Wrapped in try/catch so a
// missing submitter, missing tenant, or email-send failure never breaks
// the approve/reject action (the lifecycle has already committed).
async function notifySubmitter(
  entryId: string,
  tenantId: string,
  outcome: "approved" | "rejected",
  actorName: string,
  rejectionReason?: string
): Promise<void> {
  try {
    const entry = await prisma.journalEntry.findFirst({
      where: { id: entryId, tenantId },
      select: {
        entryNumber: true,
        memo: true,
        submittedById: true,
        tenant: { select: { name: true } },
      },
    });
    if (!entry) return; // shouldn't happen — we just operated on it
    if (!entry.submittedById) return; // no submitter to notify (direct admin post)

    const submitter = await prisma.user.findUnique({
      where: { id: entry.submittedById },
      select: { email: true, displayName: true, isActive: true },
    });
    if (!submitter || !submitter.isActive) return;

    const baseUrl = process.env.APP_BASE_URL || "";
    const entryUrl = `${baseUrl}/journal-entries/${entryId}`;

    if (outcome === "approved") {
      await sendJeApprovedEmail({
        to: submitter.email,
        recipientName: submitter.displayName,
        approverName: actorName,
        entryNumber: entry.entryNumber,
        tenantName: entry.tenant.name,
        memo: entry.memo,
        entryUrl,
        tenantId,
        entryId,
      });
    } else {
      await sendJeRejectedEmail({
        to: submitter.email,
        recipientName: submitter.displayName,
        rejectorName: actorName,
        entryNumber: entry.entryNumber,
        tenantName: entry.tenant.name,
        memo: entry.memo,
        reason: rejectionReason ?? "(no reason recorded)",
        entryUrl,
        tenantId,
        entryId,
      });
    }
  } catch (e) {
    console.error("[je-approval] submitter notification failed:", e);
  }
}

// ─── Error mapping ─────────────────────────────────────────────────────────

function mapError(e: unknown): ApprovalActionState {
  if (e instanceof NotAuthenticatedError)
    return { ok: false, message: "You must be signed in." };
  if (e instanceof NoTenantSelectedError)
    return { ok: false, message: e.message };
  if (e instanceof PermissionDeniedError)
    return { ok: false, message: e.message };
  if (e instanceof EntryNotPendingError)
    return { ok: false, message: e.message };
  if (e instanceof SelfApprovalError)
    return { ok: false, message: e.message };
  if (e instanceof NotSubmitterError)
    return { ok: false, message: e.message };
  if (e instanceof RejectionReasonRequiredError)
    return { ok: false, message: e.message };
  if (e instanceof PeriodClosedError)
    return { ok: false, message: e.message };
  return {
    ok: false,
    message: sanitizeActionError(e, "Unknown error"),
  };
}
