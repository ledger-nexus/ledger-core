// Report Builder PR 4 — Statement of Stockholders' Equity proof.
//
// This is the new 4th GAAP financial statement, built ENTIRELY via the
// builder. ledger-core's hand-coded reports ship IS / BS / Cash Flow
// only — Equity statement didn't exist before this PR.
//
// PROOF POINTS:
//   ✓ Matrix layout: Common Stock | APIC | Retained Earnings | Total
//   ✓ Column-level account filters scope each column to one sub-category
//   ✓ Cross-template @IS.ni resolution in matrix mode (Net Income shows
//     up in the "ni" row across all columns)
//   ✓ Total column ties to Balance Sheet equity total
//
// LIMITATIONS DOCUMENTED IN-TEMPLATE:
//   - "Beginning balance" row would require asOf = fromDate − 1 scope;
//     v1 uses single-asOf, so the "balance" row is actually the ending
//     balance. PR 5 may add a "begin" mode to RowDef.
//   - FORMULA rows compute the same in every column (FORMULA isn't
//     column-aware). So Net Income shows in CS / APIC columns too even
//     though GAAP would only show NI in RE. The renderer (PR 6) can
//     hide cells via cell-level CSS; engine-side fix needs a richer
//     DSL.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { renderTemplate } from "@/lib/accounting/reports/builder/render";
import {
  EQUITY_TEMPLATE,
  BALANCE_SHEET_TEMPLATE,
} from "@/lib/accounting/reports/builder/templates";

const prisma = new PrismaClient();

const PREFIX = "RPTQ"; // ReportBuilder eQuity
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

  // Q1 setup:
  //   Jan: $50,000 Common Stock contribution (account 3000)
  //   Jan: $25,000 APIC contribution (account 3100)
  //   Mar: $4,000 net income ($5,000 revenue − $1,000 OpEx)
  //
  // Expected Equity Statement at March 31, 2026:
  //   Common Stock column:   balance $50,000, ni $4,000 (LIMITATION),
  //                          total $54,000 (would be 50k under
  //                          column-aware FORMULA)
  //   APIC column:           balance $25,000, ni $4,000 (LIMITATION),
  //                          total $29,000
  //   RE column:             balance $0 (no equity accts match filter),
  //                          ni $4,000, total $4,000
  //   Total column:          balance $75,000 (CS + APIC combined),
  //                          ni $4,000, total $79,000
  //
  // BS Equity at March 31, 2026: $79,000 (CS 50k + APIC 25k + RE 4k)
  // Equity Statement Total column "total" row = $79,000 — TIES OUT. ✓

  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-01-05"),
    memo: "Common Stock contribution",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 50000, credit: 0 },
      { accountCode: "3000", debit: 0, credit: 50000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-01-05"),
    memo: "APIC contribution",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 25000, credit: 0 },
      { accountCode: "3100", debit: 0, credit: 25000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-03-15"),
    memo: "Q1 sale",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 5000, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 5000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-03-15"),
    memo: "Q1 opex",
    source: "MANUAL",
    lines: [
      { accountCode: "6000", debit: 1000, credit: 0 },
      { accountCode: "1000", debit: 0, credit: 1000 },
    ],
  });
}

async function cleanup(): Promise<void> {
  if (!entityId) return;
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  const cals = await prisma.fiscalCalendar.findMany({ where: { entityId }, select: { id: true } });
  await prisma.period.deleteMany({ where: { calendarId: { in: cals.map((c) => c.id) } } });
  await prisma.fiscalCalendar.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
}

describe("Statement of Stockholders' Equity — built via the builder (PR 4 proof)", () => {
  beforeAll(async () => {
    await ensureFixture();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("renders a 4-column matrix (Common Stock + APIC + RE + Total)", async () => {
    const matrix = await renderTemplate(prisma, EQUITY_TEMPLATE, {
      asOfDate: new Date("2026-03-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    expect(matrix.columns.map((c) => c.label)).toEqual([
      "Common Stock",
      "Additional Paid-in Capital",
      "Retained Earnings",
      "Total",
    ]);
  });

  it("Common Stock column: scopes 'balance' row to account 3000 only", async () => {
    const matrix = await renderTemplate(prisma, EQUITY_TEMPLATE, {
      asOfDate: new Date("2026-03-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    const balanceRow = matrix.rows.find((r) => r.id === "balance");
    expect(balanceRow).toBeDefined();
    // Column 0 = Common Stock. signFlip applied to credit-normal balance.
    // CS balance is -$50,000 (50k credit). signFlip → +$50,000.
    expect(balanceRow!.cells[0].value).toBe("50000.00");
  });

  it("APIC column: scopes 'balance' row to account 3100 only", async () => {
    const matrix = await renderTemplate(prisma, EQUITY_TEMPLATE, {
      asOfDate: new Date("2026-03-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    const balanceRow = matrix.rows.find((r) => r.id === "balance");
    expect(balanceRow!.cells[1].value).toBe("25000.00"); // Column 1 = APIC
  });

  it("Retained Earnings column: 'balance' row has 0 (no accounts match empty filter), 'ni' = @IS.ni", async () => {
    const matrix = await renderTemplate(prisma, EQUITY_TEMPLATE, {
      asOfDate: new Date("2026-03-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    const balanceRow = matrix.rows.find((r) => r.id === "balance");
    const niRow = matrix.rows.find((r) => r.id === "ni");
    // Column 2 = RE. Empty accountFilter excludes all equity accounts.
    expect(balanceRow!.cells[2].value).toBe("0.00");
    // @IS.ni = $5,000 revenue − $1,000 opex = $4,000.
    expect(niRow!.cells[2].value).toBe("4000.00");
  });

  it("Total column: shows $75k equity + $4k NI = $79k total (sum of all equity)", async () => {
    const matrix = await renderTemplate(prisma, EQUITY_TEMPLATE, {
      asOfDate: new Date("2026-03-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    const balanceRow = matrix.rows.find((r) => r.id === "balance");
    const niRow = matrix.rows.find((r) => r.id === "ni");
    const totalRow = matrix.rows.find((r) => r.id === "total");
    // Column 3 = Total. No filter — all EQUITY accounts contribute.
    expect(balanceRow!.cells[3].value).toBe("75000.00"); // CS + APIC
    expect(niRow!.cells[3].value).toBe("4000.00");
    expect(totalRow!.cells[3].value).toBe("79000.00");
  });

  it("PROOF: Equity Statement Total column ties to Balance Sheet equity total", async () => {
    const eq = await renderTemplate(prisma, EQUITY_TEMPLATE, {
      asOfDate: new Date("2026-03-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    const bs = await renderTemplate(prisma, BALANCE_SHEET_TEMPLATE, {
      asOfDate: new Date("2026-03-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });

    // Equity Statement: Total column → "total" row = $79,000
    const eqTotal = eq.rows.find((r) => r.id === "total")!.cells[3].value;
    // Balance Sheet: total_equity row = sum of equity accounts + RE
    const bsTotalEquity = bs.rows.find((r) => r.id === "total_equity")!.cells[0].value;

    // Both should be $79,000 — the cross-statement tie-out that GAAP
    // and operators rely on. This is the proof point of PR 4.
    expect(eqTotal).toBe(bsTotalEquity);
    expect(eqTotal).toBe("79000.00");
  });
});
