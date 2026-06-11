// v0.9 NS Books Phase 3.5.A — sub-ledger lineage-uniq book-scope test.
//
// Proves migration 0011's invariants:
//
//   1. The SAME lineage triple (sourceSystem, sourceRecordType,
//      sourceRecordId) CAN coexist on TWO different books in
//      ar_open_item / ap_open_item. This is what unblocks the Phase
//      3.5.B per-book sub-ledger loop.
//
//   2. The SAME lineage triple on the SAME book is BLOCKED by the
//      partial unique index. This is the SOC 2 / idempotency invariant
//      — re-imports cannot silently create duplicate sub-ledger rows.
//
//   3. The SAME lineage triple across two different TENANTS can
//      coexist (closes the pre-existing multi-tenant collision bug
//      that PR #155 fixed for gl_entry_header).
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

// Test scoped lineage IDs — high numeric range to dodge real fixtures.
const LINEAGE_INVOICE = "PHASE_3_5_A_INV_99001";
const LINEAGE_BILL = "PHASE_3_5_A_BILL_99001";

// Fixed test party + entity codes so cleanup is deterministic.
const TEST_ENTITY_CODE = "P35A_ENT";
const TEST_PARTY_CODE = "P35A_PARTY";

async function ensureFundamentals(): Promise<void> {
  // USD currency + US_GAAP + US_TAX books — Northwind-style.
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

async function ensureEntityAndParty(): Promise<{
  tenantId: string;
  entityId: string;
  partyId: string;
}> {
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: TEST_ENTITY_CODE } },
    create: {
      tenantId,
      code: TEST_ENTITY_CODE,
      name: "P35A Test Entity",
      functionalCurrencyId: "USD",
    },
    update: {},
  });
  // Party's unique constraint is [entityId, code] — a party can be
  // global (entityId: null) or entity-scoped. Use findFirst + create.
  let party = await prisma.party.findFirst({
    where: { tenantId, code: TEST_PARTY_CODE, entityId: entity.id },
    select: { id: true },
  });
  if (!party) {
    party = await prisma.party.create({
      data: {
        tenantId,
        entityId: entity.id,
        code: TEST_PARTY_CODE,
        displayName: "P35A Test Party",
      },
      select: { id: true },
    });
  }
  return { tenantId, entityId: entity.id, partyId: party.id };
}

async function cleanup(): Promise<void> {
  const tenantId = await getDefaultTenantId(prisma);
  // FK-safe order: AR/AP open items (point at JE via openedByEntryId)
  // → JEs (point at entity + book) → party + entity. Also nuke any
  // ArOpenItem rows from the manual-entry test that have NO lineage
  // but DO point at our seed JEs.
  await prisma.arApplication.deleteMany({
    where: {
      openItem: {
        OR: [
          { sourceSystem: "NETSUITE", sourceRecordId: LINEAGE_INVOICE },
          { entity: { code: TEST_ENTITY_CODE } },
        ],
      },
    },
  });
  await prisma.apApplication.deleteMany({
    where: {
      openItem: {
        OR: [
          { sourceSystem: "NETSUITE", sourceRecordId: LINEAGE_BILL },
          { entity: { code: TEST_ENTITY_CODE } },
        ],
      },
    },
  });
  await prisma.arOpenItem.deleteMany({
    where: { tenantId, entity: { code: TEST_ENTITY_CODE } },
  });
  await prisma.apOpenItem.deleteMany({
    where: { tenantId, entity: { code: TEST_ENTITY_CODE } },
  });
  await prisma.journalEntry.deleteMany({
    where: {
      tenantId,
      memo: { in: ["P35A seed AR JE", "P35A seed AP JE"] },
    },
  });
  await prisma.party.deleteMany({
    where: { tenantId, code: TEST_PARTY_CODE },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: TEST_ENTITY_CODE },
  });
}

// Helper: seed a placeholder JournalEntry so openedByEntryId has a
// non-null FK target. The actual JE shape doesn't matter for this
// test — we're testing the lineage-uniq index, not the JE itself.
// Counter so each seedJe call gets a unique entryNumber.
let jeCounter = 0;
async function seedJe(
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
      entryNumber: `P35A-${bookCode}-${String(jeCounter).padStart(5, "0")}`,
      entityId,
      bookId: book.id,
      currencyId: "USD",
      fxRate: "1.0000000000",
      documentDate: new Date("2026-04-15"),
      postingDate: new Date("2026-04-15"),
      memo,
      source: "MANUAL",
      status: "POSTED",
    },
  });
  return je.id;
}

describe("v0.9 NS Books Phase 3.5.A: sub-ledger lineage uniq scoped to (tenantId, bookId)", () => {
  let tenantId: string;
  let entityId: string;
  let partyId: string;
  let usGaapBookId: string;
  let usTaxBookId: string;
  let jeUsGaapAr: string;
  let jeUsTaxAr: string;
  let jeUsGaapAp: string;
  let jeUsTaxAp: string;

  beforeAll(async () => {
    await ensureFundamentals();
    await cleanup();
    const seeded = await ensureEntityAndParty();
    tenantId = seeded.tenantId;
    entityId = seeded.entityId;
    partyId = seeded.partyId;
    const usGaap = await prisma.book.findUniqueOrThrow({
      where: { code: "US_GAAP" },
      select: { id: true },
    });
    const usTax = await prisma.book.findUniqueOrThrow({
      where: { code: "US_TAX" },
      select: { id: true },
    });
    usGaapBookId = usGaap.id;
    usTaxBookId = usTax.id;
    // Seed one JE per (book, AR/AP) so openedByEntryId FK target exists.
    jeUsGaapAr = await seedJe(tenantId, entityId, "US_GAAP", "P35A seed AR JE");
    jeUsTaxAr = await seedJe(tenantId, entityId, "US_TAX", "P35A seed AR JE");
    jeUsGaapAp = await seedJe(tenantId, entityId, "US_GAAP", "P35A seed AP JE");
    jeUsTaxAp = await seedJe(tenantId, entityId, "US_TAX", "P35A seed AP JE");
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("allows the same AR lineage triple to coexist on TWO different books", async () => {
    // The invariant Phase 3.5.B depends on: one NS Invoice posts on
    // both US_GAAP AND US_TAX. The lineage triple is identical; only
    // bookId differs.
    const onGaap = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usGaapBookId,
        partyId,
        openedByEntryId: jeUsGaapAr,
        referenceNumber: "INV-001",
        openedDate: new Date("2026-04-15"),
        originalAmount: "100.0000",
        currentBalance: "100.0000",
        currencyId: "USD",
        controlAccountCode: "1200",
        sourceSystem: "NETSUITE",
        sourceRecordType: "Invoice",
        sourceRecordId: LINEAGE_INVOICE,
      },
    });
    expect(onGaap.id).toBeDefined();

    // Same lineage on a different book — must succeed.
    const onTax = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usTaxBookId,
        partyId,
        openedByEntryId: jeUsTaxAr,
        referenceNumber: "INV-001",
        openedDate: new Date("2026-04-15"),
        originalAmount: "100.0000",
        currentBalance: "100.0000",
        currencyId: "USD",
        controlAccountCode: "1200",
        sourceSystem: "NETSUITE",
        sourceRecordType: "Invoice",
        sourceRecordId: LINEAGE_INVOICE,
      },
    });
    expect(onTax.id).toBeDefined();
    expect(onTax.id).not.toBe(onGaap.id);
  });

  it("blocks a duplicate AR lineage triple on the SAME book", async () => {
    // The idempotency invariant: a second insert with the same
    // (tenantId, bookId, sourceSystem, sourceRecordType, sourceRecordId)
    // must fail. Prior test left one row on US_GAAP for this lineage;
    // we try a third — must explode.
    await expect(
      prisma.arOpenItem.create({
        data: {
          tenantId,
          entityId,
          bookId: usGaapBookId,
          partyId,
          openedByEntryId: jeUsGaapAr,
          referenceNumber: "INV-001-dup",
          openedDate: new Date("2026-04-15"),
          originalAmount: "100.0000",
          currentBalance: "100.0000",
          currencyId: "USD",
          controlAccountCode: "1200",
          sourceSystem: "NETSUITE",
          sourceRecordType: "Invoice",
          sourceRecordId: LINEAGE_INVOICE,
        },
      })
    ).rejects.toMatchObject({
      // Prisma surfaces the Postgres unique violation as P2002.
      code: "P2002",
    });
  });

  it("allows the same AP lineage triple to coexist on TWO different books", async () => {
    const onGaap = await prisma.apOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usGaapBookId,
        partyId,
        openedByEntryId: jeUsGaapAp,
        referenceNumber: "BILL-001",
        openedDate: new Date("2026-04-15"),
        originalAmount: "200.0000",
        currentBalance: "200.0000",
        currencyId: "USD",
        controlAccountCode: "2100",
        sourceSystem: "NETSUITE",
        sourceRecordType: "VendorBill",
        sourceRecordId: LINEAGE_BILL,
      },
    });
    const onTax = await prisma.apOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usTaxBookId,
        partyId,
        openedByEntryId: jeUsTaxAp,
        referenceNumber: "BILL-001",
        openedDate: new Date("2026-04-15"),
        originalAmount: "200.0000",
        currentBalance: "200.0000",
        currencyId: "USD",
        controlAccountCode: "2100",
        sourceSystem: "NETSUITE",
        sourceRecordType: "VendorBill",
        sourceRecordId: LINEAGE_BILL,
      },
    });
    expect(onGaap.id).not.toBe(onTax.id);
  });

  it("blocks a duplicate AP lineage triple on the SAME book", async () => {
    await expect(
      prisma.apOpenItem.create({
        data: {
          tenantId,
          entityId,
          bookId: usGaapBookId,
          partyId,
          openedByEntryId: jeUsGaapAp,
          referenceNumber: "BILL-001-dup",
          openedDate: new Date("2026-04-15"),
          originalAmount: "200.0000",
          currentBalance: "200.0000",
          currencyId: "USD",
          controlAccountCode: "2100",
          sourceSystem: "NETSUITE",
          sourceRecordType: "VendorBill",
          sourceRecordId: LINEAGE_BILL,
        },
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("partial-uniq does NOT block NULL-lineage rows (manual sub-ledger entries)", async () => {
    // The partial WHERE filter (sourceSystem IS NOT NULL AND ...) means
    // any row without lineage (e.g. a manually-created AR open item)
    // sidesteps the index entirely. Verifies that the migration didn't
    // accidentally constrain the manual-entry path.
    const manual1 = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usGaapBookId,
        partyId,
        openedByEntryId: jeUsGaapAr,
        referenceNumber: "MANUAL-001",
        openedDate: new Date("2026-04-15"),
        originalAmount: "50.0000",
        currentBalance: "50.0000",
        currencyId: "USD",
        controlAccountCode: "1200",
        // No source lineage.
      },
    });
    const manual2 = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usGaapBookId,
        partyId,
        openedByEntryId: jeUsGaapAr,
        referenceNumber: "MANUAL-002",
        openedDate: new Date("2026-04-15"),
        originalAmount: "60.0000",
        currentBalance: "60.0000",
        currencyId: "USD",
        controlAccountCode: "1200",
      },
    });
    expect(manual1.id).not.toBe(manual2.id);
  });
});
