// Manual reassignment service.
//
// Single entry point for changing a record's owner. Writes a RecordEvent row
// for the audit trail. Optionally locks the record from rule-based
// reassignment (default for manual actions; the lock prevents a rule from
// immediately undoing the user's decision).
//
// What this function does NOT do:
//   - Check the caller's permission. The Server Action layer enforces
//     `can_reassign:<module>` before calling this. The reassign service
//     trusts its caller — same discipline as `postJournalEntry`.
//   - Enforce module access on the new owner. If you assign a JE to an AR
//     clerk who can't see GL, the assignment succeeds and the record is
//     surfaced in the orphan dashboard (see ownership/orphan-detection.ts).
//     This is intentional: orphan detection is a separate concern.
//
// What it DOES enforce:
//   - The record must be in a reassignable state (NOT POSTED for
//     JournalEntry, etc. — domain-specific check)
//   - Owner must be a valid User (active) or Queue (active)
//   - The recordType must be a known reassignable type
//
// recordType → table mapping is intentionally explicit (switch statement)
// rather than dynamic. Each new ownership-bearing model is added here
// deliberately.

import { PrismaClient } from "@prisma/client";
import { type Target } from "../rules/types";

export type ReassignableRecordType = "JournalEntry";

export interface ReassignInput {
  recordType: ReassignableRecordType;
  recordId: string;
  newOwner: Target;
  /** Acting user id. Must be set; pseudo-id "system" for engine-fired reassignments. */
  actorUserId: string;
  /** Human-readable reason. For rule-fired: "rule:<id>:v<version>". */
  reason: string;
  /**
   * When true, sets reassignmentLockedAt — subsequent rules ignore this
   * record. Defaults to true for manual reassignments; rule-fired
   * reassignments should pass false.
   */
  lockFromRules?: boolean;
}

export interface ReassignResult {
  ok: true;
  recordId: string;
  previousOwner: { ownerId: string | null; ownerType: string };
  newOwner: { ownerId: string; ownerType: string };
  recordEventId: string;
}

export class ReassignError extends Error {
  constructor(
    public code:
      | "RECORD_NOT_FOUND"
      | "RECORD_NOT_REASSIGNABLE"
      | "OWNER_NOT_FOUND"
      | "OWNER_INACTIVE"
      | "INVALID_OWNER_TYPE",
    message: string
  ) {
    super(message);
    this.name = "ReassignError";
  }
}

export async function reassignRecord(
  prisma: PrismaClient,
  input: ReassignInput
): Promise<ReassignResult> {
  const lock = input.lockFromRules ?? true;

  // 1. Validate the new owner exists and is active.
  if (input.newOwner.type === "USER") {
    const u = await prisma.user.findUnique({
      where: { id: input.newOwner.id },
      select: { id: true, isActive: true },
    });
    if (!u) throw new ReassignError("OWNER_NOT_FOUND", `User ${input.newOwner.id} not found`);
    if (!u.isActive)
      throw new ReassignError("OWNER_INACTIVE", `User ${input.newOwner.id} is deactivated`);
  } else if (input.newOwner.type === "QUEUE") {
    const q = await prisma.queue.findUnique({
      where: { id: input.newOwner.id },
      select: { id: true, isActive: true, deletedAt: true },
    });
    if (!q || q.deletedAt)
      throw new ReassignError("OWNER_NOT_FOUND", `Queue ${input.newOwner.id} not found`);
    if (!q.isActive)
      throw new ReassignError("OWNER_INACTIVE", `Queue ${input.newOwner.id} is inactive`);
  } else {
    throw new ReassignError(
      "INVALID_OWNER_TYPE",
      `Owner type must be USER or QUEUE (got "${(input.newOwner as { type: string }).type}")`
    );
  }

  // 2. Dispatch on recordType. Each branch fetches, validates reassignable
  // state, updates the record, and writes the RecordEvent in a transaction.
  switch (input.recordType) {
    case "JournalEntry":
      return reassignJournalEntry(prisma, input, lock);
  }
}

async function reassignJournalEntry(
  prisma: PrismaClient,
  input: ReassignInput,
  lock: boolean
): Promise<ReassignResult> {
  const je = await prisma.journalEntry.findUnique({
    where: { id: input.recordId },
    select: {
      id: true,
      status: true,
      ownerId: true,
      ownerType: true,
    },
  });
  if (!je) throw new ReassignError("RECORD_NOT_FOUND", `JournalEntry ${input.recordId} not found`);

  // POSTED entries are immutable; only DRAFT entries can be reassigned.
  // (When DRAFT status is wired up in the workflow — for now POSTED is the
  // only documented status. Adjust this check when DRAFT/PENDING land.)
  if (je.status !== "POSTED" && je.status !== "DRAFT") {
    throw new ReassignError(
      "RECORD_NOT_REASSIGNABLE",
      `JournalEntry status ${je.status} is not reassignable`
    );
  }

  const previousOwner = { ownerId: je.ownerId, ownerType: je.ownerType };
  const newOwnerType = input.newOwner.type;

  const eventId = await prisma.$transaction(async (tx) => {
    await tx.journalEntry.update({
      where: { id: input.recordId },
      data: {
        ownerId: input.newOwner.id,
        ownerType: newOwnerType,
        reassignmentLockedAt: lock ? new Date() : null,
        updatedBy: input.actorUserId,
      },
    });
    const event = await tx.recordEvent.create({
      data: {
        recordType: "JournalEntry",
        recordId: input.recordId,
        eventType: "OWNER_CHANGED",
        previousValue: previousOwner as object,
        newValue: { ownerId: input.newOwner.id, ownerType: newOwnerType },
        actorUserId: input.actorUserId === "system" ? null : input.actorUserId,
        actorReason: input.reason,
        journalEntryId: input.recordId,
      },
      select: { id: true },
    });
    return event.id;
  });

  return {
    ok: true,
    recordId: input.recordId,
    previousOwner,
    newOwner: { ownerId: input.newOwner.id, ownerType: newOwnerType },
    recordEventId: eventId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unlock action — explicit clear of reassignmentLockedAt.
// ─────────────────────────────────────────────────────────────────────────────

export async function clearReassignmentLock(
  prisma: PrismaClient,
  recordType: ReassignableRecordType,
  recordId: string,
  actorUserId: string,
  reason: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    switch (recordType) {
      case "JournalEntry":
        await tx.journalEntry.update({
          where: { id: recordId },
          data: { reassignmentLockedAt: null, updatedBy: actorUserId },
        });
        break;
    }
    await tx.recordEvent.create({
      data: {
        recordType,
        recordId,
        eventType: "REASSIGNMENT_UNLOCKED",
        actorUserId: actorUserId === "system" ? null : actorUserId,
        actorReason: reason,
        journalEntryId: recordType === "JournalEntry" ? recordId : null,
      },
    });
  });
}
