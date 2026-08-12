// Integration test for RLS Phase 2b — /api/internal/journal-entries route.
//
// The route's lookup+post path mirrors this pattern: idempotency findByLineage
// inside its own withTenantContext, then postJournalEntry inside another.
// We don't drive the route through HTTP here — we exercise the same primitive
// shape (findByLineage as widened helper + postJournalEntry inside
// withTenantContext) so a regression on either side would catch.
//
// THE ONE OF THE THREE THAT ACTUALLY LEAKED. #368 closed six rls-* suites and
// left this one plus rls-recurring-entries and rls-run-recurring, on the
// assumption that all three posted through paths with no returned id.
// Measured: running the three against a NORTHWIND holding 2 foreign entries
// left 3, and the new one was this suite's. The id was available the whole
// time — `withTenantContext` returns whatever its callback returns, so the
// post's result comes straight back out of the await.
//
// The entry is dated 2026-06-01 with $1 of revenue on 4000, which lands
// inside the Jan–Jun window seeded-company asserts exact totals over. That
// is the same shape of pollution as #367, one dollar instead of ten.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  currentTenantId,
} from "../src/lib/tenant-context";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { deleteEntries } from "./helpers/ledger-cleanup";

const prisma = new PrismaClient();

let tenantId: string;
let entityCode: string;
let bookCode: string;

/** Entries this suite posts into shared NORTHWIND, removed in afterAll. */
const createdEntryIds: string[] = [];

beforeAll(async () => {
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: "NORTHWIND" },
    select: { code: true, tenantId: true },
  });
  tenantId = entity.tenantId;
  entityCode = entity.code;
  bookCode = "US_GAAP";
});

afterAll(async () => {
  // deleteEntries, not journalEntry.deleteMany — see tests/helpers/ledger-cleanup.ts
  // for why the delete order matters even when this suite's own lines are
  // plain GL accounts.
  await deleteEntries(prisma, createdEntryIds);
  await prisma.$disconnect();
});

describe("/api/internal/journal-entries RLS plumbing", () => {
  it("idempotency lookup + postJournalEntry both run inside withTenantContext", async () => {
    const sourceSystem = "rls-test";
    const sourceRecordType = "RlsTestRecord";
    const sourceRecordId = `RLS-INT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // First call — no existing entry, lookup returns null + post creates one.
    let observedGucLookup: string | null = null;
    let observedGucPost: string | null = null;

    const existing = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGucLookup = await currentTenantId(tx);
      return tx.journalEntry.findFirst({
        where: { tenantId, sourceSystem, sourceRecordType, sourceRecordId },
        select: { id: true },
      });
    });
    expect(observedGucLookup).toBe(tenantId);
    expect(existing).toBeNull();

    const result = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGucPost = await currentTenantId(tx);
      return postJournalEntry(tx, {
        tenantId,
        entityCode,
        bookCode,
        currencyCode: "USD",
        documentDate: new Date("2026-06-01"),
        memo: "RLS internal-route plumbing",
        source: "SYSTEM",
        sourceSystem,
        sourceRecordType,
        sourceRecordId,
        createdBy: "test",
        lines: [
          { accountCode: "1000", debit: "1.00", description: "Cash" },
          { accountCode: "4000", credit: "1.00", description: "Revenue" },
        ],
      });
    });
    // Before the assertions: a failing expect below must not strand the entry.
    createdEntryIds.push(result.id);

    expect(observedGucPost).toBe(tenantId);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);

    // Second call — idempotency: same lineage triple, lookup returns the existing entry.
    const secondLookup = await withTenantContext(prisma, tenantId, async (tx) =>
      tx.journalEntry.findFirst({
        where: { tenantId, sourceSystem, sourceRecordType, sourceRecordId },
        select: { id: true },
      })
    );
    expect(secondLookup?.id).toBe(result.id);
  });
});
