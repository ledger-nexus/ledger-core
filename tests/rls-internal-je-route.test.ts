// Integration test for RLS Phase 2b — /api/internal/journal-entries route.
//
// The route's lookup+post path mirrors this pattern: idempotency findByLineage
// inside its own withTenantContext, then postJournalEntry inside another.
// We don't drive the route through HTTP here — we exercise the same primitive
// shape (findByLineage as widened helper + postJournalEntry inside
// withTenantContext) so a regression on either side would catch.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  getCurrentTenantGuc,
} from "../src/lib/db/tenant-context";
import { postJournalEntry } from "../src/lib/accounting/post-journal";

const prisma = new PrismaClient();

let tenantId: string;
let entityCode: string;
let bookCode: string;

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

    const existing = await withTenantContext(tenantId, async (tx) => {
      observedGucLookup = await getCurrentTenantGuc(tx);
      return tx.journalEntry.findFirst({
        where: { tenantId, sourceSystem, sourceRecordType, sourceRecordId },
        select: { id: true },
      });
    });
    expect(observedGucLookup).toBe(tenantId);
    expect(existing).toBeNull();

    const result = await withTenantContext(tenantId, async (tx) => {
      observedGucPost = await getCurrentTenantGuc(tx);
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
    expect(observedGucPost).toBe(tenantId);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);

    // Second call — idempotency: same lineage triple, lookup returns the existing entry.
    const secondLookup = await withTenantContext(tenantId, async (tx) =>
      tx.journalEntry.findFirst({
        where: { tenantId, sourceSystem, sourceRecordType, sourceRecordId },
        select: { id: true },
      })
    );
    expect(secondLookup?.id).toBe(result.id);
  });
});
