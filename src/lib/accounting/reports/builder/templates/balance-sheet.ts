// Balance Sheet — system template (2 of 4 GAAP financial statements).
//
// Standard layout: Assets / Liabilities + Equity = Assets.
//
//   Current assets (cash, AR, inventory, prepaid)
//   + Non-current assets (fixed assets, ROU)
//   = Total assets
//
//   Current liabilities (AP, accrued, deferred revenue, current lease liab)
//   + Non-current liabilities (long-term lease liab, long-term debt)
//   = Total liabilities
//
//   Equity (common stock, APIC, retained earnings, AOCI)
//   = Total equity
//
//   Total liabilities + equity
//
// CURRENT vs. NON-CURRENT split uses subtype where available, falling
// back to code ranges. Operators editing per-tenant can swap to
// subtype-only filtering once their chart carries subtypes uniformly.
//
// Sign conventions:
//   Assets are debit-normal → no flip (debit balances present positive)
//   Liabilities are credit-normal → signFlip: true to present positive
//   Equity is credit-normal → signFlip: true to present positive
//
// Retained Earnings is COMPUTED at runtime as cumulative net income
// from inception. The existing getBalanceSheet handles this synthetically
// (code "RE" with no Account row). For PR 1, we declare a RE row that
// the row engine (PR 2) will treat specially via cross-template
// reference to IS.ni — same mechanism the Equity Statement uses.

import type { ReportTemplate } from "../types";

export const BALANCE_SHEET_TEMPLATE: ReportTemplate = {
  code: "BS",
  name: "Balance Sheet",
  version: 1,
  isSystem: true,
  definition: {
    rows: [
      {
        id: "header_assets",
        kind: "HEADER",
        label: "Assets",
      },
      {
        id: "current_assets",
        kind: "ACCOUNTS",
        label: "Current assets",
        filter: {
          types: ["ASSET"],
          subtypes: ["CASH", "AR_TRADE", "ALLOWANCE_DOUBTFUL", "PREPAID"],
        },
        showAccountDetail: true,
      },
      {
        id: "noncurrent_assets",
        kind: "ACCOUNTS",
        label: "Non-current assets",
        filter: {
          types: ["ASSET"],
          subtypes: ["FIXED_ASSET", "ACCUM_DEPR", "ROU_ASSET", "DUE_FROM_AFFILIATE"],
        },
        showAccountDetail: true,
      },
      {
        id: "total_assets",
        kind: "SUBTOTAL",
        label: "Total assets",
        childIds: ["current_assets", "noncurrent_assets"],
      },
      { id: "spacer_1", kind: "SPACER" },
      {
        id: "header_liabilities",
        kind: "HEADER",
        label: "Liabilities",
      },
      {
        id: "current_liabilities",
        kind: "ACCOUNTS",
        label: "Current liabilities",
        filter: {
          types: ["LIABILITY"],
          subtypes: ["AP_TRADE", "ACCRUED", "DEFERRED_REV", "TAX_PAYABLE", "DUE_TO_AFFILIATE", "LEASE_LIABILITY"],
        },
        signFlip: true,
        showAccountDetail: true,
      },
      {
        id: "noncurrent_liabilities",
        kind: "ACCOUNTS",
        label: "Non-current liabilities",
        filter: {
          types: ["LIABILITY"],
          // Anything LIABILITY that's NOT current. v1 catches via exclude;
          // future enrichment: LEASE_LIABILITY_LT, LONG_TERM_DEBT subtypes.
          excludeCodes: [],
        },
        signFlip: true,
      },
      {
        id: "total_liabilities",
        kind: "SUBTOTAL",
        label: "Total liabilities",
        childIds: ["current_liabilities", "noncurrent_liabilities"],
      },
      { id: "spacer_2", kind: "SPACER" },
      {
        id: "header_equity",
        kind: "HEADER",
        label: "Equity",
      },
      {
        id: "equity_accounts",
        kind: "ACCOUNTS",
        label: "Equity accounts",
        filter: { types: ["EQUITY"] },
        signFlip: true,
        showAccountDetail: true,
      },
      {
        id: "retained_earnings",
        kind: "FORMULA",
        // Cross-template reference: cumulative net income via IS.
        // Resolved by row engine in PR 2 — see references[] below.
        label: "Retained earnings",
        add: ["@IS.ni"],
      },
      {
        id: "total_equity",
        kind: "SUBTOTAL",
        label: "Total equity",
        childIds: ["equity_accounts", "retained_earnings"],
      },
      { id: "spacer_3", kind: "SPACER" },
      {
        id: "total_liab_eq",
        kind: "SUBTOTAL",
        label: "Total liabilities + equity",
        childIds: ["total_liabilities", "total_equity"],
      },
    ],
    columns: [
      {
        id: "current",
        kind: "SCOPE",
        label: "Current",
        offset: { type: "current", basis: "MONTH" }, // asOf = current period end
      },
    ],
    presentation: {
      moneyFormat: { decimals: 2, thousands: true, parens: true },
      showDrillDown: true,
      showAccountCodes: false,
    },
    references: [
      {
        alias: "@IS.ni",
        templateCode: "IS",
        rowId: "ni",
      },
    ],
  },
};
