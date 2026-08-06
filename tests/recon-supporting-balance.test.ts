// BlackLine arc — Phase 1 PR 7 tests.
//
// Pins the sub-ledger auto-pull contract for the supporting-balance
// resolver. One test per sub-ledger path:
//
//   AR control account  → sum of open ArOpenItem.currentBalance
//   AP control account  → sum of open ApOpenItem.currentBalance
//   Fixed-asset cost    → sum of (acquisitionCost − accumulatedDepreciation)
//                         for IN_SERVICE / IDLE / HELD_FOR_SALE assets
//   Otherwise           → {source: null, amount: null}
//
// Plus cross-tenant isolation: an account from another tenant returns
// null (no leak) — tested by the AR path with a tenantId mismatch.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";

import { resolveSupportingBalance } from "@/lib/recon/supporting-balance";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const PREFIX = "SB";
const STAMP = Date.now().toString(36).toUpperCase();

let tenantId: string;
let entityId: string;
let bookId: string;
const asOf = new Date("2026-06-30");

// IDs we mint so afterAll can wipe them cleanly without leaking.
const created: {
  accounts: string[];
  parties: string[];
  arItems: string[];
  apItems: string[];
  fixedAssets: string[];
  journalEntries: string[];
} = {
  accounts: [],
  parties: [],
  arItems: [],
  apItems: [],
  fixedAssets: [],
  journalEntries: [],
};

beforeAll(async () => {
  tenantId = await getDefaultTenantId(prisma);

  // Use Northwind's existing entity + US_GAAP book to avoid the
  // full bootstrap.
  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId, code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) throw new Error("Run Northwind seed first.");
  entityId = entity.id;

  const book = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!book) throw new Error("Missing US_GAAP book");
  bookId = book.id;
});

afterAll(async () => {
  // Wipe in reverse-FK order.
  await prisma.arOpenItem.deleteMany({
    where: { id: { in: created.arItems } },
  });
  await prisma.apOpenItem.deleteMany({
    where: { id: { in: created.apItems } },
  });
  await prisma.fixedAssetBookAttributes.deleteMany({
    where: { assetId: { in: created.fixedAssets } },
  });
  await prisma.fixedAsset.deleteMany({
    where: { id: { in: created.fixedAssets } },
  });
  await prisma.journalLine.deleteMany({
    where: { entryId: { in: created.journalEntries } },
  });
  await prisma.journalEntry.deleteMany({
    where: { id: { in: created.journalEntries } },
  });
  await prisma.account.deleteMany({
    where: { id: { in: created.accounts } },
  });
  await prisma.party.deleteMany({
    where: { id: { in: created.parties } },
  });
  await prisma.$disconnect();
});

async function mintAccount(opts: {
  code: string;
  type: "ASSET" | "LIABILITY" | "EQUITY";
  isControlAccount?: boolean;
}): Promise<string> {
  const a = await prisma.account.create({
    data: {
      tenantId,
      code: opts.code,
      name: `${opts.code} test`,
      type: opts.type,
      normalBalance: opts.type === "ASSET" ? "DEBIT" : "CREDIT",
      isControlAccount: opts.isControlAccount ?? false,
    },
    select: { id: true },
  });
  created.accounts.push(a.id);
  return a.id;
}

async function mintParty(suffix: string): Promise<string> {
  const p = await prisma.party.create({
    data: {
      tenantId,
      code: `${PREFIX}P_${STAMP}_${suffix}`.slice(0, 50),
      displayName: `Party ${suffix}`,
    },
    select: { id: true },
  });
  created.parties.push(p.id);
  return p.id;
}

// Helper: create a stub JournalEntry to serve as the "openedByEntry" FK
// for AR/AP open items. We don't post it through postJournalEntry —
// these tests target the resolver, not the GL.
async function stubJournalEntry(): Promise<string> {
  // Need a period — reuse whatever's seeded.
  const period = await prisma.period.findFirst({
    where: { calendar: { entityId } },
    select: { id: true },
  });
  if (!period) throw new Error("Need a period for the stub JE");
  const je = await prisma.journalEntry.create({
    data: {
      tenantId,
      entityId,
      bookId,
      periodId: period.id,
      documentDate: new Date("2026-06-15"),
      postingDate: new Date("2026-06-15"),
      currencyId: "USD",
      memo: `${PREFIX} stub`,
      status: "POSTED",
      source: "MANUAL",
      entryNumber: `${PREFIX}-${STAMP}-${created.journalEntries.length}`.slice(0, 30),
    },
    select: { id: true },
  });
  created.journalEntries.push(je.id);
  return je.id;
}

describe("resolveSupportingBalance — sub-ledger auto-pull", () => {
  it("AR control account → sum of open ArOpenItem.currentBalance", async () => {
    const arCode = `${PREFIX}_1200_${STAMP}`.slice(0, 20);
    const arAccountId = await mintAccount({
      code: arCode,
      type: "ASSET",
      isControlAccount: true,
    });
    const partyA = await mintParty("A");
    const partyB = await mintParty("B");
    const stubEntry1 = await stubJournalEntry();
    const stubEntry2 = await stubJournalEntry();
    const stubEntry3 = await stubJournalEntry();

    // 3 open items: 100, 250.50, 1000. One APPLIED (should be excluded).
    const i1 = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId,
        partyId: partyA,
        openedByEntryId: stubEntry1,
        openedDate: new Date("2026-06-01"),
        originalAmount: "100.00" as never,
        currentBalance: "100.00" as never,
        currencyId: "USD",
        status: "OPEN",
        controlAccountCode: arCode,
      },
      select: { id: true },
    });
    const i2 = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId,
        partyId: partyB,
        openedByEntryId: stubEntry2,
        openedDate: new Date("2026-06-15"),
        originalAmount: "500.00" as never,
        currentBalance: "250.50" as never,
        currencyId: "USD",
        status: "PARTIAL",
        controlAccountCode: arCode,
      },
      select: { id: true },
    });
    const i3 = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId,
        partyId: partyA,
        openedByEntryId: stubEntry3,
        openedDate: new Date("2026-06-20"),
        originalAmount: "1000.00" as never,
        currentBalance: "1000.00" as never,
        currencyId: "USD",
        status: "OPEN",
        controlAccountCode: arCode,
      },
      select: { id: true },
    });
    // Applied item — must NOT count.
    const stubEntry4 = await stubJournalEntry();
    const iApplied = await prisma.arOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId,
        partyId: partyA,
        openedByEntryId: stubEntry4,
        openedDate: new Date("2026-06-25"),
        originalAmount: "9999.00" as never,
        currentBalance: "0.00" as never,
        currencyId: "USD",
        status: "APPLIED",
        controlAccountCode: arCode,
      },
      select: { id: true },
    });
    created.arItems.push(i1.id, i2.id, i3.id, iApplied.id);

    const result = await resolveSupportingBalance(prisma, {
      tenantId,
      entityId,
      bookId,
      accountId: arAccountId,
      asOf,
    });
    expect(result.source).toBe("AR_SUBLEDGER");
    expect(result.amount).not.toBeNull();
    // 100 + 250.50 + 1000 = 1350.50 (APPLIED excluded)
    expect(result.amount!.toString()).toBe("1350.5");
    expect(result.label).toContain("3 open items");
  });

  it("AP control account → sum of open ApOpenItem.currentBalance", async () => {
    const apCode = `${PREFIX}_2000_${STAMP}`.slice(0, 20);
    const apAccountId = await mintAccount({
      code: apCode,
      type: "LIABILITY",
      isControlAccount: true,
    });
    const vendor = await mintParty("V");
    const stubEntry = await stubJournalEntry();

    const i1 = await prisma.apOpenItem.create({
      data: {
        tenantId,
        entityId,
        bookId,
        partyId: vendor,
        openedByEntryId: stubEntry,
        openedDate: new Date("2026-06-10"),
        originalAmount: "500.00" as never,
        currentBalance: "500.00" as never,
        currencyId: "USD",
        status: "OPEN",
        controlAccountCode: apCode,
      },
      select: { id: true },
    });
    created.apItems.push(i1.id);

    const result = await resolveSupportingBalance(prisma, {
      tenantId,
      entityId,
      bookId,
      accountId: apAccountId,
      asOf,
    });
    expect(result.source).toBe("AP_SUBLEDGER");
    expect(result.amount!.toString()).toBe("500");
    expect(result.label).toContain("1 open item");
  });

  it("Fixed-asset cost account → sum of NBV (cost − accum. dep.)", async () => {
    const faCode = `${PREFIX}_1500_${STAMP}`.slice(0, 20);
    const faAccountId = await mintAccount({
      code: faCode,
      type: "ASSET",
    });

    // Asset 1: cost 10000, accum. dep. 2000 → NBV 8000
    const a1 = await prisma.fixedAsset.create({
      data: {
        tenantId,
        entityId,
        code: `${PREFIX}_L_${STAMP}_1`.slice(0, 30),
        description: "Laptop 1",
        acquisitionDate: new Date("2026-01-01"),
        acquisitionCost: "10000.00" as never,
        acquisitionCurrencyId: "USD",
        status: "IN_SERVICE",
        assetAccountCode: faCode,
        bookAttributes: {
          create: [
            {
              bookId,
              usefulLifeMonths: 36,
              depreciationMethod: "STRAIGHT_LINE",
              inServiceDate: new Date("2026-01-01"),
              salvageValue: "0" as never,
              accumulatedDepreciation: "2000.00" as never,
              depreciationExpenseAccountCode: "6300",
              accumDepreciationAccountCode: "1510",
            },
          ],
        },
      },
      select: { id: true },
    });
    // Asset 2: cost 5000, no book attrs row → NBV 5000 (full cost)
    const a2 = await prisma.fixedAsset.create({
      data: {
        tenantId,
        entityId,
        code: `${PREFIX}_L_${STAMP}_2`.slice(0, 30),
        description: "Laptop 2",
        acquisitionDate: new Date("2026-05-01"),
        acquisitionCost: "5000.00" as never,
        acquisitionCurrencyId: "USD",
        status: "IDLE",
        assetAccountCode: faCode,
      },
      select: { id: true },
    });
    // Asset 3: DISPOSED — must NOT count (off the BS).
    const a3 = await prisma.fixedAsset.create({
      data: {
        tenantId,
        entityId,
        code: `${PREFIX}_L_${STAMP}_3`.slice(0, 30),
        description: "Laptop 3 (disposed)",
        acquisitionDate: new Date("2026-02-01"),
        acquisitionCost: "9999.00" as never,
        acquisitionCurrencyId: "USD",
        status: "DISPOSED",
        disposalDate: new Date("2026-04-15"),
        assetAccountCode: faCode,
      },
      select: { id: true },
    });
    created.fixedAssets.push(a1.id, a2.id, a3.id);

    const result = await resolveSupportingBalance(prisma, {
      tenantId,
      entityId,
      bookId,
      accountId: faAccountId,
      asOf,
    });
    expect(result.source).toBe("FIXED_ASSET_REGISTER");
    // 8000 + 5000 = 13000 (DISPOSED excluded)
    expect(result.amount!.toString()).toBe("13000");
    expect(result.label).toContain("2 asset");
  });

  it("Non-control ASSET account without FA linkage → null", async () => {
    const cashCode = `${PREFIX}_1000_${STAMP}`.slice(0, 20);
    const cashId = await mintAccount({
      code: cashCode,
      type: "ASSET",
      isControlAccount: false,
    });
    const result = await resolveSupportingBalance(prisma, {
      tenantId,
      entityId,
      bookId,
      accountId: cashId,
      asOf,
    });
    expect(result.source).toBeNull();
    expect(result.amount).toBeNull();
  });

  it("EQUITY account → null (no sub-ledger linkage)", async () => {
    const eqCode = `${PREFIX}_3000_${STAMP}`.slice(0, 20);
    const eqId = await mintAccount({
      code: eqCode,
      type: "EQUITY",
    });
    const result = await resolveSupportingBalance(prisma, {
      tenantId,
      entityId,
      bookId,
      accountId: eqId,
      asOf,
    });
    expect(result.source).toBeNull();
    expect(result.amount).toBeNull();
  });

  it("Cross-tenant: account in another tenant returns null", async () => {
    const arCode = `${PREFIX}_1201_${STAMP}`.slice(0, 20);
    const arAccountId = await mintAccount({
      code: arCode,
      type: "ASSET",
      isControlAccount: true,
    });
    const fakeTenantId = "00000000-0000-0000-0000-000000000099";
    const result = await resolveSupportingBalance(prisma, {
      tenantId: fakeTenantId,
      entityId,
      bookId,
      accountId: arAccountId,
      asOf,
    });
    expect(result.source).toBeNull();
    expect(result.amount).toBeNull();
  });
});
