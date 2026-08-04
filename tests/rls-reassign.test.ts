// Integration test for RLS Phase 2b — reassignRecord Class T refactor.
//
// Two-axis verification:
//   1. Outer wrapper (reassignRecord) still works on raw PrismaClient
//      — proves backward compatibility for legacy callers (seeds,
//      rules-engine paths).
//   2. Inner half (reassignRecordInTx) runs cleanly inside
//      withTenantContext with the GUC set — proves the Server Action
//      migration path.
//
// The 3 sub-functions (reassignJournalEntryInTx / reassignArOpenItemInTx
// / reassignApOpenItemInTx) share the same dispatch + tx semantics, so
// one record-type exercise (ApOpenItem mirrors AP which is well-tested
// elsewhere) is sufficient to pin the pattern. The full integration
// test exists in tests/reassignment.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  currentTenantId,
} from "../src/lib/tenant-context";
import {
  reassignRecord,
  reassignRecordInTx,
} from "../src/lib/ownership/reassign";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { openApItem } from "../src/lib/accounting/sub-ledgers/ap";

const prisma = new PrismaClient();

let tenantId: string;
let entityCode: string;
let bookCode: string;
let partyCode: string;
let actorUserId: string;

beforeAll(async () => {
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: "NORTHWIND" },
    select: { code: true, tenantId: true },
  });
  tenantId = entity.tenantId;
  entityCode = entity.code;
  bookCode = "US_GAAP";

  const party = await prisma.party.findFirstOrThrow({
    where: {
      tenantId,
      roles: { some: { role: "VENDOR" } },
      OR: [{ entityId: null }, { entity: { code: "NORTHWIND" } }],
    },
    select: { code: true },
  });
  partyCode = party.code;

  const membership = await prisma.tenantMembership.findFirstOrThrow({
    where: { tenantId },
    select: { userId: true },
  });
  actorUserId = membership.userId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedOpenApItem(): Promise<{ id: string }> {
  // Need a posted JE first to back the open item.
  const bill = await postJournalEntry(prisma, {
    tenantId,
    entityCode,
    bookCode,
    currencyCode: "USD",
    documentDate: new Date("2026-06-01"),
    memo: "Bill — RLS reassign test",
    source: "MANUAL",
    sourceRecordType: "VendorBill",
    sourceRecordId: `RLS-REASSIGN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdBy: "test",
    lines: [
      { accountCode: "6000", debit: "10.00", description: "Expense" },
      { accountCode: "2000", credit: "10.00", partyCode, description: "Bill" },
    ],
  });
  const item = await openApItem(prisma, {
    entityCode,
    bookCode,
    partyCode,
    openedByEntryId: bill.id,
    openedDate: new Date("2026-06-01"),
    amount: "10.00",
    currencyCode: "USD",
    controlAccountCode: "2000",
    actorUserId: "system",
  });
  return { id: item.id };
}

describe("reassignRecord Class T — RLS plumbing", () => {
  it("inner half (reassignRecordInTx) runs inside withTenantContext with GUC set", async () => {
    const item = await seedOpenApItem();

    let observedGuc: string | null = null;
    const result = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);
      return reassignRecordInTx(tx, {
        recordType: "ApOpenItem",
        recordId: item.id,
        newOwner: { type: "USER", id: actorUserId },
        actorUserId,
        actorTenantId: tenantId,
        reason: "manual:RLS plumbing test",
        lockFromRules: true,
      });
    });

    expect(observedGuc).toBe(tenantId);
    expect(result.ok).toBe(true);
    expect(result.recordId).toBe(item.id);
    expect(result.newOwner.ownerId).toBe(actorUserId);
    expect(result.newOwner.ownerType).toBe("USER");
    expect(result.recordEventId).toMatch(/^[0-9a-f-]{36}$/i);

    // Verify the record + event committed.
    const after = await prisma.apOpenItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { ownerId: true, ownerType: true, reassignmentLockedAt: true },
    });
    expect(after.ownerId).toBe(actorUserId);
    expect(after.ownerType).toBe("USER");
    expect(after.reassignmentLockedAt).not.toBeNull();

    const event = await prisma.recordEvent.findUniqueOrThrow({
      where: { id: result.recordEventId },
      select: { eventType: true, apOpenItemId: true, tenantId: true },
    });
    expect(event.eventType).toBe("OWNER_CHANGED");
    expect(event.apOpenItemId).toBe(item.id);
    expect(event.tenantId).toBe(tenantId);
  });

  it("outer wrapper (reassignRecord) still works on raw PrismaClient (legacy callers)", async () => {
    const item = await seedOpenApItem();

    const result = await reassignRecord(prisma, {
      recordType: "ApOpenItem",
      recordId: item.id,
      newOwner: { type: "USER", id: actorUserId },
      actorUserId,
      actorTenantId: tenantId,
      reason: "manual:RLS legacy path test",
      lockFromRules: true,
      silent: true, // skip notification — keeps the test deterministic
    });

    expect(result.ok).toBe(true);
    expect(result.recordId).toBe(item.id);

    const after = await prisma.apOpenItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { ownerId: true },
    });
    expect(after.ownerId).toBe(actorUserId);
  });
});
