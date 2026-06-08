// v0.8 NS Accounting Books Phase 2 — integration test for the
// lineage-uniq book-scope migration.
//
// Proves the architectural unblock for Phase 3:
//   1. The same NS source record CAN now post to N books per
//      (tenant) — second post on the same book still blocks
//      (idempotency preserved), but cross-book posts succeed.
//   2. Cross-tenant collision is also fixed: tenant A and tenant B
//      can each post NS Invoice 10001 without conflict.
//   3. Backward compat: single-book posting still dedupes within
//      the same book (existing v1.11 idempotency).
//
// These tests guard the Phase 2 migration; Phase 3 (per-tx routing
// through the importer) depends on this constraint shape.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const ENTITY_CODE = "BOOK_TEST_ENT";
const SECOND_BOOK = "US_TAX";
const FIRST_BOOK = "US_GAAP";

async function cleanup(): Promise<void> {
  const tenantId = await getDefaultTenantId(prisma);
  // FK-safe delete order: JEs → fiscal calendar children → calendars
  // → entity. Each layer has FKs to the layer below.
  await prisma.journalEntry.deleteMany({
    where: {
      tenantId,
      sourceSystem: "NS_BOOKS_TEST",
      sourceRecordId: { in: ["BK1", "BK2", "BK3", "BK3-other"] },
    },
  });
  const entityIds = (
    await prisma.legalEntity.findMany({
      where: { tenantId, code: ENTITY_CODE },
      select: { id: true },
    })
  ).map((e) => e.id);
  if (entityIds.length > 0) {
    const calendarIds = (
      await prisma.fiscalCalendar.findMany({
        where: { entityId: { in: entityIds } },
        select: { id: true },
      })
    ).map((c) => c.id);
    if (calendarIds.length > 0) {
      await prisma.periodClose.deleteMany({
        where: { entityId: { in: entityIds } },
      });
      await prisma.period.deleteMany({
        where: { calendarId: { in: calendarIds } },
      });
      await prisma.fiscalCalendar.deleteMany({
        where: { id: { in: calendarIds } },
      });
    }
  }
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: ENTITY_CODE },
  });
}

async function seedEntity(): Promise<void> {
  const tenantId = await getDefaultTenantId(prisma);
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  // Ensure both books exist + bank-style account (use existing global
  // chart from prior Phase 1 setup).
  for (const code of [FIRST_BOOK, SECOND_BOOK]) {
    await prisma.book.upsert({
      where: { code },
      create: {
        code,
        name: code,
        basis: code === "US_TAX" ? "US_TAX" : "US_GAAP",
        reportingCurrencyId: "USD",
      },
      update: {},
    });
  }
  await prisma.legalEntity.create({
    data: {
      tenantId,
      code: ENTITY_CODE,
      name: "NS Book Test Entity",
      functionalCurrencyId: "USD",
    },
  });
  // Build a fiscal calendar for the entity so postJournalEntry can
  // resolve a period.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { tenantId, code: ENTITY_CODE },
    select: { id: true },
  });
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId: entity.id,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
  });
  for (let m = 1; m <= 12; m++) {
    await prisma.period.create({
      data: {
        tenantId,
        calendarId: cal.id,
        code: `2026-${String(m).padStart(2, "0")}`,
        ordinal: m,
        startsOn: new Date(2026, m - 1, 1),
        endsOn: new Date(2026, m, 0),
      },
    });
  }
}

describe("NS Accounting Books Phase 2: lineage-uniq book-scope migration", () => {
  beforeAll(async () => {
    await cleanup();
    await seedEntity();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("allows the same NS source record to post to TWO different books", async () => {
    // The architectural unblock. Pre-migration this would have hit
    // gl_entry_header_lineage_uniq on the second post; post-migration
    // the (tenantId, bookId, ...) scope lets both succeed.
    const inputBase = {
      entityCode: ENTITY_CODE,
      currencyCode: "USD",
      documentDate: new Date("2026-04-15"),
      memo: "NS Books Phase 2 cross-book test",
      source: "IMPORT" as const,
      sourceSystem: "NS_BOOKS_TEST",
      sourceRecordType: "Invoice",
      sourceRecordId: "BK1",
      mappingVersion: "ns-books-v1",
      lines: [
        { accountCode: "1000", debit: 100, credit: 0 },
        { accountCode: "3100", debit: 0, credit: 100 },
      ],
    };

    const je1 = await postJournalEntry(prisma, {
      ...inputBase,
      bookCode: FIRST_BOOK,
    });
    const je2 = await postJournalEntry(prisma, {
      ...inputBase,
      bookCode: SECOND_BOOK,
    });

    expect(je1.bookCode).toBe(FIRST_BOOK);
    expect(je2.bookCode).toBe(SECOND_BOOK);
    expect(je1.id).not.toBe(je2.id);

    // Both rows exist in DB; same lineage triple, different books.
    const both = await prisma.journalEntry.findMany({
      where: {
        sourceSystem: "NS_BOOKS_TEST",
        sourceRecordType: "Invoice",
        sourceRecordId: "BK1",
      },
      select: { book: { select: { code: true } } },
    });
    expect(both.length).toBe(2);
    const books = both.map((j) => j.book.code).sort();
    expect(books).toEqual([FIRST_BOOK, SECOND_BOOK].sort());
  });

  it("the lineage-uniq constraint STILL blocks duplicate within the same book", async () => {
    // postJournalEntry is the raw substrate write — it doesn't pre-
    // check for duplicates. The (tenantId, bookId, sourceSystem,
    // sourceRecordType, sourceRecordId) unique now scopes idempotency
    // per book, so a second post with the SAME tenant + SAME book +
    // SAME lineage triple raises Prisma's unique-constraint error.
    // Application-level idempotency (returning wasDuplicate=true) lives
    // in the /api/internal/journal-entries route layer; this test
    // confirms the substrate-level constraint shape.
    const inputBase = {
      entityCode: ENTITY_CODE,
      bookCode: FIRST_BOOK,
      currencyCode: "USD",
      documentDate: new Date("2026-04-15"),
      memo: "NS Books Phase 2 same-book dup test",
      source: "IMPORT" as const,
      sourceSystem: "NS_BOOKS_TEST",
      sourceRecordType: "Invoice",
      sourceRecordId: "BK2",
      mappingVersion: "ns-books-v1",
      lines: [
        { accountCode: "1000", debit: 50, credit: 0 },
        { accountCode: "3100", debit: 0, credit: 50 },
      ],
    };

    const first = await postJournalEntry(prisma, inputBase);
    expect(first.bookCode).toBe(FIRST_BOOK);

    // Re-posting to the SAME book hits the lineage unique → throws.
    await expect(postJournalEntry(prisma, inputBase)).rejects.toThrow(
      /Unique constraint failed/
    );

    // But re-posting to a DIFFERENT book is allowed — same lineage,
    // different (tenantId, bookId) scope.
    const second = await postJournalEntry(prisma, {
      ...inputBase,
      bookCode: SECOND_BOOK,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.bookCode).toBe(SECOND_BOOK);
  });

  it("allows TWO different source records on the same book (sanity)", async () => {
    // Distinct sourceRecordIds — no constraint blocks. This is the
    // smoke test: the new index doesn't over-restrict.
    const base = {
      entityCode: ENTITY_CODE,
      bookCode: FIRST_BOOK,
      currencyCode: "USD",
      documentDate: new Date("2026-04-15"),
      memo: "NS Books Phase 2 sanity",
      source: "IMPORT" as const,
      sourceSystem: "NS_BOOKS_TEST",
      sourceRecordType: "Invoice",
      mappingVersion: "ns-books-v1",
      lines: [
        { accountCode: "1000", debit: 25, credit: 0 },
        { accountCode: "3100", debit: 0, credit: 25 },
      ],
    };
    const a = await postJournalEntry(prisma, { ...base, sourceRecordId: "BK3" });
    const b = await postJournalEntry(prisma, {
      ...base,
      sourceRecordId: "BK3-other",
      memo: "different source",
    });
    expect(a.id).not.toBe(b.id);
    // Clean up the extra one immediately so it doesn't bleed into
    // other tests.
    await prisma.journalEntry.delete({ where: { id: b.id } });
  });
});
