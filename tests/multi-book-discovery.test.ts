// v0.9 NS Books Phase 3.5.E — multi-book discovery helper test.
//
// Proves listEntityBooksWithOpenItems returns the right shape for the
// MultiBookBanner UI: every distinct book with at least one open AR/AP
// item on the named entity, with per-book AR/AP counts, sorted by
// book code.
//
// Setup: one entity, two books (US_GAAP + US_TAX). Different open-item
// distribution per book.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { listEntityBooksWithOpenItems } from "@/lib/accounting/sub-ledgers/cross-book";

const prisma = new PrismaClient();

const TEST_ENTITY = "P35E_ENT";
const TEST_PARTY = "P35E_PARTY";

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
async function seedJe(
  tenantId: string,
  entityId: string,
  bookCode: string
): Promise<string> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: bookCode },
    select: { id: true },
  });
  jeCounter += 1;
  const je = await prisma.journalEntry.create({
    data: {
      tenantId,
      entryNumber: `P35E-${bookCode}-${String(jeCounter).padStart(5, "0")}`,
      entityId,
      bookId: book.id,
      currencyId: "USD",
      fxRate: "1.0000000000",
      documentDate: new Date("2026-04-15"),
      postingDate: new Date("2026-04-15"),
      memo: "P35E seed JE",
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
  status: "OPEN" | "APPLIED" = "OPEN"
): Promise<void> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: bookCode },
    select: { id: true },
  });
  const jeId = await seedJe(tenantId, entityId, bookCode);
  await prisma.arOpenItem.create({
    data: {
      tenantId,
      entityId,
      bookId: book.id,
      partyId,
      openedByEntryId: jeId,
      referenceNumber: `AR-${bookCode}-${jeCounter}`,
      openedDate: new Date("2026-04-15"),
      originalAmount: "100.0000",
      currentBalance: status === "OPEN" ? "100.0000" : "0.0000",
      currencyId: "USD",
      controlAccountCode: "1200",
      status,
    },
  });
}

async function seedAp(
  tenantId: string,
  entityId: string,
  partyId: string,
  bookCode: string
): Promise<void> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: bookCode },
    select: { id: true },
  });
  const jeId = await seedJe(tenantId, entityId, bookCode);
  await prisma.apOpenItem.create({
    data: {
      tenantId,
      entityId,
      bookId: book.id,
      partyId,
      openedByEntryId: jeId,
      referenceNumber: `AP-${bookCode}-${jeCounter}`,
      openedDate: new Date("2026-04-15"),
      originalAmount: "200.0000",
      currentBalance: "200.0000",
      currencyId: "USD",
      controlAccountCode: "2100",
      status: "OPEN",
    },
  });
}

async function cleanup(): Promise<void> {
  const tenantId = await getDefaultTenantId(prisma);
  await prisma.arOpenItem.deleteMany({
    where: { tenantId, entity: { code: TEST_ENTITY } },
  });
  await prisma.apOpenItem.deleteMany({
    where: { tenantId, entity: { code: TEST_ENTITY } },
  });
  await prisma.journalEntry.deleteMany({
    where: { tenantId, memo: "P35E seed JE" },
  });
  await prisma.party.deleteMany({
    where: { tenantId, code: TEST_PARTY },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: TEST_ENTITY },
  });
}

describe("v0.9 NS Books Phase 3.5.E: multi-book discovery helper", () => {
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
        name: "P35E Test Entity",
        functionalCurrencyId: "USD",
      },
    });
    entityId = entity.id;
    const party = await prisma.party.create({
      data: {
        tenantId,
        entityId,
        code: TEST_PARTY,
        displayName: "P35E Test Party",
      },
    });
    partyId = party.id;

    // Distribution:
    //   US_GAAP: 2 open AR + 1 open AP
    //   US_TAX:  1 open AR + 0 open AP
    //   Also: 1 APPLIED AR on US_GAAP — should be FILTERED out of the
    //   helper output (the helper only counts actionable balances).
    await seedAr(tenantId, entityId, partyId, "US_GAAP");
    await seedAr(tenantId, entityId, partyId, "US_GAAP");
    await seedAr(tenantId, entityId, partyId, "US_GAAP", "APPLIED");
    await seedAr(tenantId, entityId, partyId, "US_TAX");
    await seedAp(tenantId, entityId, partyId, "US_GAAP");
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("returns both books with correct AR/AP open-item counts (APPLIED filtered)", async () => {
    const result = await listEntityBooksWithOpenItems(prisma, TEST_ENTITY);

    // 2 distinct books with open items.
    expect(result.length).toBe(2);

    // Sort order: alphabetical book code.
    expect(result.map((r) => r.bookCode)).toEqual(["US_GAAP", "US_TAX"]);

    // US_GAAP: 2 open AR (NOT 3 — the APPLIED one is filtered),
    // 1 open AP.
    const usGaap = result.find((r) => r.bookCode === "US_GAAP")!;
    expect(usGaap.openArCount).toBe(2);
    expect(usGaap.openApCount).toBe(1);

    // US_TAX: 1 open AR, 0 open AP.
    const usTax = result.find((r) => r.bookCode === "US_TAX")!;
    expect(usTax.openArCount).toBe(1);
    expect(usTax.openApCount).toBe(0);
  });

  it("returns empty array for an entity with no open items", async () => {
    // Cleanup leaves the entity row but removes all open items. Re-seed
    // ONLY an entity (no open items) and verify the helper returns [].
    const result = await listEntityBooksWithOpenItems(
      prisma,
      "P35E_NONEXISTENT_ENTITY"
    );
    expect(result).toEqual([]);
  });
});
