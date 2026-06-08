// v0.9 NS Books Phase 3.5.C — aging book-aware reader integration test.
//
// The arAging() and apAging() helpers have always taken bookCode as a
// required parameter and filtered by book.code. This test proves the
// filter actually segregates aging numbers per book under realistic
// multi-book data (as written by Phase 3.5.B's importer loop).
//
// Setup: two AR open items + two AP open items, each pair posted on
// only ONE of two books. The helpers should return ONLY this book's
// rows — no cross-book leakage.
//
// Without the book filter, arAging would return BOTH books' items
// and the per-book totals would look like the consolidated total.
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { arAging, openArBalance } from "@/lib/accounting/sub-ledgers/ar";
import { apAging, openApBalance } from "@/lib/accounting/sub-ledgers/ap";

const prisma = new PrismaClient();

const TEST_ENTITY = "P35C_ENT";
const TEST_PARTY = "P35C_PARTY";

async function ensureFundamentals(): Promise<void> {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  for (const code of ["US_GAAP", "US_TAX"] as const) {
    await prisma.book.upsert({
      where: { code },
      create: { code, name: code, basis: code, reportingCurrencyId: "USD" },
      update: {},
    });
  }
}

let jeCounter = 0;
async function seedPlaceholderJe(
  tenantId: string,
  entityId: string,
  bookCode: string,
  memo: string
): Promise<string> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: bookCode },
    select: { id: true },
  });
  jeCounter += 1;
  const je = await prisma.journalEntry.create({
    data: {
      tenantId,
      entryNumber: `P35C-${bookCode}-${String(jeCounter).padStart(5, "0")}`,
      entityId,
      bookId: book.id,
      currencyId: "USD",
      fxRate: "1.0000000000",
      documentDate: new Date("2026-01-15"),
      postingDate: new Date("2026-01-15"),
      memo,
      source: "MANUAL",
      status: "POSTED",
    },
  });
  return je.id;
}

async function seedAr(
  tenantId: string,
  entityId: string,
  partyId: string,
  bookCode: string,
  openedDate: Date,
  dueDate: Date,
  amount: string
): Promise<void> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: bookCode },
    select: { id: true },
  });
  const jeId = await seedPlaceholderJe(
    tenantId,
    entityId,
    bookCode,
    "P35C seed AR JE"
  );
  await prisma.arOpenItem.create({
    data: {
      tenantId,
      entityId,
      bookId: book.id,
      partyId,
      openedByEntryId: jeId,
      referenceNumber: `AR-${bookCode}-${jeCounter}`,
      openedDate,
      dueDate,
      originalAmount: amount,
      currentBalance: amount,
      currencyId: "USD",
      controlAccountCode: "1200",
      status: "OPEN",
    },
  });
}

async function seedAp(
  tenantId: string,
  entityId: string,
  partyId: string,
  bookCode: string,
  openedDate: Date,
  dueDate: Date,
  amount: string
): Promise<void> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: bookCode },
    select: { id: true },
  });
  const jeId = await seedPlaceholderJe(
    tenantId,
    entityId,
    bookCode,
    "P35C seed AP JE"
  );
  await prisma.apOpenItem.create({
    data: {
      tenantId,
      entityId,
      bookId: book.id,
      partyId,
      openedByEntryId: jeId,
      referenceNumber: `AP-${bookCode}-${jeCounter}`,
      openedDate,
      dueDate,
      originalAmount: amount,
      currentBalance: amount,
      currencyId: "USD",
      controlAccountCode: "2100",
      status: "OPEN",
    },
  });
}

async function cleanup(): Promise<void> {
  const tenantId = await getDefaultTenantId(prisma);
  await prisma.arApplication.deleteMany({
    where: { openItem: { entity: { code: TEST_ENTITY } } },
  });
  await prisma.apApplication.deleteMany({
    where: { openItem: { entity: { code: TEST_ENTITY } } },
  });
  await prisma.arOpenItem.deleteMany({
    where: { tenantId, entity: { code: TEST_ENTITY } },
  });
  await prisma.apOpenItem.deleteMany({
    where: { tenantId, entity: { code: TEST_ENTITY } },
  });
  await prisma.journalEntry.deleteMany({
    where: {
      tenantId,
      memo: { in: ["P35C seed AR JE", "P35C seed AP JE"] },
    },
  });
  await prisma.party.deleteMany({
    where: { tenantId, code: TEST_PARTY },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: TEST_ENTITY },
  });
}

describe("v0.9 NS Books Phase 3.5.C: aging readers segregate per book", () => {
  let tenantId: string;
  let entityId: string;
  let partyId: string;

  beforeAll(async () => {
    await ensureFundamentals();
    await cleanup();
    tenantId = await getDefaultTenantId(prisma);
    const entity = await prisma.legalEntity.create({
      data: {
        tenantId,
        code: TEST_ENTITY,
        name: "P35C Test Entity",
        functionalCurrencyId: "USD",
      },
    });
    entityId = entity.id;
    const party = await prisma.party.create({
      data: {
        tenantId,
        entityId,
        code: TEST_PARTY,
        displayName: "P35C Test Party",
      },
    });
    partyId = party.id;

    // 2 AR open items on US_GAAP only (different due dates so they
    // land in different aging buckets), and 1 AR open item on US_TAX.
    // If the helper leaks across books, US_GAAP aging would show 3
    // items instead of 2.
    await seedAr(
      tenantId,
      entityId,
      partyId,
      "US_GAAP",
      new Date("2026-04-01"),
      new Date("2026-04-15"), // overdue ~15 days vs asOf 2026-04-30
      "100.0000"
    );
    await seedAr(
      tenantId,
      entityId,
      partyId,
      "US_GAAP",
      new Date("2026-02-01"),
      new Date("2026-02-15"), // overdue ~74 days vs asOf 2026-04-30
      "200.0000"
    );
    await seedAr(
      tenantId,
      entityId,
      partyId,
      "US_TAX",
      new Date("2026-04-10"),
      new Date("2026-04-25"), // overdue 5 days vs asOf 2026-04-30
      "300.0000"
    );

    // AP — mirror shape.
    await seedAp(
      tenantId,
      entityId,
      partyId,
      "US_GAAP",
      new Date("2026-03-01"),
      new Date("2026-04-01"), // overdue ~29 days
      "400.0000"
    );
    await seedAp(
      tenantId,
      entityId,
      partyId,
      "US_TAX",
      new Date("2026-04-20"),
      new Date("2026-05-20"), // CURRENT
      "500.0000"
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("arAging on US_GAAP returns ONLY US_GAAP rows (not the cross-book sum)", async () => {
    const asOf = new Date("2026-04-30");
    const buckets = await arAging(prisma, TEST_ENTITY, "US_GAAP", asOf);

    // Two US_GAAP items: one ~15 days overdue (1_30 bucket, 100),
    // one ~74 days overdue (61_90 bucket, 200). Total = 300.
    const byBucket = Object.fromEntries(
      buckets.map((b) => [b.bucket, { count: b.itemCount, total: b.totalBalance.toFixed(2) }])
    );
    expect(byBucket["1_30"].count).toBe(1);
    expect(byBucket["1_30"].total).toBe("100.00");
    expect(byBucket["61_90"].count).toBe(1);
    expect(byBucket["61_90"].total).toBe("200.00");
    // No US_TAX leakage — US_TAX has a 300 item that would otherwise
    // bleed into 1_30 here.
    const total = buckets.reduce((acc, b) => acc.plus(b.totalBalance), buckets[0].totalBalance.minus(buckets[0].totalBalance));
    // Sum across buckets = 300, NOT 600 (which would mean US_TAX leaked in).
    expect(total.toFixed(2)).toBe("300.00");

    // openArBalance reflects the same filter.
    const usGaapBalance = await openArBalance(prisma, TEST_ENTITY, "US_GAAP");
    expect(usGaapBalance.toFixed(2)).toBe("300.00");
  });

  it("arAging on US_TAX returns ONLY the US_TAX row (300)", async () => {
    const asOf = new Date("2026-04-30");
    const buckets = await arAging(prisma, TEST_ENTITY, "US_TAX", asOf);
    const byBucket = Object.fromEntries(
      buckets.map((b) => [b.bucket, { count: b.itemCount, total: b.totalBalance.toFixed(2) }])
    );
    expect(byBucket["1_30"].count).toBe(1);
    expect(byBucket["1_30"].total).toBe("300.00");
    // No 61_90 bucket items — US_GAAP's 200 row should NOT appear.
    expect(byBucket["61_90"].count).toBe(0);
    expect(byBucket["61_90"].total).toBe("0.00");

    const usTaxBalance = await openArBalance(prisma, TEST_ENTITY, "US_TAX");
    expect(usTaxBalance.toFixed(2)).toBe("300.00");
  });

  it("apAging on US_GAAP returns ONLY the US_GAAP row (400, overdue)", async () => {
    const asOf = new Date("2026-04-30");
    const buckets = await apAging(prisma, TEST_ENTITY, "US_GAAP", asOf);
    const byBucket = Object.fromEntries(
      buckets.map((b) => [b.bucket, { count: b.itemCount, total: b.totalBalance.toFixed(2) }])
    );
    // 29-day overdue → 1_30 bucket.
    expect(byBucket["1_30"].count).toBe(1);
    expect(byBucket["1_30"].total).toBe("400.00");
    // CURRENT should be empty — US_TAX's 500 row should NOT leak in here.
    expect(byBucket.CURRENT.count).toBe(0);

    const usGaapBalance = await openApBalance(prisma, TEST_ENTITY, "US_GAAP");
    expect(usGaapBalance.toFixed(2)).toBe("400.00");
  });

  it("apAging on US_TAX returns ONLY the US_TAX row (500, current)", async () => {
    const asOf = new Date("2026-04-30");
    const buckets = await apAging(prisma, TEST_ENTITY, "US_TAX", asOf);
    const byBucket = Object.fromEntries(
      buckets.map((b) => [b.bucket, { count: b.itemCount, total: b.totalBalance.toFixed(2) }])
    );
    // Due 2026-05-20 vs asOf 2026-04-30 → CURRENT.
    expect(byBucket.CURRENT.count).toBe(1);
    expect(byBucket.CURRENT.total).toBe("500.00");
    expect(byBucket["1_30"].count).toBe(0);

    const usTaxBalance = await openApBalance(prisma, TEST_ENTITY, "US_TAX");
    expect(usTaxBalance.toFixed(2)).toBe("500.00");
  });
});
