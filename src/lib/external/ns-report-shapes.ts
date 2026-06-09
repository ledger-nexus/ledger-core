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
import type { Decimal } from "decimal.js";

/** Most common NS accttype per ledger-core enum value. */
const ACCT_TYPE_BY_LEDGER_TYPE: Record<AccountType, string> = {
  ASSET: "OthCurAsset", // most NS-import-driven assets are current
  LIABILITY: "OthCurLiab",
  EQUITY: "Equity",
  REVENUE: "Income",
  EXPENSE: "Expense",
};

function mapAcctType(t: AccountType): string {
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
  ctx: ShapeContext
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
        accttype: mapAcctType(r.type),
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
  ctx: ShapeContext
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
        accttype: mapAcctType("REVENUE"),
      },
      amount: r.amount.toFixed(4),
    })),
    expenses: expenses.map((r) => ({
      account: {
        acctnumber: r.code,
        acctname: r.name,
        accttype: mapAcctType("EXPENSE"),
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
    cumulativeTranslationAdjustment: string;
  };
  translation: {
    active: boolean;
    ratesByEntity: Record<string, string | null>;
    cta: string;
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
    cumulativeTranslationAdjustment: Decimal;
    translationActive: boolean;
    translationRateByEntity: Record<string, string | null>;
    balances: boolean;
  },
  asOf: string,
  ctx: ConsolidationShapeContext
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
        accttype: mapAcctType(r.type),
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
      cumulativeTranslationAdjustment:
        input.cumulativeTranslationAdjustment.toFixed(4),
    },
    translation: {
      active: input.translationActive,
      ratesByEntity: input.translationRateByEntity,
      cta: input.cumulativeTranslationAdjustment.toFixed(4),
    },
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
  ctx: ShapeContext
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
        accttype: mapAcctType("ASSET"),
      },
      amount: r.amount.toFixed(4),
    })),
    liabilities: sections.liabilities.map((r) => ({
      account: {
        acctnumber: r.code,
        acctname: r.name,
        accttype: mapAcctType("LIABILITY"),
      },
      amount: r.amount.toFixed(4),
    })),
    equity: sections.equity.map((r) => ({
      account: {
        acctnumber: r.code,
        acctname: r.name,
        accttype: mapAcctType("EQUITY"),
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
