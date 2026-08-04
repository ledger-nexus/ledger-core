// Standard chart of accounts for a small SaaS company.
//
// Numbering convention:
//   1xxx — Assets
//   2xxx — Liabilities
//   3xxx — Equity
//   4xxx — Revenue
//   5xxx-9xxx — Expenses
//
// This is deliberately small (~20 accounts). A real SaaS company would have
// 100-200, but for portfolio demos, more accounts ≠ more impressive.

import { AccountType, NormalBalance } from "../accounting/types";

// v0.8 FX Phase 4a — ASC 830 translation method. Mirrors the Prisma
// enum. Default per account type (when seed leaves it undefined):
//   ASSET / LIABILITY → CURRENT_RATE
//   EQUITY            → HISTORICAL
//   REVENUE / EXPENSE → WEIGHTED_AVG
// FX_GAIN_LOSS subtype overrides to EXCLUDED — that account is
// already in reporting currency at posting time, must not re-translate.
export type TranslationCategory =
  | "CURRENT_RATE"
  | "HISTORICAL"
  | "WEIGHTED_AVG"
  | "EXCLUDED";

/**
 * Derive the default translation category from an account's type
 * and subtype. The migration backfill uses the same logic; the chart
 * seed code uses this so new accounts get a sensible default without
 * the seed author having to remember the ASC 830 mechanics.
 */
export function defaultTranslationCategory(input: {
  type: AccountType;
  subtype?: string;
}): TranslationCategory {
  // The realized-FX account is itself the translation result; do not
  // re-translate. Same rule applies to any account that's denominated
  // in reporting currency at posting time.
  if (input.subtype?.startsWith("FX_GAIN_LOSS")) return "EXCLUDED";
  if (input.type === "ASSET" || input.type === "LIABILITY") return "CURRENT_RATE";
  if (input.type === "EQUITY") return "HISTORICAL";
  // REVENUE + EXPENSE
  return "WEIGHTED_AVG";
}

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  isContra?: boolean;
  isControlAccount?: boolean;
  isBank?: boolean;
  // ASC 830 / IAS 21: true for cash, receivables, payables, and debt — the
  // accounts whose foreign-currency balances get re-measured at the period-
  // end CLOSE rate. Non-monetary accounts (inventory, fixed assets, prepaids,
  // equity) stay at historical rate and are omitted from revaluation.
  isMonetary?: boolean;
  subtype?: string;
  /**
   * v0.8 FX Phase 4a — explicit override for ASC 830 translation
   * method. When omitted, the seed path computes the default from
   * type + subtype via defaultTranslationCategory. Set explicitly only
   * to override the default (rare — most accounts follow the
   * type-based pattern).
   */
  translationCategory?: TranslationCategory;
}

// Shared chart (entityId = null at seed time). Mark control accounts and bank
// accounts so sub-ledger consumers (AR/AP open items in the next batch) can
// find their roll-up targets without string matching.
export const CHART_OF_ACCOUNTS: SeedAccount[] = [
  // ---- Assets ----
  // Cash + receivables are monetary (revalued at the CLOSE rate). isMonetary
  // drives the ASC 830 revaluation walk; isBank/isControlAccount are unrelated
  // roll-up tags.
  { code: "1000", name: "Cash — Operating", type: "ASSET", normalBalance: "DEBIT", isBank: true, isMonetary: true, subtype: "CASH" },
  { code: "1010", name: "Cash — Payroll", type: "ASSET", normalBalance: "DEBIT", isBank: true, isMonetary: true, subtype: "CASH" },
  { code: "1200", name: "Accounts Receivable", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, isMonetary: true, subtype: "AR_TRADE" },
  // Intercompany receivable (sub-A's "Due from Sub-B"). Eliminated at
  // consolidation; subtype = DUE_FROM_AFFILIATE triggers the rule. Monetary —
  // a foreign-currency intercompany balance revalues like any receivable.
  { code: "1300", name: "Due from Affiliates", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, isMonetary: true, subtype: "DUE_FROM_AFFILIATE" },
  // Allowance for Doubtful Accounts (contra-AR). Bad debt write-offs credit
  // AR direct in v0.4-alpha; full allowance-method accounting (estimate + apply)
  // lands when a customer engagement asks for it.
  {
    code: "1210",
    name: "Allowance for Doubtful Accounts",
    type: "ASSET",
    normalBalance: "CREDIT",
    isContra: true,
    subtype: "ALLOWANCE_DOUBTFUL",
  },
  { code: "1400", name: "Prepaid Expenses", type: "ASSET", normalBalance: "DEBIT", subtype: "PREPAID" },
  { code: "1500", name: "Computer Equipment", type: "ASSET", normalBalance: "DEBIT", subtype: "FIXED_ASSET" },
  {
    code: "1510",
    name: "Accumulated Depreciation — Equipment",
    type: "ASSET",
    normalBalance: "CREDIT", // contra
    isContra: true,
    subtype: "ACCUM_DEPR",
  },
  // Right-of-Use asset (ASC 842 operating leases). Tax book never uses
  // this account because TAX_CASH_BASIS doesn't capitalize leases.
  { code: "1600", name: "Right-of-Use Asset — Leases", type: "ASSET", normalBalance: "DEBIT", subtype: "ROU_ASSET" },

  // ---- Liabilities ----
  // Trade payables + intercompany payables are monetary. Accrued/deferred-rev/
  // tax-payable are settled in functional currency in our model and stay
  // non-monetary (no revaluation) — flip isMonetary if a foreign-denominated
  // accrual is ever modeled.
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT", isControlAccount: true, isMonetary: true, subtype: "AP_TRADE" },
  { code: "2100", name: "Accrued Expenses", type: "LIABILITY", normalBalance: "CREDIT", subtype: "ACCRUED" },
  { code: "2200", name: "Deferred Revenue", type: "LIABILITY", normalBalance: "CREDIT", subtype: "DEFERRED_REV" },
  { code: "2300", name: "Sales Tax Payable", type: "LIABILITY", normalBalance: "CREDIT", subtype: "TAX_PAYABLE" },
  // Intercompany payable (sub-B's "Due to Sub-A"). Eliminated at consolidation.
  { code: "2400", name: "Due to Affiliates", type: "LIABILITY", normalBalance: "CREDIT", isControlAccount: true, isMonetary: true, subtype: "DUE_TO_AFFILIATE" },
  // Lease liability (ASC 842 operating + finance). Paired with the ROU asset.
  { code: "2600", name: "Lease Liability — Current", type: "LIABILITY", normalBalance: "CREDIT", subtype: "LEASE_LIABILITY" },

  // ---- Equity ----
  { code: "3000", name: "Common Stock", type: "EQUITY", normalBalance: "CREDIT" },
  { code: "3100", name: "Additional Paid-in Capital", type: "EQUITY", normalBalance: "CREDIT" },

  // ---- Revenue ----
  { code: "4000", name: "Subscription Revenue", type: "REVENUE", normalBalance: "CREDIT" },
  { code: "4100", name: "Professional Services Revenue", type: "REVENUE", normalBalance: "CREDIT" },
  // Intercompany revenue/expense — eliminated at consolidation so the group
  // doesn't show revenue it earned from itself.
  { code: "4900", name: "Intercompany Revenue", type: "REVENUE", normalBalance: "CREDIT", subtype: "INTERCOMPANY_REV" },

  // ---- Expenses ----
  { code: "5000", name: "Cost of Revenue — Hosting", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5100", name: "Cost of Revenue — Support", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5900", name: "Intercompany Expense", type: "EXPENSE", normalBalance: "DEBIT", subtype: "INTERCOMPANY_EXP" },
  { code: "6000", name: "Salaries & Wages", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6100", name: "Payroll Taxes", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6200", name: "Benefits", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7000", name: "Software & SaaS Tools", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7100", name: "Marketing", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7200", name: "Professional Fees", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7300", name: "Office & General", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7400", name: "Lease Expense — Operating", type: "EXPENSE", normalBalance: "DEBIT", subtype: "LEASE_EXPENSE" },
  { code: "7500", name: "Bad Debt Expense", type: "EXPENSE", normalBalance: "DEBIT", subtype: "BAD_DEBT" },
  { code: "8000", name: "Depreciation Expense", type: "EXPENSE", normalBalance: "DEBIT", subtype: "DEPRECIATION" },
  // Gain/loss on disposal of fixed assets. Single account for both directions
  // (sign indicates gain or loss); separate accounts can be added later if
  // financial statement presentation requires it.
  { code: "8100", name: "Gain/Loss on Disposal of Assets", type: "EXPENSE", normalBalance: "DEBIT", subtype: "DISPOSAL_GAIN_LOSS" },
  // Interest expense — used by ASC 842 finance leases. Operating leases
  // combine interest + amortization into the lease expense line (7400).
  { code: "8200", name: "Interest Expense", type: "EXPENSE", normalBalance: "DEBIT", subtype: "INTEREST" },
  // FX gain/loss (ASC 830 / IAS 21). Both directions post to one account each;
  // the sign of the period movement indicates gain (credit) vs loss (debit),
  // same single-account convention as 8100 Disposal Gain/Loss.
  //   - UNREALIZED: period-end re-measurement of open foreign-currency
  //     monetary balances. Conventionally reversed at the start of the next
  //     period so only the realized portion remains when the item settles.
  //   - REALIZED: the FX difference locked in when a foreign-currency item
  //     actually settles (payment received / bill paid at a different rate).
  { code: "8300", name: "Unrealized FX Gain/Loss", type: "EXPENSE", normalBalance: "DEBIT", subtype: "FX_GAIN_LOSS_UNREALIZED" },
  { code: "8310", name: "Realized FX Gain/Loss", type: "EXPENSE", normalBalance: "DEBIT", subtype: "FX_GAIN_LOSS_REALIZED" },
];
