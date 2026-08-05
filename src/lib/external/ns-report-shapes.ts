// v0.9 NS SuiteAnalytics Phase 3 — shape mapper.
//
// Translates ledger-core-native report shapes (TrialBalanceRow,
// IncomeStatement, BalanceSheet) into NS-canonical JSON that
// SuiteAnalytics REST responses use. Pure functions — no DB access,
// no I/O. Tests against canned sample shapes saved from real NS
// exports for fidelity verification.
//
// Field-mapping table (from observed NS SuiteAnalytics responses):
//
//   | ledger-core           | NS                            |
//   |-----------------------|-------------------------------|
//   | accountCode           | account.acctnumber            |
//   | accountName           | account.acctname              |
//   | type (5-way enum)     | account.accttype              |
//   | debit                 | debitamount                   |
//   | credit                | creditamount                  |
//   | balance               | amount                        |
//   | entityCode (input)    | subsidiary.internalid         |
//   | bookCode (input)      | accountingBook.internalid     |
//
// AccountType mapping: ledger-core's 5-way enum
// (ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE) → NS's 14+ types is lossy.
// Phase 3 picks the most common NS type per ledger-core enum value.
// Per-row subtype-aware refinement (Bank vs OthCurAsset, etc.) is
// deferred to a follow-up PR — for now the primary type lands the
// most common operator case.

import type { AccountType } from "@prisma/client";
import type { Decimal } from "@/lib/utils/decimal";

/** Most common NS accttype per ledger-core enum value (fallback). */
const ACCT_TYPE_BY_LEDGER_TYPE: Record<AccountType, string> = {
  ASSET: "OthCurAsset",
  LIABILITY: "OthCurLiab",
  EQUITY: "Equity",
  REVENUE: "Income",
  EXPENSE: "Expense",
};

/**
 * Refined NS accttype per ledger-core Account.subtype. Driven by the
 * subtypes actually used in src/lib/db/chart-of-accounts.ts.
 *
 * NS's accttype taxonomy is much finer-grained than ledger-core's
 * 5-way AccountType enum. When the importer knows the subtype (via
 * NS Account.accttype on the way in, OR via the chart-of-accounts
 * registry on native data), we can emit the correct NS-side value
 * instead of the catch-all "OthCurAsset" / "OthCurLiab".
 */
const REFINED_BY_SUBTYPE: Record<string, string> = {
  CASH: "Bank",
  AR_TRADE: "AcctRec",
  AP_TRADE: "AcctPay",
  ALLOWANCE_DOUBTFUL: "OthCurAsset",
  PREPAID: "OthCurAsset",
  FIXED_ASSET: "FixedAsset",
  ACCUM_DEPR: "FixedAsset",   // contra-asset, still under FixedAsset section
  ROU_ASSET: "FixedAsset",
  DUE_FROM_AFFILIATE: "OthCurAsset",
  ACCRUED: "OthCurLiab",
  DEFERRED_REV: "OthCurLiab",
  TAX_PAYABLE: "OthCurLiab",
  DUE_TO_AFFILIATE: "OthCurLiab",
  LEASE_LIABILITY: "LongTermLiab",
  INTERCOMPANY_REV: "Income",
  INTERCOMPANY_EXP: "Expense",
  BAD_DEBT: "Expense",
  DEPRECIATION: "Expense",
  LEASE_EXPENSE: "Expense",
  FX_GAIN_LOSS: "OthIncome",       // ambiguous — defaults to OthIncome
  DISPOSAL_GAIN_LOSS: "OthIncome", // ambiguous — defaults to OthIncome
  INTEREST: "OthIncome",           // INTEREST on income side; expense side rare
};

/**
 * Per-account hint set the route passes alongside the report rows.
 * Keyed by accountCode. Missing entries fall back to the primary-type
 * default, so the mapper degrades gracefully when the route can't
 * fetch hints (or when the report contains accounts the chart
 * doesn't cover).
 */
export interface AccountSubtypeHint {
  subtype: string | null;
  isBank: boolean;
}

function mapAcctType(t: AccountType, hint?: AccountSubtypeHint): string {
  if (hint) {
    if (hint.isBank) return "Bank";
    if (hint.subtype && REFINED_BY_SUBTYPE[hint.subtype]) {
      return REFINED_BY_SUBTYPE[hint.subtype];
    }
  }
  return ACCT_TYPE_BY_LEDGER_TYPE[t];
}

// ─── Inputs (ledger-core-native, narrowed from reports.ts) ──────────

export interface NativeTrialBalanceRow {
  accountCode: string;
  accountName: string;
  type: AccountType;
  debit: Decimal;
  credit: Decimal;
  balance: Decimal;
  parentCode: string | null;
  isContra: boolean;
}

export interface NativeFinancialStatementRow {
  code: string;
  name: string;
  amount: Decimal;
  parentCode: string | null;
  isContra: boolean;
}

export interface ShapeContext {
  /** NS Subsidiary internalid from the operator's request. */
  subsidiaryInternalid: string;
  /** NS AccountingBook internalid from the operator's request. */
  accountingBookInternalid: string;
}

// ─── Outputs (NS-canonical) ─────────────────────────────────────────

export interface NsTrialBalanceResponse {
  reportName: "Trial Balance";
  subsidiary: { internalid: string };
  accountingBook: { internalid: string };
  asOf: string;
  rows: Array<{
    account: { acctnumber: string; acctname: string; accttype: string };
    debitamount: string;
    creditamount: string;
    amount: string;
  }>;
  totals: { debitamount: string; creditamount: string };
}

export interface NsIncomeStatementResponse {
  reportName: "Income Statement";
  subsidiary: { internalid: string };
  accountingBook: { internalid: string };
  fromDate: string;
  toDate: string;
  income: Array<{
    account: { acctnumber: string; acctname: string; accttype: string };
    amount: string;
  }>;
  expenses: Array<{
    account: { acctnumber: string; acctname: string; accttype: string };
    amount: string;
  }>;
  totals: {
    totalIncome: string;
    totalExpenses: string;
    netIncome: string;
  };
}

export interface NsBalanceSheetResponse {
  reportName: "Balance Sheet";
  subsidiary: { internalid: string };
  accountingBook: { internalid: string };
  asOf: string;
  assets: Array<{
    account: { acctnumber: string; acctname: string; accttype: string };
    amount: string;
  }>;
  liabilities: Array<{
    account: { acctnumber: string; acctname: string; accttype: string };
    amount: string;
  }>;
  equity: Array<{
    account: { acctnumber: string; acctname: string; accttype: string };
    amount: string;
  }>;
  totals: {
    totalAssets: string;
    totalLiabilities: string;
    totalEquity: string;
    retainedEarnings: string;
    totalLiabilitiesAndEquity: string;
  };
  balances: boolean;
}

// ─── Mappers ────────────────────────────────────────────────────────

export function toNsTrialBalance(
  rows: NativeTrialBalanceRow[],
  totals: { totalDebit: Decimal; totalCredit: Decimal },
  asOf: string,
  ctx: ShapeContext,
  /** Optional per-accountCode hints for refined NS accttype. */
  subtypeHints?: Record<string, AccountSubtypeHint>
): NsTrialBalanceResponse {
  return {
    reportName: "Trial Balance",
    subsidiary: { internalid: ctx.subsidiaryInternalid },
    accountingBook: { internalid: ctx.accountingBookInternalid },
    asOf,
    rows: rows.map((r) => ({
      account: {
        acctnumber: r.accountCode,
        acctname: r.accountName,
        accttype: mapAcctType(r.type, subtypeHints?.[r.accountCode]),
      },
      debitamount: r.debit.toFixed(4),
      creditamount: r.credit.toFixed(4),
      amount: r.balance.toFixed(4),
    })),
    totals: {
      debitamount: totals.totalDebit.toFixed(4),
      creditamount: totals.totalCredit.toFixed(4),
    },
  };
}

export function toNsIncomeStatement(
  income: NativeFinancialStatementRow[],
  expenses: NativeFinancialStatementRow[],
  totals: {
    totalRevenue: Decimal;
    totalExpenses: Decimal;
    netIncome: Decimal;
  },
  range: { fromDate: string; toDate: string },
  ctx: ShapeContext,
  subtypeHints?: Record<string, AccountSubtypeHint>
): NsIncomeStatementResponse {
  return {
    reportName: "Income Statement",
    subsidiary: { internalid: ctx.subsidiaryInternalid },
    accountingBook: { internalid: ctx.accountingBookInternalid },
    fromDate: range.fromDate,
    toDate: range.toDate,
    income: income.map((r) => ({
      account: {
        acctnumber: r.code,
        acctname: r.name,
        accttype: mapAcctType("REVENUE", subtypeHints?.[r.code]),
      },
      amount: r.amount.toFixed(4),
    })),
    expenses: expenses.map((r) => ({
      account: {
        acctnumber: r.code,
        acctname: r.name,
        accttype: mapAcctType("EXPENSE", subtypeHints?.[r.code]),
      },
      amount: r.amount.toFixed(4),
    })),
    totals: {
      totalIncome: totals.totalRevenue.toFixed(4),
      totalExpenses: totals.totalExpenses.toFixed(4),
      netIncome: totals.netIncome.toFixed(4),
    },
  };
}

// ─── Consolidation (NS SubsidiaryElimination) ──────────────────────

export interface NativeConsolidatedRow {
  accountCode: string;
  accountName: string;
  type: AccountType;
  subtype: string | null;
  perEntity: { entityCode: string; debit: Decimal; credit: Decimal }[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  isEliminated: boolean;
  eliminatedDebit: Decimal;
  eliminatedCredit: Decimal;
  consolidatedDebit: Decimal;
  consolidatedCredit: Decimal;
  consolidatedBalance: Decimal;
}

export interface NativeConsolidatedEntity {
  code: string;
  name: string;
  isRoot: boolean;
  functionalCurrencyId: string;
}

export interface ConsolidationShapeContext extends ShapeContext {
  rootEntityName: string;
  /** Map from ledger-core entityCode → NS subsidiary internalid for perEntity rows. */
  entityCodeToNsInternalid: Record<string, string>;
}

export interface NsConsolidatedTrialBalanceResponse {
  reportName: "Consolidated Trial Balance";
  rootSubsidiary: { internalid: string; name: string };
  accountingBook: { internalid: string };
  asOf: string;
  entities: Array<{
    internalid: string;
    code: string;
    name: string;
    isRoot: boolean;
    currency: string;
  }>;
  rows: Array<{
    account: { acctnumber: string; acctname: string; accttype: string };
    perSubsidiary: Array<{
      internalid: string;
      debit: string;
      credit: string;
    }>;
    preEliminationDebit: string;
    preEliminationCredit: string;
    eliminatedDebit: string;
    eliminatedCredit: string;
    consolidatedDebit: string;
    consolidatedCredit: string;
    isEliminated: boolean;
  }>;
  totals: {
    preEliminationDebit: string;
    preEliminationCredit: string;
    consolidatedDebit: string;
    consolidatedCredit: string;
    /** Always null: ASC 830 translation dispositioned unmerged (v1.27). */
    cumulativeTranslationAdjustment: null;
  };
  /**
   * Keys preserved for NS-shape-strict BI adapters, values pinned:
   * this deployment consolidates under the remeasurement method
   * (PROJECT_STATUS v1.27) — no CTA, no per-entity translation rates.
   */
  translation: {
    active: false;
    ratesByEntity: null;
    cta: null;
  };
  balances: boolean;
}

export function toNsConsolidatedTrialBalance(
  input: {
    entities: NativeConsolidatedEntity[];
    rows: NativeConsolidatedRow[];
    preEliminationTotalDebit: Decimal;
    preEliminationTotalCredit: Decimal;
    consolidatedTotalDebit: Decimal;
    consolidatedTotalCredit: Decimal;
    balances: boolean;
  },
  asOf: string,
  ctx: ConsolidationShapeContext,
  subtypeHints?: Record<string, AccountSubtypeHint>
): NsConsolidatedTrialBalanceResponse {
  // NS perSubsidiary row keys by internalid. Build the reverse map for
  // the per-row translation. Unknown entities (entityCode not in the
  // mapping) get an empty internalid — operators should pre-import
  // every subsidiary in the hierarchy.
  const nsIdFor = (entityCode: string): string =>
    ctx.entityCodeToNsInternalid[entityCode] ?? "";

  return {
    reportName: "Consolidated Trial Balance",
    rootSubsidiary: {
      internalid: ctx.subsidiaryInternalid,
      name: ctx.rootEntityName,
    },
    accountingBook: { internalid: ctx.accountingBookInternalid },
    asOf,
    entities: input.entities.map((e) => ({
      internalid: nsIdFor(e.code),
      code: e.code,
      name: e.name,
      isRoot: e.isRoot,
      currency: e.functionalCurrencyId,
    })),
    rows: input.rows.map((r) => ({
      account: {
        acctnumber: r.accountCode,
        acctname: r.accountName,
        accttype: mapAcctType(r.type, subtypeHints?.[r.accountCode]),
      },
      perSubsidiary: r.perEntity.map((p) => ({
        internalid: nsIdFor(p.entityCode),
        debit: p.debit.toFixed(4),
        credit: p.credit.toFixed(4),
      })),
      preEliminationDebit: r.totalDebit.toFixed(4),
      preEliminationCredit: r.totalCredit.toFixed(4),
      eliminatedDebit: r.eliminatedDebit.toFixed(4),
      eliminatedCredit: r.eliminatedCredit.toFixed(4),
      consolidatedDebit: r.consolidatedDebit.toFixed(4),
      consolidatedCredit: r.consolidatedCredit.toFixed(4),
      isEliminated: r.isEliminated,
    })),
    totals: {
      preEliminationDebit: input.preEliminationTotalDebit.toFixed(4),
      preEliminationCredit: input.preEliminationTotalCredit.toFixed(4),
      consolidatedDebit: input.consolidatedTotalDebit.toFixed(4),
      consolidatedCredit: input.consolidatedTotalCredit.toFixed(4),
      cumulativeTranslationAdjustment: null,
    },
    translation: { active: false, ratesByEntity: null, cta: null },
    balances: input.balances,
  };
}

export function toNsBalanceSheet(
  sections: {
    assets: NativeFinancialStatementRow[];
    liabilities: NativeFinancialStatementRow[];
    equity: NativeFinancialStatementRow[];
  },
  totals: {
    totalAssets: Decimal;
    totalLiabilities: Decimal;
    totalEquity: Decimal;
    retainedEarnings: Decimal;
    totalLiabilitiesAndEquity: Decimal;
  },
  balances: boolean,
  asOf: string,
  ctx: ShapeContext,
  subtypeHints?: Record<string, AccountSubtypeHint>
): NsBalanceSheetResponse {
  return {
    reportName: "Balance Sheet",
    subsidiary: { internalid: ctx.subsidiaryInternalid },
    accountingBook: { internalid: ctx.accountingBookInternalid },
    asOf,
    assets: sections.assets.map((r) => ({
      account: {
        acctnumber: r.code,
        acctname: r.name,
        accttype: mapAcctType("ASSET", subtypeHints?.[r.code]),
      },
      amount: r.amount.toFixed(4),
    })),
    liabilities: sections.liabilities.map((r) => ({
      account: {
        acctnumber: r.code,
        acctname: r.name,
        accttype: mapAcctType("LIABILITY", subtypeHints?.[r.code]),
      },
      amount: r.amount.toFixed(4),
    })),
    equity: sections.equity.map((r) => ({
      account: {
        acctnumber: r.code,
        acctname: r.name,
        accttype: mapAcctType("EQUITY", subtypeHints?.[r.code]),
      },
      amount: r.amount.toFixed(4),
    })),
    totals: {
      totalAssets: totals.totalAssets.toFixed(4),
      totalLiabilities: totals.totalLiabilities.toFixed(4),
      totalEquity: totals.totalEquity.toFixed(4),
      retainedEarnings: totals.retainedEarnings.toFixed(4),
      totalLiabilitiesAndEquity: totals.totalLiabilitiesAndEquity.toFixed(4),
    },
    balances,
  };
}
