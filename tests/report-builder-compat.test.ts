// Report Builder PR 5 — Compatibility shim equivalence proof.
//
// THE POINT: shim outputs from `getIncomeStatementViaBuilder` and
// `getBalanceSheetViaBuilder` must be DECIMAL-IDENTICAL to the
// hand-coded `getIncomeStatement` / `getBalanceSheet`. This is the gate
// for trusting PR 6 to swap the UI pages over to the builder path.
//
// FIXTURE: a small Q1 2026 entity with one of every classic GAAP event:
//   - Capital contribution (Common Stock 3000)
//   - Revenue (4000)
//   - COGS (5000)
//   - OpEx (6000)
//   - Income tax (9000)
//   - A liability movement (AP 2000)
//
// Then assert per-row equality across both APIs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import {
  getIncomeStatement,
  getBalanceSheet,
  type IncomeStatement,
  type BalanceSheet,
} from "@/lib/accounting/reports";
import {
  getIncomeStatementViaBuilder,
  getBalanceSheetViaBuilder,
} from "@/lib/accounting/reports/builder/compat";

const prisma = new PrismaClient();

const PREFIX = "RPTX"; // ReportBuilder compat (X for compat)
const ENT_CODE = `${PREFIX}_E1_${Date.now().toString(36)}`;
const BOOK_CODE = "US_GAAP";

let tenantId: string;
let entityId: string;

async function ensureFixture(): Promise<void> {
  tenantId = await getDefaultTenantId(prisma);
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: { code: BOOK_CODE, name: BOOK_CODE, basis: BOOK_CODE, reportingCurrencyId: "USD" },
    update: {},
  });
  const e = await prisma.legalEntity.create({
    data: { tenantId, code: ENT_CODE, name: ENT_CODE, functionalCurrencyId: "USD" },
  });
  entityId = e.id;
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId: e.id,
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

  // Account 9000 (Income Tax Expense) isn't in the default chart — the
  // IS template's `tax` row uses `includeCodes: ["9000"]`. Create it
  // tenant-scoped (entityId null = shared chart) so this test exercises
  // that row of the template. Idempotent under repeated test runs via
  // findFirst guard.
  const existing9000 = await prisma.account.findFirst({
    where: { tenantId, code: "9000", entityId: null },
  });
  if (!existing9000) {
    await prisma.account.create({
      data: {
        tenantId,
        code: "9000",
        name: "Income Tax Expense",
        type: "EXPENSE",
        normalBalance: "DEBIT",
      },
    });
  }

  // Q1 2026:
  //   Jan: $20,000 Common Stock contribution (Dr Cash, Cr 3000)
  //   Feb: $8,000 revenue paid in cash (Dr Cash, Cr 4000)
  //   Feb: $3,000 COGS (Dr 5000, Cr Cash)
  //   Mar: $1,500 OpEx paid (Dr 6000, Cr Cash)
  //   Mar: $400 income tax accrued (Dr 9000, Cr 2000 AP)
  //
  // Expected at March 31, 2026:
  //   Revenue:       $8,000
  //   COGS:          $3,000
  //   OpEx:          $1,500
  //   Tax:           $  400
  //   Net Income:    $3,100
  //
  //   Cash:          $20,000 + 8,000 - 3,000 - 1,500 = $23,500
  //   AP:            $   400
  //   Common Stock:  $20,000
  //   Retained:      $ 3,100
  //   Total Assets:  $23,500
  //   Total L+E:     $400 + $20,000 + $3,100 = $23,500  ✓ balances

  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-01-05"),
    memo: "Capital contribution",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 20000, credit: 0 },
      { accountCode: "3000", debit: 0, credit: 20000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-02-10"),
    memo: "Revenue",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 8000, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 8000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-02-12"),
    memo: "COGS",
    source: "MANUAL",
    lines: [
      { accountCode: "5000", debit: 3000, credit: 0 },
      { accountCode: "1000", debit: 0, credit: 3000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-03-05"),
    memo: "OpEx",
    source: "MANUAL",
    lines: [
      { accountCode: "6000", debit: 1500, credit: 0 },
      { accountCode: "1000", debit: 0, credit: 1500 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-03-25"),
    memo: "Tax accrual",
    source: "MANUAL",
    lines: [
      { accountCode: "9000", debit: 400, credit: 0 },
      { accountCode: "2000", debit: 0, credit: 400 },
    ],
  });
}

async function cleanup(): Promise<void> {
  if (!entityId) return;
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  const cals = await prisma.fiscalCalendar.findMany({
    where: { entityId },
    select: { id: true },
  });
  await prisma.period.deleteMany({ where: { calendarId: { in: cals.map((c) => c.id) } } });
  await prisma.fiscalCalendar.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
}

// ---- Comparators ---------------------------------------------------

function decimalEqual(a: Decimal, b: Decimal, hint: string): void {
  if (!a.equals(b)) {
    throw new Error(`${hint}: legacy=${a.toString()} builder=${b.toString()}`);
  }
}

// NOTE: per-row amount equivalence is the gate. Names / parentCode /
// isContra are NOT compared because the legacy `getBalanceSheet` /
// `getIncomeStatement` query does NOT tenant-scope the Account lookup
// (it filters by entityId only), while the builder's
// `getAccountBalances` DOES tenant-scope. In a shared test DB where
// other tenants have seeded a `code: "1500"` row with a different
// `name`, legacy picks the cross-tenant row's metadata while builder
// picks this tenant's. Balances still agree because journal lines are
// entity-scoped — the postings only hit this tenant's account_id.
// Closing the legacy tenant-scoping gap is a follow-up; this shim
// already inherits the correct behavior via `getAccountBalances`.
function compareISRows(
  legacy: IncomeStatement,
  builder: IncomeStatement
): void {
  expect(builder.revenue.length).toBe(legacy.revenue.length);
  expect(builder.expenses.length).toBe(legacy.expenses.length);

  const legacyRev = new Map(legacy.revenue.map((r) => [r.code, r]));
  for (const b of builder.revenue) {
    const l = legacyRev.get(b.code);
    expect(l, `Builder revenue row ${b.code} has no legacy counterpart`).toBeDefined();
    decimalEqual(l!.amount, b.amount, `IS revenue ${b.code}.amount`);
  }
  const legacyExp = new Map(legacy.expenses.map((r) => [r.code, r]));
  for (const b of builder.expenses) {
    const l = legacyExp.get(b.code);
    expect(l, `Builder expense row ${b.code} has no legacy counterpart`).toBeDefined();
    decimalEqual(l!.amount, b.amount, `IS expense ${b.code}.amount`);
  }
}

function compareBSRows(legacy: BalanceSheet, builder: BalanceSheet): void {
  expect(builder.assets.length).toBe(legacy.assets.length);
  expect(builder.liabilities.length).toBe(legacy.liabilities.length);
  expect(builder.equity.length).toBe(legacy.equity.length);

  const compareSection = (
    legacyRows: BalanceSheet["assets"],
    builderRows: BalanceSheet["assets"],
    section: string
  ): void => {
    const legacyByCode = new Map(legacyRows.map((r) => [r.code, r]));
    for (const b of builderRows) {
      const l = legacyByCode.get(b.code);
      expect(l, `Builder ${section} row ${b.code} has no legacy counterpart`).toBeDefined();
      decimalEqual(l!.amount, b.amount, `BS ${section} ${b.code}.amount`);
    }
  };
  compareSection(legacy.assets, builder.assets, "assets");
  compareSection(legacy.liabilities, builder.liabilities, "liabilities");
  compareSection(legacy.equity, builder.equity, "equity");
}

// ---- Tests ---------------------------------------------------------

describe("Report Builder PR 5 — Compatibility shim equivalence", () => {
  beforeAll(async () => {
    await ensureFixture();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("getIncomeStatementViaBuilder ≡ getIncomeStatement (headline numbers)", async () => {
    const legacy = await getIncomeStatement(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-01-01"),
      new Date("2026-03-31")
    );
    const builder = await getIncomeStatementViaBuilder(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-01-01"),
      new Date("2026-03-31")
    );

    // Sanity: revenue + expenses from the fixture.
    expect(legacy.totalRevenue.toString()).toBe("8000");
    expect(legacy.totalExpenses.toString()).toBe("4900"); // 3000 + 1500 + 400
    expect(legacy.netIncome.toString()).toBe("3100");

    decimalEqual(
      legacy.totalRevenue,
      builder.totalRevenue,
      "IS totalRevenue"
    );
    decimalEqual(
      legacy.totalExpenses,
      builder.totalExpenses,
      "IS totalExpenses"
    );
    decimalEqual(legacy.netIncome, builder.netIncome, "IS netIncome");
  });

  it("getIncomeStatementViaBuilder ≡ getIncomeStatement (per-account detail)", async () => {
    const legacy = await getIncomeStatement(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-01-01"),
      new Date("2026-03-31")
    );
    const builder = await getIncomeStatementViaBuilder(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-01-01"),
      new Date("2026-03-31")
    );
    compareISRows(legacy, builder);
  });

  it("getIncomeStatementViaBuilder ≡ getIncomeStatement (other period — single month)", async () => {
    // Smaller window. Feb only: $8,000 rev − $3,000 COGS = $5,000 NI.
    const legacy = await getIncomeStatement(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-02-01"),
      new Date("2026-02-28")
    );
    const builder = await getIncomeStatementViaBuilder(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-02-01"),
      new Date("2026-02-28")
    );

    expect(legacy.netIncome.toString()).toBe("5000");
    decimalEqual(legacy.netIncome, builder.netIncome, "IS Feb netIncome");
    compareISRows(legacy, builder);
  });

  it("getBalanceSheetViaBuilder ≡ getBalanceSheet (headline numbers)", async () => {
    const legacy = await getBalanceSheet(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-03-31")
    );
    const builder = await getBalanceSheetViaBuilder(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-03-31")
    );

    // Sanity from the fixture math.
    expect(legacy.totalAssets.toString()).toBe("23500");
    expect(legacy.totalLiabilities.toString()).toBe("400");
    expect(legacy.totalEquity.toString()).toBe("23100"); // 20000 + 3100
    expect(legacy.retainedEarnings.toString()).toBe("3100");
    expect(legacy.totalLiabilitiesAndEquity.toString()).toBe("23500");
    expect(legacy.balances).toBe(true);

    decimalEqual(legacy.totalAssets, builder.totalAssets, "BS totalAssets");
    decimalEqual(
      legacy.totalLiabilities,
      builder.totalLiabilities,
      "BS totalLiabilities"
    );
    decimalEqual(legacy.totalEquity, builder.totalEquity, "BS totalEquity");
    decimalEqual(
      legacy.retainedEarnings,
      builder.retainedEarnings,
      "BS retainedEarnings"
    );
    decimalEqual(
      legacy.totalLiabilitiesAndEquity,
      builder.totalLiabilitiesAndEquity,
      "BS totalLiabilitiesAndEquity"
    );
    expect(builder.balances).toBe(true);
  });

  it("getBalanceSheetViaBuilder ≡ getBalanceSheet (per-account detail)", async () => {
    const legacy = await getBalanceSheet(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-03-31")
    );
    const builder = await getBalanceSheetViaBuilder(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-03-31")
    );
    compareBSRows(legacy, builder);
  });

  it("getBalanceSheetViaBuilder ≡ getBalanceSheet (different asOf — mid-Feb)", async () => {
    // Before the OpEx + tax. Equity should still equal cash + sales − COGS:
    //   Cash: 20000 + 8000 - 3000 = $25,000
    //   AP: 0
    //   Common Stock: $20,000
    //   Retained: 8000 − 3000 = $5,000
    //   Total: $25,000 = $0 + $25,000 ✓
    const legacy = await getBalanceSheet(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-02-28")
    );
    const builder = await getBalanceSheetViaBuilder(
      prisma,
      { entityCode: ENT_CODE, bookCode: BOOK_CODE, tenantId },
      new Date("2026-02-28")
    );

    expect(legacy.totalAssets.toString()).toBe("25000");
    expect(legacy.retainedEarnings.toString()).toBe("5000");
    expect(legacy.balances).toBe(true);

    decimalEqual(legacy.totalAssets, builder.totalAssets, "BS mid totalAssets");
    decimalEqual(
      legacy.retainedEarnings,
      builder.retainedEarnings,
      "BS mid retainedEarnings"
    );
    compareBSRows(legacy, builder);
  });
});
