// Invariant tests against the full Northwind Cloud seed.
//
// Assumes `pnpm db:seed` has been run. Verifies the 6-month dataset
// balances at every month-end (per book) and that the multi-book
// divergence (depreciation + Globex cash-basis tax recognition) shows up
// correctly in the book-tax-difference report.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import {
  getTrialBalance,
  getBalanceSheet,
  getIncomeStatement,
} from "../src/lib/accounting/reports";
import { getBookTaxDifference } from "../src/lib/accounting/reports/book-tax-difference";
import { openArBalance } from "../src/lib/accounting/sub-ledgers/ar";
import { openApBalance } from "../src/lib/accounting/sub-ledgers/ap";
import { netBookValue } from "../src/lib/accounting/sub-ledgers/fixed-assets";

const prisma = new PrismaClient();
const ENTITY = "NORTHWIND";
const GAAP = { entityCode: ENTITY, bookCode: "US_GAAP" };
const TAX = { entityCode: ENTITY, bookCode: "US_TAX" };
const IFRS = { entityCode: ENTITY, bookCode: "IFRS" };

beforeAll(async () => {
  // Self-heal: re-seed Northwind whenever the data looks incomplete.
  //
  // The previous threshold (`jeCount === 0`) didn't catch the case
  // where a prior partial run left a few JEs but no AR / depreciation /
  // revenue-recognition state. The result was silent: tests would see
  // partial data and fail with confusing "$40k expected, got $0"
  // mismatches.
  //
  // The seed is idempotent (it wipes entity-scoped sub-ledger rows at
  // the top), so re-running on top of stale data is safe + cheap. A
  // full Northwind seed is ~30 seconds; we accept that overhead per
  // file run rather than risk the partial-data ambiguity.
  //
  // We check a compound signal: entity exists, has ≥ a sensible JE
  // count, AND has the post-seed sub-ledger state populated. Any
  // missing piece triggers a re-seed.
  const northwind = await prisma.legalEntity.findFirst({
    where: { code: ENTITY },
    select: { id: true },
  });

  let looksComplete = false;
  if (northwind) {
    const [jeCount, arCount, faCount, rcRecognized, foreignEntries] = await Promise.all([
      prisma.journalEntry.count({ where: { entityId: northwind.id } }),
      prisma.arOpenItem.count({ where: { entityId: northwind.id } }),
      prisma.fixedAsset.count({ where: { entityId: northwind.id } }),
      prisma.performanceObligation.findFirst({
        where: { contract: { entityId: northwind.id } },
        select: { recognizedToDate: true },
      }),
      // Anything on Northwind that the seed did not put there. Every entry
      // seedNorthwind posts carries source: "SEED", so a non-SEED row is by
      // definition somebody else's.
      prisma.journalEntry.count({
        where: { entityId: northwind.id, source: { not: "SEED" } },
      }),
    ]);
    // A fully-seeded Northwind has ~180 JEs, 21 AR open items, 1 FA,
    // and a non-zero recognizedToDate on the Globex revenue contract.
    // Conservative thresholds — anything substantially below triggers
    // a re-seed.
    // ⚠️ EVERY THRESHOLD ABOVE IS A LOWER BOUND, which is only half a check.
    // They catch a dataset that is too SMALL — a partial or wiped seed — and
    // are blind to one that is too BIG. This suite asserts exact totals
    // (75000.00 / 115000.00 / 40_000), so a complete Northwind PLUS one extra
    // posting still read `looksComplete === true`, skipped the re-seed, and
    // let the extra amount land in the assertion.
    //
    // Not hypothetical: nine rls-* suites post journal entries into
    // NORTHWIND/US_GAAP and none of them clean up — `rls-journal-entry-actions`
    // alone adds $10 of revenue dated 2026-06-15, inside the Jan-Jun window
    // these totals cover. Measured 7 leaked entries on the shared dev database.
    // It has stayed green only because something else keeps emptying Northwind
    // and forcing a full re-seed, which is luck, not isolation.
    //
    // `foreignEntries` closes it: any entry the seed did not post means the
    // dataset is no longer the one these numbers were written against, so
    // re-seed. One extra count keeps the fast path for the common clean case
    // rather than paying ~2 minutes of unconditional re-seed every run.
    looksComplete =
      jeCount > 50 &&
      arCount > 5 &&
      faCount >= 1 &&
      !!rcRecognized &&
      rcRecognized.recognizedToDate.toString() !== "0" &&
      foreignEntries === 0;
  }

  if (!looksComplete) {
    const { seedNorthwind } = await import("../src/lib/seed/northwind");
    await seedNorthwind(prisma);
  }
}, 300_000); // hookTimeout — full seed against remote Neon takes ~2 min

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

// =========================================================================
// Per-book balance integrity at every month-end
// =========================================================================

for (const [label, scope] of [
  ["US_GAAP", GAAP] as const,
  ["US_TAX", TAX] as const,
  ["IFRS", IFRS] as const,
]) {
  describe(`Northwind / ${label}: TB + BS balance at every month-end`, () => {
    for (const date of MONTH_ENDS) {
      it(`balances on ${date.toISOString().slice(0, 10)}`, async () => {
        const [tb, bs] = await Promise.all([
          getTrialBalance(prisma, scope, date),
          getBalanceSheet(prisma, scope, date),
        ]);
        expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
        expect(bs.balances).toBe(true);
        expect(bs.totalAssets.equals(bs.totalLiabilitiesAndEquity)).toBe(true);
      });
    }
  });
}

// =========================================================================
// Sub-ledger reconciliation invariants
// =========================================================================

describe("Northwind: sub-ledger reconciliation", () => {
  it("AR open-item sum equals AR control account balance (US_GAAP, 6/30)", async () => {
    const openBal = await openArBalance(prisma, ENTITY, "US_GAAP");
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-06-30"));
    const arRow = bs.assets.find((a) => a.code === "1200");
    expect(arRow).toBeDefined();
    expect(openBal.equals(arRow!.amount)).toBe(true);
  });

  it("AP open-item sum equals AP control account balance (US_GAAP, 6/30)", async () => {
    const openBal = await openApBalance(prisma, ENTITY, "US_GAAP");
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-06-30"));
    const apRow = bs.liabilities.find((l) => l.code === "2000");
    // Smith & Co bill paid in May, so AP control should be zero, open balance zero.
    expect(openBal.toNumber()).toBe(0);
    if (apRow) expect(apRow.amount.equals(openBal)).toBe(true);
  });

  it("Fixed asset NBV diverges across books per useful-life difference", async () => {
    const gaap = await netBookValue(prisma, ENTITY, "US_GAAP");
    const tax = await netBookValue(prisma, ENTITY, "US_TAX");
    const ifrs = await netBookValue(prisma, ENTITY, "IFRS");
    // GAAP/IFRS: 36-mo SL → 6 months × $666.67 ≈ $4,000.02 depreciated → NBV ≈ $19,999.98
    // TAX: 60-mo SL → 6 months × $400 = $2,400 depreciated → NBV = $21,600
    expect(gaap.nbv.toDecimalPlaces(2).toString()).toBe(ifrs.nbv.toDecimalPlaces(2).toString());
    expect(tax.nbv.minus(gaap.nbv).toDecimalPlaces(0).toString()).toBe("1600");
  });
});

// =========================================================================
// Multi-book divergence — the headline of v0.3
// =========================================================================

describe("Northwind: multi-book divergence shows in P&L", () => {
  it("US_TAX recognizes Globex revenue immediately (cash basis); US_GAAP defers", async () => {
    // GAAP P&L Jan-Jun: Globex contributes 4 months × $5k = $20k revenue.
    // TAX P&L Jan-Jun: Globex contributes the full $60k (cash received Mar 1).
    const gaapPnl = await getIncomeStatement(
      prisma,
      GAAP,
      new Date("2026-01-01"),
      new Date("2026-06-30")
    );
    const taxPnl = await getIncomeStatement(
      prisma,
      TAX,
      new Date("2026-01-01"),
      new Date("2026-06-30")
    );

    // GAAP total revenue = Acme 6×$5k + Globex SaaS recognized $20k (4
    // months × $5k straight-line) + Globex Q2 services invoice $25k = $75k
    // TAX  total revenue = Acme 6×$5k + Globex SaaS cash $60k + Globex Q2
    //                      services $25k = $115k
    expect(gaapPnl.totalRevenue.toFixed(2)).toBe("75000.00");
    expect(taxPnl.totalRevenue.toFixed(2)).toBe("115000.00");
  });

  it("US_GAAP depreciation expense (3-yr life) exceeds US_TAX (5-yr life)", async () => {
    const gaapPnl = await getIncomeStatement(
      prisma,
      GAAP,
      new Date("2026-01-01"),
      new Date("2026-06-30")
    );
    const taxPnl = await getIncomeStatement(
      prisma,
      TAX,
      new Date("2026-01-01"),
      new Date("2026-06-30")
    );
    const gaapDep = gaapPnl.expenses.find((e) => e.code === "8000");
    const taxDep = taxPnl.expenses.find((e) => e.code === "8000");
    expect(gaapDep).toBeDefined();
    expect(taxDep).toBeDefined();
    expect(gaapDep!.amount.minus(taxDep!.amount).toDecimalPlaces(0).toString()).toBe("1600");
  });
});

// =========================================================================
// Book-tax-difference report — the v0.3 demo
// =========================================================================

describe("Northwind: book-tax-difference report (GAAP vs TAX, Jan-Jun 2026)", () => {
  it("shows tax net income materially higher than book due to Globex + depreciation", async () => {
    const btd = await getBookTaxDifference(prisma, {
      entityCode: ENTITY,
      fromBookCode: "US_GAAP",
      toBookCode: "US_TAX",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-06-30"),
    });

    // Revenue delta: book $50k - tax $90k = -$40k (book lower).
    // Depreciation expense delta: book $4,000 - tax $2,400 ≈ +$1,600 (book higher expense → book lower income).
    // Net income delta: bookNetIncome - taxNetIncome ≈ -$41,600.
    const delta = btd.bookNetIncome.minus(btd.taxNetIncome).toNumber();
    expect(delta).toBeCloseTo(-41_600, 0);

    // The depreciation expense row should appear with classification TEMPORARY.
    const depRow = btd.pnlRows.find((r) => r.accountCode === "8000");
    expect(depRow).toBeDefined();
    expect(depRow!.classification).toBe("TEMPORARY");

    // Deferred revenue (account 2200) should appear on the BS side as a temporary diff.
    const defRevRow = btd.balanceSheetRows.find((r) => r.accountCode === "2200");
    expect(defRevRow).toBeDefined();
    expect(defRevRow!.classification).toBe("TEMPORARY");
  });
});

// =========================================================================
// Legacy financial-shape assertions
// =========================================================================

describe("Northwind: financial shape sanity (US_GAAP)", () => {
  it("has a deferred revenue balance of exactly $40k (Globex, 8 months remaining)", async () => {
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-06-30"));
    const defRev = bs.liabilities.find((l) => l.code === "2200");
    expect(defRev).toBeDefined();
    expect(defRev!.amount.toNumber()).toBe(40_000);
  });

  it("has AR of exactly $40k at 6/30 (3 unpaid Acme @ $5k + Globex Q2 services $25k)", async () => {
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-06-30"));
    const ar = bs.assets.find((a) => a.code === "1200");
    expect(ar).toBeDefined();
    expect(ar!.amount.toNumber()).toBe(40_000);
  });

  it("AP is zero at 6/30 (Smith & Co paid in May)", async () => {
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-06-30"));
    const ap = bs.liabilities.find((l) => l.code === "2000");
    if (ap) expect(ap.amount.toNumber()).toBe(0);
  });
});
