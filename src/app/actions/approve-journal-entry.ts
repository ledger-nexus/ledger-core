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
import {
  canApproveJournalEntries,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";
import {
  approveJournalEntry,
  rejectJournalEntry,
  EntryNotPendingError,
  SelfApprovalError,
  RejectionReasonRequiredError,
} from "@/lib/accounting/approval";
import { PeriodClosedError } from "@/lib/accounting/types";
import { auditPrivilegedAction } from "@/lib/audit/log";

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
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission(
      "approve_journal_entries",
      tenant.role,
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
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission(
      "approve_journal_entries",
      tenant.role,
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

    revalidatePath("/journal-entries");
    revalidatePath("/journal-entries/pending");
    revalidatePath(`/journal-entries/${result.entryId}`);

    return {
      ok: true,
      message: `Rejected ${result.entryNumber}. The submitter sees the reason on the entry detail page.`,
    };
  } catch (e) {
    return mapError(e);
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
  if (e instanceof RejectionReasonRequiredError)
    return { ok: false, message: e.message };
  if (e instanceof PeriodClosedError)
    return { ok: false, message: e.message };
  return {
    ok: false,
    message: e instanceof Error ? e.message : "Unknown error",
  };
}
