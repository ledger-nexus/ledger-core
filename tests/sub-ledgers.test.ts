// Sub-ledger lifecycle + multi-book divergence + book-tax-diff invariants.
//
// Run with: pnpm test (or: pnpm test tests/sub-ledgers.test.ts)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { getTrialBalance, getBalanceSheet } from "../src/lib/accounting/reports";
import {
  openArItem,
  applyArPayment,
  openArBalance,
} from "../src/lib/accounting/sub-ledgers/ar";
import {
  openApItem,
  applyApPayment,
  openApBalance,
} from "../src/lib/accounting/sub-ledgers/ap";
import {
  createFixedAsset,
  runDepreciation,
  netBookValue,
} from "../src/lib/accounting/sub-ledgers/fixed-assets";
import { getBookTaxDifference } from "../src/lib/accounting/reports/book-tax-difference";
import { CHART_OF_ACCOUNTS } from "../src/lib/db/chart-of-accounts";

const prisma = new PrismaClient();
const ENTITY = "SUBLEDGER_TEST";

async function clearAll() {
  await prisma.arApplication.deleteMany();
  await prisma.apApplication.deleteMany();
  await prisma.arOpenItem.deleteMany();
  await prisma.apOpenItem.deleteMany();
  await prisma.fixedAssetBookAttributes.deleteMany();
  await prisma.fixedAsset.deleteMany();
  await prisma.leaseBookAttributes.deleteMany();
  await prisma.lease.deleteMany();
  await prisma.revenueContractBookAttributes.deleteMany();
  await prisma.performanceObligation.deleteMany();
  await prisma.revenueContract.deleteMany();
  await prisma.journalLine.deleteMany();
  await prisma.journalEntry.deleteMany();
}

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY } },
    create: { tenantId, code: ENTITY, name: "Sub-ledger Test Co.", functionalCurrencyId: "USD" },
    update: { tenantId },
  });
  for (const b of [
    { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP" as const },
    { code: "US_TAX", name: "US Federal Tax", basis: "US_TAX" as const },
    { code: "IFRS", name: "IFRS", basis: "IFRS" as const },
  ]) {
    await prisma.book.upsert({
      where: { code: b.code },
      create: { code: b.code, name: b.name, basis: b.basis, reportingCurrencyId: "USD" },
      update: {},
    });
  }
  const calendar = await prisma.fiscalCalendar.upsert({
    where: { entityId_code: { entityId: entity.id, code: "STANDARD_2026" } },
    create: {
      tenantId: tenantId,
      entityId: entity.id,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    update: {},
  });
  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        tenantId: tenantId,
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: {},
    });
  }
  // Prisma 5.22 rejects null in compound unique-key upsert. Use
  // findFirst + create to upsert shared-chart accounts (entityId=null).
  for (const a of CHART_OF_ACCOUNTS) {
    const existing = await prisma.account.findFirst({
      where: { entityId: null, code: a.code },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.account.create({
      data: {
        tenantId: tenantId,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
        isControlAccount: a.isControlAccount ?? false,
        isBank: a.isBank ?? false,
        subtype: a.subtype,
      },
    });
  }
  // Parties used by sub-ledger lifecycle tests.
  for (const p of [
    { code: "CUSTOMER_X", displayName: "Customer X", role: "CUSTOMER" as const },
    { code: "VENDOR_Y", displayName: "Vendor Y", role: "VENDOR" as const },
  ]) {
    const party = await prisma.party.upsert({
      where: { entityId_code: { entityId: entity.id, code: p.code } },
      create: { tenantId, entityId: entity.id, code: p.code, displayName: p.displayName },
      update: { tenantId },
    });
    await prisma.partyRole.upsert({
      where: { partyId_role: { partyId: party.id, role: p.role } },
      create: { tenantId, partyId: party.id, role: p.role },
      update: { tenantId },
    });
  }
}

beforeAll(async () => {
  await seedMasterData();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearAll();
});

const GAAP = { entityCode: ENTITY, bookCode: "US_GAAP" };
const TAX = { entityCode: ENTITY, bookCode: "US_TAX" };

// =========================================================================
// AR open-item lifecycle
// =========================================================================

describe("AR sub-ledger: open-item lifecycle", () => {
  it("invoice opens an AR item; sum of open items equals AR control account balance", async () => {
    // Post the invoice JE first.
    const invoice = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-15"),
      memo: "Invoice — Customer X",
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 1_000, partyCode: "CUSTOMER_X" },
        { accountCode: "4000", credit: 1_000 },
      ],
    });
    const item = await openArItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "CUSTOMER_X",
      openedByEntryId: invoice.id,
      openedDate: new Date("2026-01-15"),
      amount: 1_000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });
    expect(item.id).toBeTruthy();

    const openBal = await openArBalance(prisma, ENTITY, "US_GAAP");
    expect(openBal.equals(new Decimal(1_000))).toBe(true);

    // AR control account balance from the BS should match.
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-01-31"));
    const arRow = bs.assets.find((a) => a.code === "1200");
    expect(arRow).toBeDefined();
    expect(arRow!.amount.equals(new Decimal(1_000))).toBe(true);
    expect(openBal.equals(arRow!.amount)).toBe(true);
  });

  it("partial payment moves item to PARTIAL; remaining balance ties to AR control", async () => {
    const invoice = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-15"),
      memo: "Invoice — Customer X",
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 1_000, partyCode: "CUSTOMER_X" },
        { accountCode: "4000", credit: 1_000 },
      ],
    });
    const item = await openArItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "CUSTOMER_X",
      openedByEntryId: invoice.id,
      openedDate: new Date("2026-01-15"),
      amount: 1_000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });

    const payment = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-01"),
      memo: "Partial payment",
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 400 },
        { accountCode: "1200", credit: 400, partyCode: "CUSTOMER_X" },
      ],
    });
    const applied = await applyArPayment(prisma, {
      openItemId: item.id,
      appliedByEntryId: payment.id,
      appliedAmount: 400,
      appliedDate: new Date("2026-02-01"),
    });
    expect(applied.status).toBe("PARTIAL");
    expect(applied.remainingBalance.equals(new Decimal(600))).toBe(true);

    const openBal = await openArBalance(prisma, ENTITY, "US_GAAP");
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-02-28"));
    const arRow = bs.assets.find((a) => a.code === "1200");
    expect(openBal.equals(arRow!.amount)).toBe(true);
    expect(openBal.equals(new Decimal(600))).toBe(true);
  });

  it("full payment moves item to APPLIED and reduces AR to zero", async () => {
    const invoice = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-15"),
      memo: "Invoice — Customer X",
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 1_000, partyCode: "CUSTOMER_X" },
        { accountCode: "4000", credit: 1_000 },
      ],
    });
    const item = await openArItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "CUSTOMER_X",
      openedByEntryId: invoice.id,
      openedDate: new Date("2026-01-15"),
      amount: 1_000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });
    const payment = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-01"),
      memo: "Full payment",
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 1_000 },
        { accountCode: "1200", credit: 1_000, partyCode: "CUSTOMER_X" },
      ],
    });
    const applied = await applyArPayment(prisma, {
      openItemId: item.id,
      appliedByEntryId: payment.id,
      appliedAmount: 1_000,
      appliedDate: new Date("2026-02-01"),
    });
    expect(applied.status).toBe("APPLIED");
    expect(applied.remainingBalance.equals(new Decimal(0))).toBe(true);

    const openBal = await openArBalance(prisma, ENTITY, "US_GAAP");
    expect(openBal.equals(new Decimal(0))).toBe(true);
  });

  it("rejects over-payment against an open item", async () => {
    const invoice = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-15"),
      memo: "Invoice",
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 500, partyCode: "CUSTOMER_X" },
        { accountCode: "4000", credit: 500 },
      ],
    });
    const item = await openArItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "CUSTOMER_X",
      openedByEntryId: invoice.id,
      openedDate: new Date("2026-01-15"),
      amount: 500,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });
    const payment = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-01"),
      memo: "Overpayment attempt",
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 1_000 },
        { accountCode: "1200", credit: 1_000, partyCode: "CUSTOMER_X" },
      ],
    });
    await expect(
      applyArPayment(prisma, {
        openItemId: item.id,
        appliedByEntryId: payment.id,
        appliedAmount: 1_000,
        appliedDate: new Date("2026-02-01"),
      })
    ).rejects.toThrow(/exceeds open balance/);
  });
});

// =========================================================================
// AP open-item lifecycle (mirror of AR)
// =========================================================================

describe("AP sub-ledger: open-item lifecycle", () => {
  it("bill opens an AP item; sum of open items equals AP control account balance", async () => {
    const bill = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-04-10"),
      memo: "Bill — Vendor Y",
      source: "SEED",
      lines: [
        { accountCode: "7200", debit: 2_000 },
        { accountCode: "2000", credit: 2_000, partyCode: "VENDOR_Y" },
      ],
    });
    const item = await openApItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "VENDOR_Y",
      openedByEntryId: bill.id,
      openedDate: new Date("2026-04-10"),
      amount: 2_000,
      currencyCode: "USD",
      controlAccountCode: "2000",
    });
    expect(item.id).toBeTruthy();

    const openBal = await openApBalance(prisma, ENTITY, "US_GAAP");
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-04-30"));
    const apRow = bs.liabilities.find((l) => l.code === "2000");
    expect(apRow).toBeDefined();
    expect(openBal.equals(apRow!.amount)).toBe(true);
    expect(openBal.equals(new Decimal(2_000))).toBe(true);
  });

  it("payment closes the AP item and reduces AP to zero", async () => {
    const bill = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-04-10"),
      memo: "Bill",
      source: "SEED",
      lines: [
        { accountCode: "7200", debit: 2_000 },
        { accountCode: "2000", credit: 2_000, partyCode: "VENDOR_Y" },
      ],
    });
    const item = await openApItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "VENDOR_Y",
      openedByEntryId: bill.id,
      openedDate: new Date("2026-04-10"),
      amount: 2_000,
      currencyCode: "USD",
      controlAccountCode: "2000",
    });
    const payment = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-05-01"),
      memo: "Payment",
      source: "SEED",
      lines: [
        { accountCode: "2000", debit: 2_000, partyCode: "VENDOR_Y" },
        { accountCode: "1000", credit: 2_000 },
      ],
    });
    const applied = await applyApPayment(prisma, {
      openItemId: item.id,
      appliedByEntryId: payment.id,
      appliedAmount: 2_000,
      appliedDate: new Date("2026-05-01"),
    });
    expect(applied.status).toBe("APPLIED");

    const openBal = await openApBalance(prisma, ENTITY, "US_GAAP");
    expect(openBal.equals(new Decimal(0))).toBe(true);
  });
});

// =========================================================================
// Fixed assets — multi-book divergent depreciation
// =========================================================================

describe("Fixed assets: divergent depreciation across books", () => {
  it("GAAP 36-mo SL vs US_TAX 60-mo SL produces a clear temporary difference", async () => {
    // Acquire asset — same in all books.
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-05"),
      memo: "Buy asset",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 24_000 },
        { accountCode: "1000", credit: 24_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...TAX,
      documentDate: new Date("2026-01-05"),
      memo: "Buy asset",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 24_000 },
        { accountCode: "1000", credit: 24_000 },
      ],
    });

    await createFixedAsset(prisma, {
      entityCode: ENTITY,
      code: "A1",
      description: "Test asset",
      acquisitionDate: new Date("2026-01-05"),
      acquisitionCost: 24_000,
      acquisitionCurrencyCode: "USD",
      assetAccountCode: "1500",
      books: [
        {
          bookCode: "US_GAAP",
          usefulLifeMonths: 36,
          method: "STRAIGHT_LINE",
          inServiceDate: new Date("2026-01-05"),
          depreciationExpenseAccountCode: "8000",
          accumDepreciationAccountCode: "1510",
        },
        {
          bookCode: "US_TAX",
          usefulLifeMonths: 60,
          method: "STRAIGHT_LINE",
          inServiceDate: new Date("2026-01-05"),
          depreciationExpenseAccountCode: "8000",
          accumDepreciationAccountCode: "1510",
        },
      ],
    });

    await runDepreciation(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      throughDate: new Date("2026-06-30"),
      source: "SEED",
    });
    await runDepreciation(prisma, {
      entityCode: ENTITY,
      bookCode: "US_TAX",
      throughDate: new Date("2026-06-30"),
      source: "SEED",
    });

    // Net book value after 6 months: GAAP = 24000 - (24000/36*6) = 24000 - 4000 = 20000.
    // TAX = 24000 - (24000/60*6) = 24000 - 2400 = 21600.
    const gaapNbv = await netBookValue(prisma, ENTITY, "US_GAAP");
    const taxNbv = await netBookValue(prisma, ENTITY, "US_TAX");

    expect(gaapNbv.nbv.toFixed(2)).toBe("20000.00");
    expect(taxNbv.nbv.toFixed(2)).toBe("21600.00");
    expect(taxNbv.nbv.minus(gaapNbv.nbv).toFixed(2)).toBe("1600.00");
  });

  it("running depreciation twice through the same date is idempotent", async () => {
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-05"),
      memo: "Buy",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 6_000 },
        { accountCode: "1000", credit: 6_000 },
      ],
    });
    await createFixedAsset(prisma, {
      entityCode: ENTITY,
      code: "A2",
      description: "Test",
      acquisitionDate: new Date("2026-01-05"),
      acquisitionCost: 6_000,
      acquisitionCurrencyCode: "USD",
      assetAccountCode: "1500",
      books: [
        {
          bookCode: "US_GAAP",
          usefulLifeMonths: 12,
          method: "STRAIGHT_LINE",
          inServiceDate: new Date("2026-01-05"),
          depreciationExpenseAccountCode: "8000",
          accumDepreciationAccountCode: "1510",
        },
      ],
    });
    const firstRun = await runDepreciation(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      throughDate: new Date("2026-03-31"),
      source: "SEED",
    });
    // 3 months @ $500/mo = $1,500
    expect(firstRun.totalDepreciation.equals(new Decimal(1_500))).toBe(true);

    // Running again through the SAME date should post nothing.
    const secondRun = await runDepreciation(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      throughDate: new Date("2026-03-31"),
      source: "SEED",
    });
    expect(secondRun.entriesPosted).toBe(0);
    expect(secondRun.totalDepreciation.equals(new Decimal(0))).toBe(true);

    // Running through a later date posts just the incremental months.
    const thirdRun = await runDepreciation(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      throughDate: new Date("2026-06-30"),
      source: "SEED",
    });
    expect(thirdRun.totalDepreciation.equals(new Decimal(1_500))).toBe(true);
  });
});

// =========================================================================
// Book-tax-difference report
// =========================================================================

describe("Book-tax-difference report", () => {
  it("surfaces depreciation as a TEMPORARY difference", async () => {
    // Acquire $12k asset, GAAP 36-mo SL ($333/mo), TAX 60-mo SL ($200/mo).
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-05"),
      memo: "Buy",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 12_000 },
        { accountCode: "3100", credit: 12_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...TAX,
      documentDate: new Date("2026-01-05"),
      memo: "Buy",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 12_000 },
        { accountCode: "3100", credit: 12_000 },
      ],
    });
    await createFixedAsset(prisma, {
      entityCode: ENTITY,
      code: "A3",
      description: "Test",
      acquisitionDate: new Date("2026-01-05"),
      acquisitionCost: 12_000,
      acquisitionCurrencyCode: "USD",
      assetAccountCode: "1500",
      books: [
        {
          bookCode: "US_GAAP",
          usefulLifeMonths: 36,
          method: "STRAIGHT_LINE",
          inServiceDate: new Date("2026-01-05"),
          depreciationExpenseAccountCode: "8000",
          accumDepreciationAccountCode: "1510",
        },
        {
          bookCode: "US_TAX",
          usefulLifeMonths: 60,
          method: "STRAIGHT_LINE",
          inServiceDate: new Date("2026-01-05"),
          depreciationExpenseAccountCode: "8000",
          accumDepreciationAccountCode: "1510",
        },
      ],
    });
    await runDepreciation(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      throughDate: new Date("2026-06-30"),
      source: "SEED",
    });
    await runDepreciation(prisma, {
      entityCode: ENTITY,
      bookCode: "US_TAX",
      throughDate: new Date("2026-06-30"),
      source: "SEED",
    });

    const btd = await getBookTaxDifference(prisma, {
      entityCode: ENTITY,
      fromBookCode: "US_GAAP",
      toBookCode: "US_TAX",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-06-30"),
    });

    // Depreciation expense delta: GAAP $2,000 (=12000/36*6) vs TAX $1,200 (=12000/60*6).
    // GAAP P&L = -$2,000 (expense). TAX P&L = -$1,200 (expense).
    // bookNetIncome = -2000, taxNetIncome = -1200.
    // totalDelta = bookNetIncome - taxNetIncome = -800.
    expect(btd.bookNetIncome.toFixed(2)).toBe("-2000.00");
    expect(btd.taxNetIncome.toFixed(2)).toBe("-1200.00");
    expect(btd.totalDelta.toFixed(2)).toBe("-800.00");

    // The depreciation expense row should be present and classified TEMPORARY.
    const depRow = btd.pnlRows.find((r) => r.accountCode === "8000");
    expect(depRow).toBeDefined();
    expect(depRow!.classification).toBe("TEMPORARY");
  });
});
