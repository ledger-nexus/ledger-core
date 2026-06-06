// Integration test for RLS Phase 2b — create + reverse journal entry actions.
//
// Both actions wrap their core postJournalEntry calls in withTenantContext.
// create-journal-entry is the simplest possible migration shape: ONE prisma
// call → wrap + swap (postJournalEntry already accepts TransactionClient
// per ledger-core v1.11 contract). reverse-journal-entry exercises a richer
// shape — read-source + post-reversal + status-flip + reversal-link, all
// inside the same withTenantContext.
//
// Asserts the GUC is set throughout via direct getCurrentTenantGuc reads
// from inside an analog withTenantContext. The Server Actions themselves
// are tested end-to-end via the existing JE invariants suite — this test
// pins the RLS plumbing specifically.

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
let currencyCode: string;

beforeAll(async () => {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { slug: "default" },
    select: { id: true },
  });
  tenantId = tenant.id;

  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { tenantId, code: "NORTHWIND" },
    select: { code: true },
  });
  entityCode = entity.code;
  bookCode = "US_GAAP";
  currencyCode = "USD";
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("create-journal-entry RLS plumbing", () => {
  it("postJournalEntry runs inside withTenantContext with GUC set", async () => {
    let observedGuc: string | null = null;
    const entry = await withTenantContext(tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);
      return postJournalEntry(tx, {
        tenantId,
        entityCode,
        bookCode,
        currencyCode,
        documentDate: new Date("2026-06-15"),
        memo: "RLS plumbing — create",
        source: "MANUAL",
        sourceRecordType: "RlsPlumbing",
        sourceRecordId: `RLS-CREATE-${Date.now()}`,
        createdBy: "test",
        lines: [
          { accountCode: "1000", debit: "10.00", description: "Cash" },
          { accountCode: "4000", credit: "10.00", description: "Revenue" },
        ],
      });
    });
    expect(observedGuc).toBe(tenantId);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/i);

    // Verify the JE actually committed as POSTED — postJournalEntry's return
    // doesn't include status, so re-fetch.
    const persisted = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { status: true },
    });
    expect(persisted.status).toBe("POSTED");
  });
});

describe("reverse-journal-entry RLS plumbing", () => {
  it("full read-then-write chain runs inside one withTenantContext tx", async () => {
    // Setup: post a source entry via the legacy path.
    const source = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode,
      documentDate: new Date("2026-06-01"),
      memo: "RLS plumbing — source for reversal",
      source: "MANUAL",
      sourceRecordType: "RlsPlumbing",
      sourceRecordId: `RLS-SRC-${Date.now()}`,
      createdBy: "test",
      lines: [
        { accountCode: "1000", debit: "20.00", description: "Cash" },
        { accountCode: "4000", credit: "20.00", description: "Revenue" },
      ],
    });

    // Mimic the action's tx body — read the source, post the reversal,
    // flip status, link reversalOfId. All inside one withTenantContext.
    let observedGuc: string | null = null;
    const reversalId = await withTenantContext(tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);

      const src = await tx.journalEntry.findFirstOrThrow({
        where: { id: source.id, tenantId },
        include: {
          entity: { select: { code: true } },
          book: { select: { code: true } },
          lines: {
            include: {
              account: { select: { code: true } },
              party: { select: { code: true } },
              item: { select: { code: true } },
            },
            orderBy: { lineNo: "asc" },
          },
        },
      });

      const reversal = await postJournalEntry(tx, {
        tenantId,
        entityCode: src.entity.code,
        bookCode: src.book.code,
        documentDate: new Date("2026-07-01"),
        memo: `Reversal of ${src.entryNumber}`,
        currencyCode: src.currencyId,
        source: "SYSTEM",
        createdBy: "test",
        sourceSystem: "SUBSTRATE",
        sourceRecordType: "JournalEntry.reversal",
        sourceRecordId: src.id,
        lines: src.lines.map((l) => ({
          accountCode: l.account.code,
          debit: l.credit.toString(),
          credit: l.debit.toString(),
        })),
      });

      await tx.journalEntry.update({
        where: { id: src.id },
        data: { status: "REVERSED" },
      });
      await tx.journalEntry.update({
        where: { id: reversal.id },
        data: { reversalOfId: src.id },
      });

      return reversal.id;
    });

    expect(observedGuc).toBe(tenantId);

    // Verify the writes committed.
    const after = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: source.id },
      select: { status: true },
    });
    expect(after.status).toBe("REVERSED");

    const reversal = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: reversalId },
      select: { reversalOfId: true, status: true },
    });
    expect(reversal.reversalOfId).toBe(source.id);
    expect(reversal.status).toBe("POSTED");
  });
});
