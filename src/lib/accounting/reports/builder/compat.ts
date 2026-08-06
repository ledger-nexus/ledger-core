// Report Builder PR 5 — Compatibility shims for legacy IS / BS callers.
//
// THE POINT: prove that the same Income Statement and Balance Sheet
// numbers fall out of the builder. Existing UI pages, CSV routes, and
// month-end packet all call `getIncomeStatement` / `getBalanceSheet`
// from `@/lib/accounting/reports`. Those signatures cannot change
// without touching every caller, so this module exports
// `getIncomeStatementViaBuilder` / `getBalanceSheetViaBuilder` which
// return THE SAME typed shapes — but with internals routed through:
//
//   Layer 1  getAccountBalances    (math primitive)
//   Layer 2  runRowEngine          (against IS_TEMPLATE / BALANCE_SHEET_TEMPLATE)
//
// Per-account detail (`revenue[]` / `expenses[]` / `assets[]` / etc.)
// is built by walking the balance map directly with the legacy
// section-sign convention. This is what the UI page renderer expects —
// the builder's `showAccountDetail` flag is honored by the renderer
// (PR 6), not the legacy shape.
//
// The equivalence test (`tests/report-builder-compat.test.ts`) posts a
// fixture entity and asserts that `getIncomeStatementViaBuilder` ≡
// `getIncomeStatement` (and same for BS), down to per-row amounts.
//
// MIGRATION PATH: once this proves equivalent and the UI / CSV / PDF
// renderers in PR 6 are updated to consume the new builder output
// directly, the legacy `getIncomeStatement` / `getBalanceSheet` in
// `src/lib/accounting/reports.ts` can be deprecated and these shims
// become the only path.
//
// LIMITATIONS:
// - Cash Flow stays hand-coded. The indirect-method classification
//   heuristic embedded in `getCashFlowStatement` doesn't map cleanly
//   onto the row engine yet. PR 6+ may revisit.
// - These shims hold a `crossTemplateValues` only for `@IS.ni` (the
//   one cross-template reference in BS_TEMPLATE v1). When more refs
//   land, the shim needs a `resolveCrossTemplateRefs`-equivalent.

import { Decimal } from "@/lib/utils/decimal";

import { getAccountBalances } from "./balances";
import { runRowEngine } from "./row-engine";
import { INCOME_STATEMENT_TEMPLATE } from "./templates/income-statement";
import { BALANCE_SHEET_TEMPLATE } from "./templates/balance-sheet";
import type { ColumnScope } from "./types";
import type {
  ReportScope,
  IncomeStatement,
  BalanceSheet,
  FinancialStatementRow,
} from "../../reports";
import type { DbClient } from "@/lib/db";


const DEFAULT_BOOK = "US_GAAP";

/**
 * Builder-routed Income Statement. Drop-in replacement for
 * `getIncomeStatement` from `@/lib/accounting/reports`.
 *
 * The headline numbers (totalRevenue, totalExpenses, netIncome) come
 * from `runRowEngine(INCOME_STATEMENT_TEMPLATE)`. Per-account detail
 * is read from the same balance map.
 */
export async function getIncomeStatementViaBuilder(
  prisma: DbClient,
  scope: ReportScope,
  periodStart: Date,
  periodEnd: Date
): Promise<IncomeStatement> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;

  // Layer 1: fetch raw balances for the period.
  const balances = await getAccountBalances(prisma, {
    entityCode: scope.entityCode,
    bookCode,
    tenantId: scope.tenantId,
    fromDate: periodStart,
    toDate: periodEnd,
  });

  // Layer 2: run row engine for the headline numbers. The IS template's
  // `rev` row already applies signFlip, so its value == legacy totalRevenue.
  // `ni` is the Net Income FORMULA → same as legacy netIncome.
  const columnScope: ColumnScope = {
    entityCode: scope.entityCode,
    bookCode,
    period: {
      fromDate: periodStart.toISOString().slice(0, 10),
      toDate: periodEnd.toISOString().slice(0, 10),
    },
  };

  const evaluated = runRowEngine({
    rows: INCOME_STATEMENT_TEMPLATE.definition.rows,
    balances,
    scope: columnScope,
  });

  const revRow = evaluated.byId.get("rev");
  const niRow = evaluated.byId.get("ni");
  const cogsRow = evaluated.byId.get("cogs");
  const opexRow = evaluated.byId.get("opex");
  const taxRow = evaluated.byId.get("tax");
  if (!revRow || !niRow || !cogsRow || !opexRow || !taxRow) {
    throw new Error(
      "getIncomeStatementViaBuilder: IS_TEMPLATE missing expected row id"
    );
  }

  const totalRevenue = revRow.value;
  const totalExpenses = cogsRow.value.plus(opexRow.value).plus(taxRow.value);
  const netIncome = niRow.value;

  // Per-account detail. Same convention as legacy: revenue rows
  // present as `credit - debit` (positive when net credit), expense
  // rows as `debit - credit` (positive when net debit).
  const revenue: FinancialStatementRow[] = [];
  const expenses: FinancialStatementRow[] = [];

  // Sort by code so the output is deterministic, matching legacy.
  const sortedCodes = Array.from(balances.keys()).sort((a, b) =>
    a.localeCompare(b)
  );
  for (const code of sortedCodes) {
    const b = balances.get(code)!;
    if (b.type === "REVENUE") {
      // legacy: amount = credit - debit
      const amount = b.credit.minus(b.debit);
      revenue.push({
        code: b.code,
        name: b.name,
        amount,
        parentCode: b.parentCode,
        isContra: b.isContra,
        isBank: false, // legacy IS rows never carry the flag
      });
    } else if (b.type === "EXPENSE") {
      // legacy: amount = debit - credit
      const amount = b.debit.minus(b.credit);
      expenses.push({
        code: b.code,
        name: b.name,
        amount,
        parentCode: b.parentCode,
        isContra: b.isContra,
        isBank: false, // legacy IS rows never carry the flag
      });
    }
  }

  return {
    scope: { entityCode: scope.entityCode, bookCode },
    periodStart,
    periodEnd,
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    netIncome,
  };
}

/**
 * Builder-routed Balance Sheet. Drop-in replacement for
 * `getBalanceSheet` from `@/lib/accounting/reports`.
 *
 * Retained earnings is computed by calling
 * `getIncomeStatementViaBuilder` over inception → asOf and reading its
 * netIncome. That value is wired into the row engine via
 * `crossTemplateValues` so the BS template's `retained_earnings`
 * FORMULA row (`add: ["@IS.ni"]`) resolves to it — same mechanism the
 * Equity Statement uses.
 */
export async function getBalanceSheetViaBuilder(
  prisma: DbClient,
  scope: ReportScope,
  asOf: Date
): Promise<BalanceSheet> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;

  // Layer 1: fetch raw balances at asOf.
  const balances = await getAccountBalances(prisma, {
    entityCode: scope.entityCode,
    bookCode,
    tenantId: scope.tenantId,
    asOf,
  });

  // Cross-template ref: @IS.ni = cumulative net income from inception.
  const pnl = await getIncomeStatementViaBuilder(
    prisma,
    scope,
    new Date("1900-01-01"),
    asOf
  );
  const retainedEarnings = pnl.netIncome;
  const crossTemplateValues = new Map<string, Decimal>([
    ["@IS.ni", retainedEarnings],
  ]);

  // Layer 2: run row engine for the headline numbers.
  const columnScope: ColumnScope = {
    entityCode: scope.entityCode,
    bookCode,
    asOf: asOf.toISOString().slice(0, 10),
  };

  const evaluated = runRowEngine({
    rows: BALANCE_SHEET_TEMPLATE.definition.rows,
    balances,
    scope: columnScope,
    crossTemplateValues,
  });

  const totalAssetsRow = evaluated.byId.get("total_assets");
  const totalLiabRow = evaluated.byId.get("total_liabilities");
  const totalEquityRow = evaluated.byId.get("total_equity");
  const totalLiabEqRow = evaluated.byId.get("total_liab_eq");
  if (!totalAssetsRow || !totalLiabRow || !totalEquityRow || !totalLiabEqRow) {
    throw new Error(
      "getBalanceSheetViaBuilder: BS_TEMPLATE missing expected row id"
    );
  }

  const totalAssets = totalAssetsRow.value;
  const totalLiabilities = totalLiabRow.value;
  const totalEquity = totalEquityRow.value;
  const totalLiabilitiesAndEquity = totalLiabEqRow.value;

  // Per-section detail. Legacy section-sign convention:
  //   ASSET    amount = debit - credit  (sectionSign=1)
  //   LIAB     amount = credit - debit
  //   EQUITY   amount = credit - debit
  // Plus the synthetic "RE" row in the equity section.
  const assets: FinancialStatementRow[] = [];
  const liabilities: FinancialStatementRow[] = [];
  const equity: FinancialStatementRow[] = [];

  const sortedCodes = Array.from(balances.keys()).sort((a, b) =>
    a.localeCompare(b)
  );
  for (const code of sortedCodes) {
    const b = balances.get(code)!;
    if (b.type === "ASSET") {
      const amount = b.debit.minus(b.credit);
      assets.push({
        code: b.code,
        name: b.name,
        amount,
        parentCode: b.parentCode,
        isContra: b.isContra,
        isBank: b.isBank,
      });
    } else if (b.type === "LIABILITY") {
      const amount = b.credit.minus(b.debit);
      liabilities.push({
        code: b.code,
        name: b.name,
        amount,
        parentCode: b.parentCode,
        isContra: b.isContra,
        isBank: b.isBank,
      });
    } else if (b.type === "EQUITY") {
      const amount = b.credit.minus(b.debit);
      equity.push({
        code: b.code,
        name: b.name,
        amount,
        parentCode: b.parentCode,
        isContra: b.isContra,
        isBank: b.isBank,
      });
    }
  }

  // Synthetic RE row — matches legacy shape exactly.
  equity.push({
    code: "RE",
    name: "Retained Earnings (computed)",
    amount: retainedEarnings,
    parentCode: null,
    isContra: false,
    isBank: false,
  });

  return {
    scope: { entityCode: scope.entityCode, bookCode },
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    retainedEarnings,
    totalLiabilitiesAndEquity,
    balances: totalAssets.equals(totalLiabilitiesAndEquity),
  };
}
