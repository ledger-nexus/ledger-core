// v0.9 NS Books Phase 3.5.D — cross-book application guard test.
//
// Proves applyArPayment + applyApPayment refuse to bind a payment-side
// JE on one book to an OpenItem on a different book, throwing
// CrossBookApplicationError with both book codes surfaced for operator
// triage.
//
// The NS importer's per-book sub-ledger loop (Phase 3.5.B) already
// matches book correctly via the per-book lookup map. This guard
// protects the OTHER callers — Server Actions, internal API, AI
// suggesters — that don't have the same loop structure and might
// inadvertently cross books on a hand-built apply.
//
// Same-book apply (the common case) is unchanged; verified here too
// so the guard isn't over-strict.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { applyArPayment } from "@/lib/accounting/sub-ledgers/ar";
import { applyApPayment } from "@/lib/accounting/sub-ledgers/ap";
import { CrossBookApplicationError } from "@/lib/accounting/types";

const prisma = new PrismaClient();

const TEST_ENTITY = "P35D_ENT";
const TEST_PARTY = "P35D_PARTY";

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
      entryNumber: `P35D-${bookCode}-${String(jeCounter).padStart(5, "0")}`,
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
    where: { tenantId, memo: { contains: "P35D" } },
  });
  await prisma.party.deleteMany({
    where: { tenantId, code: TEST_PARTY },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: TEST_ENTITY },
  });
}

describe("v0.9 NS Books Phase 3.5.D: cross-book application guard", () => {
  let tenantId: string;
  let entityId: string;
  let partyId: string;
  let usGaapBookId: string;
  let usTaxBookId: string;

  // The setup creates: an AR open item on US_GAAP, an AR open item on
  // US_TAX (same lineage), and a payment JE on EACH book. The
  // cross-book applies use the wrong-book payment JE; the same-book
  // applies use the matching-book one.
  let arOpenItemUsGaapId: string;
  let arOpenItemUsTaxId: string;
  let apOpenItemUsGaapId: string;
  let apOpenItemUsTaxId: string;
  let pmtJeUsGaapId: string;
  let pmtJeUsTaxId: string;

  beforeAll(async () => {
    await ensureFundamentals();
    await cleanup();
    tenantId = await getDefaultTenantId(prisma);
    const entity = await prisma.legalEntity.create({
      data: {
        tenantId,
        code: TEST_ENTITY,
        name: "P35D Test Entity",
        functionalCurrencyId: "USD",
      },
    });
    entityId = entity.id;
    const party = await prisma.party.create({
      data: {
        tenantId,
        entityId,
        code: TEST_PARTY,
        displayName: "P35D Test Party",
      },
    });
    partyId = party.id;
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

    // Invoice JEs (one per book).
    const invJeUsGaapId = await seedJe(tenantId, entityId, "US_GAAP", "P35D invoice JE US_GAAP");
    const invJeUsTaxId = await seedJe(tenantId, entityId, "US_TAX", "P35D invoice JE US_TAX");

    // Payment JEs (one per book) — what the apply call binds.
    pmtJeUsGaapId = await seedJe(tenantId, entityId, "US_GAAP", "P35D payment JE US_GAAP");
    pmtJeUsTaxId = await seedJe(tenantId, entityId, "US_TAX", "P35D payment JE US_TAX");

    // AR open items (one per book, same lineage triple).
    const arUsGaap = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usGaapBookId,
        partyId,
        openedByEntryId: invJeUsGaapId,
        referenceNumber: "P35D-INV-1",
        openedDate: new Date("2026-04-15"),
        originalAmount: "1000.0000",
        currentBalance: "1000.0000",
        currencyId: "USD",
        controlAccountCode: "1200",
        status: "OPEN",
      },
    });
    const arUsTax = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usTaxBookId,
        partyId,
        openedByEntryId: invJeUsTaxId,
        referenceNumber: "P35D-INV-1",
        openedDate: new Date("2026-04-15"),
        originalAmount: "1000.0000",
        currentBalance: "1000.0000",
        currencyId: "USD",
        controlAccountCode: "1200",
        status: "OPEN",
      },
    });
    arOpenItemUsGaapId = arUsGaap.id;
    arOpenItemUsTaxId = arUsTax.id;

    // AP open items (one per book, same lineage).
    const apUsGaap = await prisma.apOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usGaapBookId,
        partyId,
        openedByEntryId: invJeUsGaapId,
        referenceNumber: "P35D-BILL-1",
        openedDate: new Date("2026-04-15"),
        originalAmount: "500.0000",
        currentBalance: "500.0000",
        currencyId: "USD",
        controlAccountCode: "2100",
        status: "OPEN",
      },
    });
    const apUsTax = await prisma.apOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId: usTaxBookId,
        partyId,
        openedByEntryId: invJeUsTaxId,
        referenceNumber: "P35D-BILL-1",
        openedDate: new Date("2026-04-15"),
        originalAmount: "500.0000",
        currentBalance: "500.0000",
        currencyId: "USD",
        controlAccountCode: "2100",
        status: "OPEN",
      },
    });
    apOpenItemUsGaapId = apUsGaap.id;
    apOpenItemUsTaxId = apUsTax.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("applyArPayment rejects a US_GAAP payment binding to a US_TAX open item", async () => {
    await expect(
      applyArPayment(prisma, {
        openItemId: arOpenItemUsTaxId,           // US_TAX open item
        appliedByEntryId: pmtJeUsGaapId,         // US_GAAP payment JE
        appliedAmount: "1000.0000",
        appliedDate: new Date("2026-04-30"),
      })
    ).rejects.toThrow(CrossBookApplicationError);
  });

  it("applyArPayment same-book apply succeeds (guard isn't over-strict)", async () => {
    const r = await applyArPayment(prisma, {
      openItemId: arOpenItemUsGaapId,
      appliedByEntryId: pmtJeUsGaapId,
      appliedAmount: "1000.0000",
      appliedDate: new Date("2026-04-30"),
    });
    expect(r.status).toBe("APPLIED");
    expect(r.remainingBalance.toFixed(4)).toBe("0.0000");
  });

  it("applyApPayment rejects a US_TAX payment binding to a US_GAAP open item", async () => {
    await expect(
      applyApPayment(prisma, {
        openItemId: apOpenItemUsGaapId,          // US_GAAP open item
        appliedByEntryId: pmtJeUsTaxId,          // US_TAX payment JE
        appliedAmount: "500.0000",
        appliedDate: new Date("2026-04-30"),
      })
    ).rejects.toThrow(CrossBookApplicationError);
  });

  it("applyApPayment same-book apply succeeds (guard isn't over-strict)", async () => {
    const r = await applyApPayment(prisma, {
      openItemId: apOpenItemUsGaapId,
      appliedByEntryId: pmtJeUsGaapId,
      appliedAmount: "500.0000",
      appliedDate: new Date("2026-04-30"),
    });
    expect(r.status).toBe("APPLIED");
    expect(r.remainingBalance.toFixed(4)).toBe("0.0000");
  });

  it("CrossBookApplicationError surfaces both book codes for operator triage", async () => {
    let captured: CrossBookApplicationError | null = null;
    try {
      await applyArPayment(prisma, {
        openItemId: arOpenItemUsTaxId,
        appliedByEntryId: pmtJeUsGaapId,
        appliedAmount: "100.0000",
        appliedDate: new Date("2026-04-30"),
      });
    } catch (err) {
      if (err instanceof CrossBookApplicationError) captured = err;
    }
    expect(captured).not.toBeNull();
    expect(captured!.openItemBookCode).toBe("US_TAX");
    expect(captured!.appliedByEntryBookCode).toBe("US_GAAP");
    expect(captured!.message).toContain("US_GAAP");
    expect(captured!.message).toContain("US_TAX");
  });
});
