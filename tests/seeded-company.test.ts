// Invariant tests against the full Northwind Cloud seed.
//
// These tests assume `pnpm db:seed` has been run. They verify that the
// 6-month dataset balances at every month-end and that the basic financial
// shape is sensible.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTrialBalance,
  getBalanceSheet,
  getIncomeStatement,
} from "../src/lib/accounting/reports";

const prisma = new PrismaClient();
const SCOPE = { entityCode: "NORTHWIND", bookCode: "US_GAAP" };

beforeAll(async () => {
  const count = await prisma.journalEntry.count();
  if (count === 0) {
    throw new Error(
      "No entries in ledger. Run `pnpm db:seed` before running seeded-company tests."
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

const MONTH_ENDS = [
  new Date("2026-01-31"),
  new Date("2026-02-28"),
  new Date("2026-03-31"),
  new Date("2026-04-30"),
  new Date("2026-05-31"),
  new Date("2026-06-30"),
];

describe("Northwind Cloud: balance sheet balances at every month-end (US_GAAP)", () => {
  for (const date of MONTH_ENDS) {
    it(`balances on ${date.toISOString().slice(0, 10)}`, async () => {
      const bs = await getBalanceSheet(prisma, SCOPE, date);
      expect(bs.balances).toBe(true);
      expect(bs.totalAssets.equals(bs.totalLiabilitiesAndEquity)).toBe(true);
    });
  }
});

describe("Northwind Cloud: trial balance balances at every month-end (US_GAAP)", () => {
  for (const date of MONTH_ENDS) {
    it(`debits === credits on ${date.toISOString().slice(0, 10)}`, async () => {
      const tb = await getTrialBalance(prisma, SCOPE, date);
      expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
    });
  }
});

describe("Northwind Cloud: financial shape sanity checks", () => {
  it("has positive total revenue YTD", async () => {
    const pnl = await getIncomeStatement(
      prisma,
      SCOPE,
      new Date("2026-01-01"),
      new Date("2026-06-30")
    );
    expect(pnl.totalRevenue.toNumber()).toBeGreaterThan(0);
  });

  it("has positive total expenses YTD", async () => {
    const pnl = await getIncomeStatement(
      prisma,
      SCOPE,
      new Date("2026-01-01"),
      new Date("2026-06-30")
    );
    expect(pnl.totalExpenses.toNumber()).toBeGreaterThan(0);
  });

  it("has a deferred revenue balance reflecting Globex prepayment", async () => {
    // Globex prepaid $60k in March; by end of June, 4 months have been released ($20k),
    // leaving $40k in deferred revenue.
    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-06-30"));
    const defRev = bs.liabilities.find((l) => l.code === "2200");
    expect(defRev).toBeDefined();
    expect(defRev!.amount.toNumber()).toBe(40_000);
  });

  it("has AR > 0 (uncollected invoices)", async () => {
    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-06-30"));
    const ar = bs.assets.find((a) => a.code === "1200");
    expect(ar).toBeDefined();
    expect(ar!.amount.toNumber()).toBeGreaterThan(0);
  });

  it("US_TAX book is empty (multi-book seam exists; postings to follow in next batch)", async () => {
    const tb = await getTrialBalance(
      prisma,
      { entityCode: "NORTHWIND", bookCode: "US_TAX" },
      new Date("2026-06-30")
    );
    expect(tb.totalDebit.toNumber()).toBe(0);
    expect(tb.totalCredit.toNumber()).toBe(0);
  });
});
