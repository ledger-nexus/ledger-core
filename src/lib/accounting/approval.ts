// Maker-checker approval lifecycle for journal entries.
//
// Three transitions:
//
//   approveJournalEntry  — PENDING_APPROVAL -> POSTED
//                          Refuses if the period has closed since submit,
//                          if the approver is the submitter (separation
//                          of duties), or if the entry is in any state
//                          other than PENDING_APPROVAL.
//
//   rejectJournalEntry   — PENDING_APPROVAL -> VOID (with reason)
//                          Same separation-of-duties guard.
//
//   resubmitJournalEntry — VOID (rejected) -> PENDING_APPROVAL
//                          Lets the submitter retry after rejection.
//                          (Not yet wired into the UI — exposed here for
//                          future use.)
//
// Each transition writes a RecordEvent so /admin/audit-log + the
// per-JE history surface the full chain. Direct postings by an ADMIN
// (bypassing the queue) are unaffected.
//
// The post itself happens at SUBMIT time via postJournalEntry with
// initialStatus="PENDING_APPROVAL" — the entry's lines exist + balance
// is validated up front. APPROVE just flips the status flag and re-runs
// the period-close check (in case the period closed while pending).

import type { PrismaClient } from "@prisma/client";
import { PeriodClosedError } from "./types";
import { fireInsertRules } from "../rules/integration";

export class EntryNotPendingError extends Error {
  constructor(public readonly entryId: string, public readonly currentStatus: string) {
    super(`Entry ${entryId} is ${currentStatus}, not PENDING_APPROVAL`);
    this.name = "EntryNotPendingError";
  }
}

export class SelfApprovalError extends Error {
  constructor(public readonly entryId: string) {
    super(
      `Cannot approve your own submission. The maker-checker workflow requires a second pair of eyes on every entry.`
    );
    this.name = "SelfApprovalError";
  }
}

export class RejectionReasonRequiredError extends Error {
  constructor() {
    super("A rejection reason is required so the submitter knows what to fix.");
    this.name = "RejectionReasonRequiredError";
  }
}

export interface ApproveJournalEntryInput {
  /** Entry to approve. Must currently be PENDING_APPROVAL. */
  entryId: string;
  /** Tenant scope check — the entry's tenantId must equal this. */
  tenantId: string;
  /** Approver. Must NOT be the submitter (self-approval refused). */
  approverUserId: string;
  approverEmail: string;
}

export interface ApproveJournalEntryResult {
  entryId: string;
  entryNumber: string;
  previousStatus: "PENDING_APPROVAL";
  newStatus: "POSTED";
}

export async function approveJournalEntry(
  prisma: PrismaClient,
  input: ApproveJournalEntryInput
): Promise<ApproveJournalEntryResult> {
  // 1. Fetch the entry + tenant-scope check + status check.
  const entry = await prisma.journalEntry.findFirst({
    where: { id: input.entryId, tenantId: input.tenantId },
    select: {
      id: true,
      entryNumber: true,
      status: true,
      submittedById: true,
      entityId: true,
      bookId: true,
      periodId: true,
      ownerId: true,
      memo: true,
      source: true,
      documentDate: true,
      postingDate: true,
      currencyId: true,
      ownerType: true,
      reassignmentLockedAt: true,
      createdBy: true,
      entity: { select: { code: true } },
      book: { select: { code: true } },
    },
  });
  if (!entry) {
    throw new EntryNotPendingError(input.entryId, "not-found");
  }
  if (entry.status !== "PENDING_APPROVAL") {
    throw new EntryNotPendingError(input.entryId, entry.status);
  }

  // 2. Separation of duties: submitter ≠ approver.
  if (entry.submittedById === input.approverUserId) {
    throw new SelfApprovalError(input.entryId);
  }

  // 3. Re-run the period close check. Since submit, the period may
  //    have been closed. If so, refuse — the approver needs to either
  //    move the entry's date or void it and resubmit on the right date.
  if (entry.periodId) {
    const closed = await prisma.periodClose.findUnique({
      where: {
        entityId_bookId_periodId: {
          entityId: entry.entityId,
          bookId: entry.bookId,
          periodId: entry.periodId,
        },
      },
      select: { id: true },
    });
    if (closed) {
      throw new PeriodClosedError(
        entry.entity.code,
        entry.book.code,
        "(period closed since submit)"
      );
    }
  }

  // 4. Flip status atomically + write RecordEvent. One transaction
  //    so a crash mid-flow doesn't leave the entry half-approved.
  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.update({
      where: { id: entry.id },
      data: {
        status: "POSTED",
        approvedById: input.approverUserId,
        approvedAt: new Date(),
        updatedBy: input.approverEmail,
      },
    });
    await tx.recordEvent.create({
      data: {
        tenantId: input.tenantId,
        recordType: "JournalEntry",
        recordId: entry.id,
        eventType: "STATE_CHANGED",
        previousValue: { status: "PENDING_APPROVAL" },
        newValue: { status: "POSTED" },
        actorUserId: input.approverUserId,
        actorReason: "maker-checker: approved",
      },
    });
  });

  // 5. Fire ON_INSERT rules now that the entry is officially live.
  //    These were intentionally skipped at submit time (see post-journal.ts).
  //    Non-fatal — log + continue on failure.
  if (entry.ownerId) {
    try {
      await fireInsertRules(
        prisma,
        "JournalEntry",
        entry.id,
        {
          ...entry,
          bookCode: entry.book.code,
          entityCode: entry.entity.code,
          status: "POSTED",
        } as unknown as Record<string, unknown>,
        entry.ownerId
      );
    } catch (e) {
      console.error(
        `JE ${entry.entryNumber} approved but ON_INSERT rules failed:`,
        e
      );
    }
  }

  return {
    entryId: entry.id,
    entryNumber: entry.entryNumber,
    previousStatus: "PENDING_APPROVAL",
    newStatus: "POSTED",
  };
}

export interface RejectJournalEntryInput {
  entryId: string;
  tenantId: string;
  rejectorUserId: string;
  rejectorEmail: string;
  reason: string;
}

export interface RejectJournalEntryResult {
  entryId: string;
  entryNumber: string;
  previousStatus: "PENDING_APPROVAL";
  newStatus: "VOID";
}

export async function rejectJournalEntry(
  prisma: PrismaClient,
  input: RejectJournalEntryInput
): Promise<RejectJournalEntryResult> {
  const reason = input.reason?.trim() ?? "";
  if (!reason) {
    throw new RejectionReasonRequiredError();
  }

  const entry = await prisma.journalEntry.findFirst({
    where: { id: input.entryId, tenantId: input.tenantId },
    select: {
      id: true,
      entryNumber: true,
      status: true,
      submittedById: true,
    },
  });
  if (!entry) {
    throw new EntryNotPendingError(input.entryId, "not-found");
  }
  if (entry.status !== "PENDING_APPROVAL") {
    throw new EntryNotPendingError(input.entryId, entry.status);
  }
  if (entry.submittedById === input.rejectorUserId) {
    // Same separation-of-duties guard: don't let the submitter reject
    // their own entry. They should use the (future) "withdraw" flow.
    // Today, withdrawing your own pending entry isn't supported — ask
    // another admin to reject it.
    throw new SelfApprovalError(input.entryId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.update({
      where: { id: entry.id },
      data: {
        status: "VOID",
        rejectedById: input.rejectorUserId,
        rejectedAt: new Date(),
        rejectionReason: reason,
        updatedBy: input.rejectorEmail,
      },
    });
    await tx.recordEvent.create({
      data: {
        tenantId: input.tenantId,
        recordType: "JournalEntry",
        recordId: entry.id,
        eventType: "STATE_CHANGED",
        previousValue: { status: "PENDING_APPROVAL" },
        newValue: { status: "VOID", reason },
        actorUserId: input.rejectorUserId,
        actorReason: `maker-checker: rejected — ${reason}`,
      },
    });
  });

  return {
    entryId: entry.id,
    entryNumber: entry.entryNumber,
    previousStatus: "PENDING_APPROVAL",
    newStatus: "VOID",
  };
}
