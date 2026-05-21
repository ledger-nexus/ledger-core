// Cash Flow Statement — indirect method.
//
// The third financial statement. Reconciles net income to the change in
// cash by adding back non-cash items (depreciation, amortization) and
// adjusting for working-capital changes. Classification logic uses
// account subtype + type, with an UNCATEGORIZED bucket surfacing anything
// the heuristic can't place — so missing classifications are visible, not
// silently lost.
//
// Indirect method structure:
//   Net Income                                  (from P&L for the period)
//   + Depreciation / Amortization (non-cash)    (added back from P&L)
//   ± Δ Working capital                          (AR/AP/Inventory/Prepaid/...)
//   = Operating cash flow
//   - Capex / + Disposal proceeds                = Investing cash flow
//   + Equity / debt issuance, − repayments       = Financing cash flow
//   = Net change in cash
//   reconcileWith(Δ cash from BS)                                   ← invariant
//
// v0.9 caveat: ASC 842 operating leases require additional disclosure-line
// reclassification not handled here. The mechanical aggregation is correct;
// the GAAP presentation polish is v1.0.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { getBalanceSheet, getIncomeStatement } from "../reports";

export type CashFlowCategory =
  | "OPERATING_NONCASH"   // depreciation, amortization — add back to net income
  | "OPERATING_WC"        // working-capital change (AR, AP, Inventory, etc.)
  | "INVESTING"           // capex, disposals, ROU asset additions
  | "FINANCING"           // equity, debt, lease liability, dividends
  | "CASH"                // the cash accounts themselves (excluded from CF body)
  | "PNL_NETOUT"          // P&L accounts: already reflected in net income
  | "UNCATEGORIZED";

export interface CashFlowLine {
  accountCode: string;
  accountName: string;
  category: CashFlowCategory;
  deltaAmount: Decimal;     // BS change: end - start (on the natural side)
  cashImpact: Decimal;      // positive = cash inflow, negative = cash outflow
  rationale: string;
}

export interface CashFlowStatement {
  scope: { entityCode: string; bookCode: string };
  periodStart: Date;
  periodEnd: Date;

  netIncome: Decimal;

  // Operating activities
  nonCashAddBacks: CashFlowLine[];
  workingCapitalChanges: CashFlowLine[];
  operatingCashFlow: Decimal;

  // Investing activities
  investingItems: CashFlowLine[];
  investingCashFlow: Decimal;

  // Financing activities
  financingItems: CashFlowLine[];
  financingCashFlow: Decimal;

  netCashFlow: Decimal;

  // Reconciliation — net cash flow should equal Δ cash from the BS
  beginningCash: Decimal;
  endingCash: Decimal;
  actualCashChange: Decimal;
  reconcilingDifference: Decimal;  // netCashFlow - actualCashChange; nonzero = bug or uncategorized item
  reconciles: boolean;

  // Items the heuristic couldn't place — visible so you can extend the rules
  uncategorized: CashFlowLine[];
}

interface AccountMeta {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  subtype: string | null;
  isBank: boolean;
  isContra: boolean;
}

function classify(account: AccountMeta): CashFlowCategory {
  if (account.isBank) return "CASH";
  if (account.type === "REVENUE" || account.type === "EXPENSE") return "PNL_NETOUT";

  const sub = account.subtype;

  // Working capital accounts — the indirect method's bread and butter.
  const wcSubtypes = [
    "AR_TRADE",
    "AP_TRADE",
    "INVENTORY",
    "INVENTORY_RAW",
    "INVENTORY_WIP",
    "INVENTORY_FINISHED",
    "PREPAID",
    "ACCRUED",
    "DEFERRED_REV",
    "TAX_PAYABLE",
    "ALLOWANCE_DOUBTFUL",
  ];
  if (sub && wcSubtypes.includes(sub)) return "OPERATING_WC";

  // Investing — fixed assets at cost, accumulated depreciation (the contra),
  // intangibles, ROU assets, investments.
  const investingSubtypes = ["FIXED_ASSET", "ACCUM_DEPR", "INTANGIBLE", "ROU_ASSET", "INVESTMENT"];
  if (sub && investingSubtypes.includes(sub)) return "INVESTING";

  // Financing — equity always, lease liability (debt-like), long-term debt.
  if (account.type === "EQUITY") return "FINANCING";
  const financingSubtypes = ["LEASE_LIABILITY", "LONG_TERM_DEBT", "SHORT_TERM_DEBT", "NOTES_PAYABLE"];
  if (sub && financingSubtypes.includes(sub)) return "FINANCING";

  return "UNCATEGORIZED";
}

// Returns the cash impact direction for a working-capital change.
// Asset increase → cash outflow (-). Asset decrease → cash inflow (+).
// Liability increase → cash inflow (+). Liability decrease → cash outflow (-).
// Equity increase → cash inflow if contributed (+). Equity decrease → outflow (-).
function cashImpactDirection(
  account: AccountMeta,
  delta: Decimal
): { cashImpact: Decimal; rationale: string } {
  // For contra-asset accounts, the natural-side delta is already inverted;
  // we treat them as if they reduce the asset (so a contra-asset increase =
  // a non-cash item = no cash impact in this categorization).
  if (account.isContra) {
    return {
      cashImpact: new Decimal(0),
      rationale: `Contra account — included with the parent asset/liability`,
    };
  }

  if (account.type === "ASSET") {
    // Asset increase → cash use; decrease → cash source.
    return {
      cashImpact: delta.negated(),
      rationale: delta.isPositive()
        ? `Asset increased — uses cash`
        : delta.isNegative()
          ? `Asset decreased — sources cash`
          : `No change`,
    };
  }

  if (account.type === "LIABILITY") {
    // Liability increase → cash source; decrease → cash use.
    return {
      cashImpact: delta,
      rationale: delta.isPositive()
        ? `Liability increased — sources cash`
        : delta.isNegative()
          ? `Liability decreased — uses cash`
          : `No change`,
    };
  }

  if (account.type === "EQUITY") {
    // Equity increase = capital contribution = cash source (for paid-in capital;
    // for retained earnings the source is net income which is its own line).
    return {
      cashImpact: delta,
      rationale: delta.isPositive() ? `Equity contributed` : `Equity returned`,
    };
  }

  return { cashImpact: new Decimal(0), rationale: "" };
}

export async function getCashFlowStatement(
  prisma: PrismaClient,
  scope: { entityCode: string; bookCode?: string },
  periodStart: Date,
  periodEnd: Date
): Promise<CashFlowStatement> {
  const bookCode = scope.bookCode ?? "US_GAAP";

  // BS at period start (instant before) and at period end.
  const dayBeforeStart = new Date(periodStart);
  dayBeforeStart.setUTCDate(dayBeforeStart.getUTCDate() - 1);

  const [beginBs, endBs, pnl] = await Promise.all([
    getBalanceSheet(prisma, { entityCode: scope.entityCode, bookCode }, dayBeforeStart),
    getBalanceSheet(prisma, { entityCode: scope.entityCode, bookCode }, periodEnd),
    getIncomeStatement(prisma, { entityCode: scope.entityCode, bookCode }, periodStart, periodEnd),
  ]);

  // Pull account metadata so we can classify each BS row.
  const accounts = await prisma.account.findMany({
    where: {
      OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
    },
    select: { code: true, name: true, type: true, subtype: true, isBank: true, isContra: true },
  });
  const accountMeta = new Map<string, AccountMeta>(
    accounts.map((a) => [
      a.code,
      {
        code: a.code,
        name: a.name,
        type: a.type as AccountMeta["type"],
        subtype: a.subtype,
        isBank: a.isBank,
        isContra: a.isContra,
      },
    ])
  );

  // Build a map of account code → BS amount at each timestamp.
  function bsAmountMap(bs: typeof beginBs): Map<string, Decimal> {
    const m = new Map<string, Decimal>();
    for (const r of bs.assets) m.set(r.code, r.amount);
    for (const r of bs.liabilities) m.set(r.code, r.amount);
    for (const r of bs.equity) m.set(r.code, r.amount);
    return m;
  }
  const beginMap = bsAmountMap(beginBs);
  const endMap = bsAmountMap(endBs);
  const allCodes = new Set<string>([...beginMap.keys(), ...endMap.keys()]);

  // Beginning + ending cash from bank-flagged accounts.
  let beginningCash = new Decimal(0);
  let endingCash = new Decimal(0);
  for (const code of allCodes) {
    const meta = accountMeta.get(code);
    if (meta?.isBank) {
      beginningCash = beginningCash.plus(beginMap.get(code) ?? new Decimal(0));
      endingCash = endingCash.plus(endMap.get(code) ?? new Decimal(0));
    }
  }
  const actualCashChange = endingCash.minus(beginningCash);

  // Non-cash add-backs from the P&L: depreciation, amortization, bad-debt
  // (when DIRECT method posts to expense; ALLOWANCE method already nets out
  // in working capital via the allowance account).
  const nonCashAddBacks: CashFlowLine[] = [];
  for (const exp of pnl.expenses) {
    const meta = accountMeta.get(exp.code);
    if (!meta) continue;
    if (meta.subtype === "DEPRECIATION" || meta.subtype === "AMORTIZATION") {
      nonCashAddBacks.push({
        accountCode: exp.code,
        accountName: exp.name,
        category: "OPERATING_NONCASH",
        deltaAmount: exp.amount,
        cashImpact: exp.amount, // add back: net income subtracted this, so add it back
        rationale: "Non-cash expense — added back to net income",
      });
    }
  }

  // Working-capital and other BS-driven lines.
  const workingCapitalChanges: CashFlowLine[] = [];
  const investingItems: CashFlowLine[] = [];
  const financingItems: CashFlowLine[] = [];
  const uncategorized: CashFlowLine[] = [];

  for (const code of allCodes) {
    const meta = accountMeta.get(code);
    if (!meta) continue;
    const cat = classify(meta);
    if (cat === "CASH" || cat === "PNL_NETOUT") continue;

    const begin = beginMap.get(code) ?? new Decimal(0);
    const end = endMap.get(code) ?? new Decimal(0);
    const delta = end.minus(begin);
    if (delta.isZero()) continue;

    // Retained earnings is computed on the fly from net income — exclude it
    // from the BS-driven walk to avoid double-counting net income.
    if (code === "RE") continue;

    const { cashImpact, rationale } = cashImpactDirection(meta, delta);

    const line: CashFlowLine = {
      accountCode: code,
      accountName: meta.name,
      category: cat,
      deltaAmount: delta,
      cashImpact,
      rationale,
    };

    switch (cat) {
      case "OPERATING_WC":
        workingCapitalChanges.push(line);
        break;
      case "INVESTING":
        investingItems.push(line);
        break;
      case "FINANCING":
        financingItems.push(line);
        break;
      case "UNCATEGORIZED":
        uncategorized.push(line);
        break;
      case "OPERATING_NONCASH":
        // BS-side of depreciation (accum dep) lands in INVESTING above; the
        // P&L add-back is computed separately. Shouldn't hit here.
        break;
    }
  }

  // Section totals.
  const nonCashTotal = nonCashAddBacks.reduce((acc, l) => acc.plus(l.cashImpact), new Decimal(0));
  const wcTotal = workingCapitalChanges.reduce((acc, l) => acc.plus(l.cashImpact), new Decimal(0));
  const operatingCashFlow = pnl.netIncome.plus(nonCashTotal).plus(wcTotal);

  const investingCashFlow = investingItems.reduce((acc, l) => acc.plus(l.cashImpact), new Decimal(0));
  const financingCashFlow = financingItems.reduce((acc, l) => acc.plus(l.cashImpact), new Decimal(0));

  const netCashFlow = operatingCashFlow.plus(investingCashFlow).plus(financingCashFlow);

  // Reconcile against the actual BS-driven Δ cash. Anything not within
  // a penny is either a classification gap (UNCATEGORIZED) or an ASC 842
  // adjustment we deferred.
  const reconcilingDifference = netCashFlow.minus(actualCashChange);
  const reconciles = reconcilingDifference.abs().lessThan(new Decimal("0.01"));

  return {
    scope: { entityCode: scope.entityCode, bookCode },
    periodStart,
    periodEnd,
    netIncome: pnl.netIncome,
    nonCashAddBacks,
    workingCapitalChanges,
    operatingCashFlow,
    investingItems,
    investingCashFlow,
    financingItems,
    financingCashFlow,
    netCashFlow,
    beginningCash,
    endingCash,
    actualCashChange,
    reconcilingDifference,
    reconciles,
    uncategorized,
  };
}
