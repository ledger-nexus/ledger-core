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

import type { Prisma, PrismaClient } from "@prisma/client";
import { type Target } from "../rules/types";
import { notify, type NotificationCategory } from "../notifications";

export type ReassignableRecordType = "JournalEntry" | "ArOpenItem" | "ApOpenItem";

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
  /**
   * When true, skip emitting a Notification for this reassignment.
   * Used for bulk operations (user deactivation reassignments) where
   * flooding the new owner's inbox would be hostile. Default false.
   */
  silent?: boolean;
  /**
   * SECURITY: the actor's tenantId. When provided, the record lookup is
   * scoped to this tenant — a cross-tenant id returns "not found"
   * instead of letting the actor reassign someone else's record. Server
   * Action callers MUST pass this from requireCurrentTenant().
   * Engine-fired reassignments (rules-engine paths) can omit it since
   * they're already operating on a scoped record set.
   */
  actorTenantId?: string;
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

/**
 * Inner half of reassignRecord — runs inside an existing transaction.
 * RLS Phase 2b Class T pattern (see docs/architecture/rls-phase-2b-
 * migration-guide.md). All reads + writes for the reassignment (owner
 * validation + record update + RecordEvent create) run on the supplied
 * tx so the SET LOCAL app.current_tenant_id GUC propagates.
 *
 * Notification emit is INTENTIONALLY excluded from this inner half — it
 * stays in the outer wrapper as a non-fatal side effect. A failed
 * notification must not roll back a successful reassignment (existing
 * contract per the original implementation).
 */
export async function reassignRecordInTx(
  tx: Prisma.TransactionClient,
  input: ReassignInput
): Promise<ReassignResult> {
  const lock = input.lockFromRules ?? true;

  // 1. Validate the new owner exists and is active.
  if (input.newOwner.type === "USER") {
    const u = await tx.user.findUnique({
      where: { id: input.newOwner.id },
      select: { id: true, isActive: true },
    });
    if (!u) throw new ReassignError("OWNER_NOT_FOUND", `User ${input.newOwner.id} not found`);
    if (!u.isActive)
      throw new ReassignError("OWNER_INACTIVE", `User ${input.newOwner.id} is deactivated`);
  } else if (input.newOwner.type === "QUEUE") {
    const q = await tx.queue.findUnique({
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
  // state, updates the record, and writes the RecordEvent — all in the
  // supplied tx (no nested $transaction).
  switch (input.recordType) {
    case "JournalEntry":
      return reassignJournalEntryInTx(tx, input, lock);
    case "ArOpenItem":
      return reassignArOpenItemInTx(tx, input, lock);
    case "ApOpenItem":
      return reassignApOpenItemInTx(tx, input, lock);
  }
}

/**
 * Outer wrapper — opens its own $transaction and delegates to the inner.
 * Preserved for legacy callers (seeds, internal scripts, rules-engine
 * paths that don't yet run inside withTenantContext). New Server Actions
 * should call reassignRecordInTx directly from within their
 * withTenantContext block, then run emitReassignmentNotification
 * after the tx returns (preserving the non-fatal-notification contract).
 */
export async function reassignRecord(
  prisma: PrismaClient,
  input: ReassignInput
): Promise<ReassignResult> {
  const result = await prisma.$transaction((tx) => reassignRecordInTx(tx, input));

  // Emit a Notification to the new owner (unless silent OR the new owner
  // IS the actor — notify-self filtering is also done inside notify()).
  // Failures are non-fatal: the reassignment succeeded; only the bell
  // doesn't ring. Log and continue.
  if (!input.silent) {
    try {
      await emitReassignmentNotification(prisma, input);
    } catch (e) {
      console.warn(
        `Reassignment of ${input.recordType} ${input.recordId.slice(0, 8)} succeeded but notification emit failed:`,
        e
      );
    }
  }

  return result;
}

/**
 * Emit the post-reassignment notification. Exported so RLS Phase 2b
 * Server Actions can call this AFTER the withTenantContext tx returns
 * — preserving the original contract that a failed notification must
 * not roll back a successful reassignment.
 */
export async function emitReassignmentNotification(
  prisma: PrismaClient,
  input: ReassignInput
): Promise<void> {
  const recordRef = recordLabelFor(input.recordType, input.recordId);
  const link = recordLinkFor(input.recordType, input.recordId);
  const category: NotificationCategory = "REASSIGNMENT";

  // Reason format from earlier conventions:
  //   "manual:<freeform>"
  //   "rule:<rule-id>:v<version>"
  //   "lifecycle:user-deactivation by Carla Controller"
  //   "admin:orphan repair by Carla Controller"
  const isRuleFired = input.reason.startsWith("rule:");
  const sourceRuleId = isRuleFired
    ? input.reason.split(":")[1] // "rule:<id>:v<ver>" → "<id>"
    : undefined;

  const title = isRuleFired
    ? `${recordRef} routed to your queue`
    : `${recordRef} assigned to you`;

  const body = isRuleFired
    ? `Reassignment rule ${sourceRuleId} fired on insert`
    : input.reason.length > 80
      ? `${input.reason.slice(0, 80)}…`
      : input.reason;

  await notify(prisma, {
    recipient: { type: input.newOwner.type, id: input.newOwner.id },
    category,
    title,
    body,
    link,
    sourceRuleId,
    actorUserId: input.actorUserId === "system" ? undefined : input.actorUserId,
    recordType: input.recordType,
    recordId: input.recordId,
  });
}

function recordLabelFor(recordType: ReassignableRecordType, id: string): string {
  // Short, human-readable. The bell dropdown shows this verbatim.
  switch (recordType) {
    case "JournalEntry":
      return `JE ${id.slice(0, 8)}`;
    case "ArOpenItem":
      return `AR item ${id.slice(0, 8)}`;
    case "ApOpenItem":
      return `AP item ${id.slice(0, 8)}`;
  }
}

function recordLinkFor(recordType: ReassignableRecordType, id: string): string {
  switch (recordType) {
    case "JournalEntry":
      return `/journal-entries/${id}`;
    case "ArOpenItem":
      return `/ar`;
    case "ApOpenItem":
      return `/ap`;
  }
}

async function reassignJournalEntryInTx(
  tx: Prisma.TransactionClient,
  input: ReassignInput,
  lock: boolean
): Promise<ReassignResult> {
  const je = await tx.journalEntry.findFirst({
    where: {
      id: input.recordId,
      ...(input.actorTenantId ? { tenantId: input.actorTenantId } : {}),
    },
    select: {
      id: true,
      status: true,
      ownerId: true,
      ownerType: true,
      tenantId: true,
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
      tenantId: je.tenantId,
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

  return {
    ok: true,
    recordId: input.recordId,
    previousOwner,
    newOwner: { ownerId: input.newOwner.id, ownerType: newOwnerType },
    recordEventId: event.id,
  };
}

async function reassignArOpenItemInTx(
  tx: Prisma.TransactionClient,
  input: ReassignInput,
  lock: boolean
): Promise<ReassignResult> {
  const item = await tx.arOpenItem.findFirst({
    where: {
      id: input.recordId,
      ...(input.actorTenantId ? { tenantId: input.actorTenantId } : {}),
    },
    select: {
      id: true,
      status: true,
      ownerId: true,
      ownerType: true,
      tenantId: true,
    },
  });
  if (!item)
    throw new ReassignError("RECORD_NOT_FOUND", `ArOpenItem ${input.recordId} not found`);

  // Reassignable only in active states (OPEN, PARTIAL, REOPENED). Once an
  // item is APPLIED / WRITTEN_OFF / VOID it's terminal and ownership is
  // frozen — those records belong in the historical view, not anyone's
  // active queue.
  if (
    item.status !== "OPEN" &&
    item.status !== "PARTIAL" &&
    item.status !== "REOPENED"
  ) {
    throw new ReassignError(
      "RECORD_NOT_REASSIGNABLE",
      `ArOpenItem status ${item.status} is terminal; ownership is frozen`
    );
  }

  const previousOwner = { ownerId: item.ownerId, ownerType: item.ownerType };
  const newOwnerType = input.newOwner.type;

  await tx.arOpenItem.update({
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
      tenantId: item.tenantId,
      recordType: "ArOpenItem",
      recordId: input.recordId,
      eventType: "OWNER_CHANGED",
      previousValue: previousOwner as object,
      newValue: { ownerId: input.newOwner.id, ownerType: newOwnerType },
      actorUserId: input.actorUserId === "system" ? null : input.actorUserId,
      actorReason: input.reason,
      arOpenItemId: input.recordId,
    },
    select: { id: true },
  });

  return {
    ok: true,
    recordId: input.recordId,
    previousOwner,
    newOwner: { ownerId: input.newOwner.id, ownerType: newOwnerType },
    recordEventId: event.id,
  };
}

async function reassignApOpenItemInTx(
  tx: Prisma.TransactionClient,
  input: ReassignInput,
  lock: boolean
): Promise<ReassignResult> {
  const item = await tx.apOpenItem.findFirst({
    where: {
      id: input.recordId,
      ...(input.actorTenantId ? { tenantId: input.actorTenantId } : {}),
    },
    select: {
      id: true,
      status: true,
      ownerId: true,
      ownerType: true,
      tenantId: true,
    },
  });
  if (!item)
    throw new ReassignError("RECORD_NOT_FOUND", `ApOpenItem ${input.recordId} not found`);

  // Same terminal-states rule as ArOpenItem — once APPLIED/WRITTEN_OFF/VOID,
  // ownership is frozen for historical integrity.
  if (
    item.status !== "OPEN" &&
    item.status !== "PARTIAL" &&
    item.status !== "REOPENED"
  ) {
    throw new ReassignError(
      "RECORD_NOT_REASSIGNABLE",
      `ApOpenItem status ${item.status} is terminal; ownership is frozen`
    );
  }

  const previousOwner = { ownerId: item.ownerId, ownerType: item.ownerType };
  const newOwnerType = input.newOwner.type;

  await tx.apOpenItem.update({
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
      tenantId: item.tenantId,
      recordType: "ApOpenItem",
      recordId: input.recordId,
      eventType: "OWNER_CHANGED",
      previousValue: previousOwner as object,
      newValue: { ownerId: input.newOwner.id, ownerType: newOwnerType },
      actorUserId: input.actorUserId === "system" ? null : input.actorUserId,
      actorReason: input.reason,
      apOpenItemId: input.recordId,
    },
    select: { id: true },
  });

  return {
    ok: true,
    recordId: input.recordId,
    previousOwner,
    newOwner: { ownerId: input.newOwner.id, ownerType: newOwnerType },
    recordEventId: event.id,
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
  // Resolve the record's tenantId up-front so the RecordEvent inherits it.
  // Each record type's row carries its own denormalized tenantId.
  let tenantId: string;
  switch (recordType) {
    case "JournalEntry": {
      const r = await prisma.journalEntry.findUniqueOrThrow({
        where: { id: recordId },
        select: { tenantId: true },
      });
      tenantId = r.tenantId;
      break;
    }
    case "ArOpenItem": {
      const r = await prisma.arOpenItem.findUniqueOrThrow({
        where: { id: recordId },
        select: { tenantId: true },
      });
      tenantId = r.tenantId;
      break;
    }
    case "ApOpenItem": {
      const r = await prisma.apOpenItem.findUniqueOrThrow({
        where: { id: recordId },
        select: { tenantId: true },
      });
      tenantId = r.tenantId;
      break;
    }
  }

  await prisma.$transaction(async (tx) => {
    switch (recordType) {
      case "JournalEntry":
        await tx.journalEntry.update({
          where: { id: recordId },
          data: { reassignmentLockedAt: null, updatedBy: actorUserId },
        });
        break;
      case "ArOpenItem":
        await tx.arOpenItem.update({
          where: { id: recordId },
          data: { reassignmentLockedAt: null, updatedBy: actorUserId },
        });
        break;
      case "ApOpenItem":
        await tx.apOpenItem.update({
          where: { id: recordId },
          data: { reassignmentLockedAt: null, updatedBy: actorUserId },
        });
        break;
    }
    await tx.recordEvent.create({
      data: {
        tenantId,
        recordType,
        recordId,
        eventType: "REASSIGNMENT_UNLOCKED",
        actorUserId: actorUserId === "system" ? null : actorUserId,
        actorReason: reason,
        journalEntryId: recordType === "JournalEntry" ? recordId : null,
        arOpenItemId: recordType === "ArOpenItem" ? recordId : null,
        apOpenItemId: recordType === "ApOpenItem" ? recordId : null,
      },
    });
  });
}
