// Cash Flow Statement reconciliation invariants.
//
// The headline assertion for v0.9: net cash flow computed via the
// indirect method (Net Income ± non-cash + working-capital + investing
// + financing) equals the actual Δ cash from the BS. If it doesn't, the
// classification heuristic missed an account — surfaced in the report's
// `uncategorized` panel.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { getCashFlowStatement } from "../src/lib/accounting/reports/cash-flow";
import { CHART_OF_ACCOUNTS } from "../src/lib/db/chart-of-accounts";

const prisma = new PrismaClient();
const ENTITY = "CF_TEST";
const GAAP = { entityCode: ENTITY, bookCode: "US_GAAP" };

async function clearAll() {
  await prisma.arApplication.deleteMany();
  await prisma.apApplication.deleteMany();
  await prisma.arOpenItem.deleteMany();
  await prisma.apOpenItem.deleteMany();
  await prisma.journalLine.deleteMany();
  await prisma.journalEntry.deleteMany();
}

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const entity = await prisma.legalEntity.upsert({
    where: { code: ENTITY },
    create: { code: ENTITY, name: "Cash Flow Test Co.", functionalCurrencyId: "USD" },
    update: {},
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
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: {},
    });
  }
  for (const a of CHART_OF_ACCOUNTS) {
    await prisma.account.upsert({
      where: { entityId_code: { entityId: null as any, code: a.code } as any },
      create: {
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
        isControlAccount: a.isControlAccount ?? false,
        isBank: a.isBank ?? false,
        subtype: a.subtype,
      },
      update: {},
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

// =========================================================================
// Reconciliation invariant — controlled fixtures
// =========================================================================

describe("Cash Flow: reconciles to Δ cash", () => {
  it("capital infusion only — operating 0, financing +$100k, Δ cash = $100k", async () => {
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-15"),
      memo: "Founders contribute",
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });

    const cf = await getCashFlowStatement(
      prisma,
      GAAP,
      new Date("2026-02-01"),
      new Date("2026-02-28")
    );
    expect(cf.netIncome.toNumber()).toBe(0);
    expect(cf.operatingCashFlow.toNumber()).toBe(0);
    expect(cf.financingCashFlow.toNumber()).toBe(100_000);
    expect(cf.netCashFlow.toNumber()).toBe(100_000);
    expect(cf.actualCashChange.toNumber()).toBe(100_000);
    expect(cf.reconciles).toBe(true);
  });

  it("revenue with all-AR collection — Δ cash 0, operating 0 (NI + Δ AR cancel)", async () => {
    // Bill a customer; no collection. NI = +$10k, Δ AR = +$10k → ops = 0.
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-15"),
      memo: "Bill customer (no cash yet)",
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 10_000 },
        { accountCode: "4000", credit: 10_000 },
      ],
    });

    const cf = await getCashFlowStatement(
      prisma,
      GAAP,
      new Date("2026-02-01"),
      new Date("2026-02-28")
    );
    expect(cf.netIncome.toNumber()).toBe(10_000);
    // Δ AR = +$10k → cash impact = -$10k (asset increase uses cash)
    expect(cf.workingCapitalChanges.find((l) => l.accountCode === "1200")!.cashImpact.toNumber()).toBe(-10_000);
    expect(cf.operatingCashFlow.toNumber()).toBe(0);
    expect(cf.netCashFlow.toNumber()).toBe(0);
    expect(cf.reconciles).toBe(true);
  });

  it("capex + revenue + collection — investing −$5k, operating +$2k, Δ cash −$3k", async () => {
    // Capital contribution to fund the equipment purchase.
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-01"),
      memo: "Funding",
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 10_000 },
        { accountCode: "3100", credit: 10_000 },
      ],
    });
    // Buy equipment for $5k cash.
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-10"),
      memo: "Capex",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 5_000 },
        { accountCode: "1000", credit: 5_000 },
      ],
    });
    // Earn $2k revenue, collected immediately in cash.
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-20"),
      memo: "Cash sale",
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 2_000 },
        { accountCode: "4000", credit: 2_000 },
      ],
    });

    const cf = await getCashFlowStatement(
      prisma,
      GAAP,
      new Date("2026-02-01"),
      new Date("2026-02-28")
    );
    // NI = $2k; operating = $2k (no WC changes); investing = -$5k (capex);
    // financing = +$10k (capital). Net = +$7k.
    expect(cf.netIncome.toNumber()).toBe(2_000);
    expect(cf.operatingCashFlow.toNumber()).toBe(2_000);
    expect(cf.investingCashFlow.toNumber()).toBe(-5_000);
    expect(cf.financingCashFlow.toNumber()).toBe(10_000);
    expect(cf.netCashFlow.toNumber()).toBe(7_000);
    expect(cf.actualCashChange.toNumber()).toBe(7_000);
    expect(cf.reconciles).toBe(true);
  });

  it("depreciation is added back as a non-cash item", async () => {
    // Set up: $0 cash to start. Just an opening BS via equity, then a
    // depreciation entry. Operating cash flow = NI + Dep add-back = 0.
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-01"),
      memo: "Founding",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 12_000 },
        { accountCode: "3100", credit: 12_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-28"),
      memo: "Depreciation Feb",
      source: "SEED",
      lines: [
        { accountCode: "8000", debit: 500 },
        { accountCode: "1510", credit: 500 },
      ],
    });

    const cf = await getCashFlowStatement(
      prisma,
      GAAP,
      new Date("2026-02-01"),
      new Date("2026-02-28")
    );
    // NI = -$500 (depreciation expense). Add back $500 non-cash. Operating = 0.
    expect(cf.netIncome.toNumber()).toBe(-500);
    expect(cf.nonCashAddBacks.find((l) => l.accountCode === "8000")!.cashImpact.toNumber()).toBe(500);
    expect(cf.operatingCashFlow.toNumber()).toBe(0);
    expect(cf.reconciles).toBe(true);
  });
});

// =========================================================================
// Classification heuristic
// =========================================================================

describe("Cash Flow: classification surfaces every BS change", () => {
  it("any non-cash BS account with a balance change lands in operating/investing/financing OR uncategorized — never silently dropped", async () => {
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-02-15"),
      memo: "Mixed entry",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 4_000 },          // Fixed asset (investing)
        { accountCode: "2000", credit: 1_000 },          // AP (operating WC)
        { accountCode: "3100", credit: 3_000 },          // Equity (financing)
      ],
    });

    const cf = await getCashFlowStatement(
      prisma,
      GAAP,
      new Date("2026-02-01"),
      new Date("2026-02-28")
    );

    const allBsCodes = new Set([
      ...cf.workingCapitalChanges.map((l) => l.accountCode),
      ...cf.investingItems.map((l) => l.accountCode),
      ...cf.financingItems.map((l) => l.accountCode),
      ...cf.uncategorized.map((l) => l.accountCode),
    ]);
    expect(allBsCodes.has("1500")).toBe(true);  // Equipment
    expect(allBsCodes.has("2000")).toBe(true);  // AP
    expect(allBsCodes.has("3100")).toBe(true);  // Paid-in capital
  });
});
