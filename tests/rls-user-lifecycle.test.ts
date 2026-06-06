// Integration test for RLS Phase 2b — user-lifecycle deactivation loop.
//
// Verifies the multi-tenant batch shape: each iteration of the
// reassignment loop sets its own GUC via withTenantContext using the
// record's tenantId (read from OrphanedRecord.tenantId which was
// added by this PR).
//
// Single-tenant test bed (the seeded "default" tenant) since multi-
// tenant fixtures aren't available here — the test proves the
// PER-RECORD wrap pattern works, not the cross-tenant span. Phase 3
// cross-tenant tests will exercise the FORCE-enforcement angle.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  getCurrentTenantGuc,
} from "../src/lib/db/tenant-context";
import { reassignRecordInTx } from "../src/lib/ownership/reassign";
import { previewOrphansForUserChange } from "../src/lib/ownership/orphan-detection";
import { postJournalEntry } from "../src/lib/accounting/post-journal";

const prisma = new PrismaClient();

let tenantId: string;
let entityCode: string;
let bookCode: string;
let actorUserId: string;
// A throwaway user we can mark as owner of a JE then "reassign" off of.
let candidateUserId: string;

beforeAll(async () => {
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: "NORTHWIND" },
    select: { code: true, tenantId: true },
  });
  tenantId = entity.tenantId;
  entityCode = entity.code;
  bookCode = "US_GAAP";

  // Two real members so we have actor + candidate.
  const memberships = await prisma.tenantMembership.findMany({
    where: { tenantId },
    select: { userId: true },
    take: 2,
  });
  if (memberships.length < 2) {
    throw new Error(
      "RLS user-lifecycle test needs at least 2 tenant members in seed data"
    );
  }
  actorUserId = memberships[0].userId;
  candidateUserId = memberships[1].userId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("user-lifecycle bulk-reassign — RLS plumbing", () => {
  it("OrphanedRecord carries tenantId (used by the deactivation loop to set the GUC)", async () => {
    // Seed: a JE, then force ownership to candidateUserId. We bypass
    // postJournalEntry's ownerUserId arg because the ON_INSERT rules
    // engine may rewrite ownership on creation (e.g., route to a
    // queue) — for this test we need deterministic ownership.
    const seeded = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode: "USD",
      documentDate: new Date("2026-06-01"),
      memo: "RLS user-lifecycle test",
      source: "MANUAL",
      sourceRecordType: "RlsPlumbing",
      sourceRecordId: `RLS-LIFECYCLE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdBy: "test",
      lines: [
        { accountCode: "1000", debit: "1.00", description: "Cash" },
        { accountCode: "4000", credit: "1.00", description: "Revenue" },
      ],
    });
    await prisma.journalEntry.update({
      where: { id: seeded.id },
      data: { ownerId: candidateUserId, ownerType: "USER" },
    });
    const je = seeded;

    // Sanity-check: the JE was actually created with candidateUserId as owner.
    const persisted = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: je.id },
      select: { ownerId: true, ownerType: true },
    });
    expect(persisted.ownerType).toBe("USER");
    expect(persisted.ownerId).toBe(candidateUserId);

    const orphans = await previewOrphansForUserChange(prisma, candidateUserId);
    const ours = orphans.find((o) => o.recordId === je.id);
    expect(ours).toBeDefined();
    expect(ours!.tenantId).toBe(tenantId);
  });

  it("per-iteration withTenantContext + reassignRecordInTx works", async () => {
    // Seed: a JE forced to candidateUserId ownership (see prior test
    // for why we bypass postJournalEntry's ownerUserId arg).
    const seeded = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode: "USD",
      documentDate: new Date("2026-06-01"),
      memo: "RLS per-iteration test",
      source: "MANUAL",
      sourceRecordType: "RlsPlumbing",
      sourceRecordId: `RLS-ITER-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdBy: "test",
      lines: [
        { accountCode: "1000", debit: "1.00", description: "Cash" },
        { accountCode: "4000", credit: "1.00", description: "Revenue" },
      ],
    });
    await prisma.journalEntry.update({
      where: { id: seeded.id },
      data: { ownerId: candidateUserId, ownerType: "USER" },
    });
    const je = seeded;

    const orphans = await previewOrphansForUserChange(prisma, candidateUserId);
    const target = orphans.find((o) => o.recordId === je.id);
    expect(target).toBeDefined();

    // Mimic the production loop body exactly.
    let observedGuc: string | null = null;
    await withTenantContext(target!.tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);
      return reassignRecordInTx(tx, {
        recordType: target!.recordType,
        recordId: target!.recordId,
        newOwner: { type: "USER", id: actorUserId },
        actorUserId,
        actorTenantId: target!.tenantId,
        reason: "lifecycle:RLS plumbing test",
        lockFromRules: false,
        silent: true,
      });
    });

    expect(observedGuc).toBe(tenantId);

    const after = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: je.id },
      select: { ownerId: true, ownerType: true },
    });
    expect(after.ownerId).toBe(actorUserId);
    expect(after.ownerType).toBe("USER");
  });
});
