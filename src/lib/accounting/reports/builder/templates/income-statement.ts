// Income Statement — system template (1 of 4 GAAP financial statements).
//
// Layout follows the standard single-step / multi-step IS shape:
//   Revenue
//   - Cost of goods sold
//   = Gross profit
//   - Operating expenses
//   = Operating income
//   - Income tax expense
//   = Net income
//
// Filter strategy: type-based for v1. The current chart-of-accounts
// doesn't carry rich subtypes for REVENUE / COGS / OPEX / TAX
// (only EQUITY / EXPENSE / REVENUE at type level). When chart subtypes
// land, the templates can tighten to subtype-based filters.
//
// Sign conventions:
//   Revenue is credit-normal → signFlip: true so it presents positive
//   Expenses are debit-normal → no flip; present as positive subtractions
//   Net income = positive when revenue > expenses (consistent with
//   accountant convention; UI may render negatives in parens)
//
// COGS is a subtype of EXPENSE; we filter EXPENSE accounts by the COGS
// subtype. When subtypes aren't present in the chart (existing
// Northwind), the OPEX row falls back to "all EXPENSE" minus the
// COGS_CODES explicit list. Operators editing this template per-tenant
// can swap to subtype-based filters once their chart carries them.

import type { ReportTemplate } from "../types";

// Default COGS codes for charts without subtype taxonomy. Operators
// editing this template per-tenant should replace with their own COGS
// account list or switch to subtype-based filtering.
export const DEFAULT_COGS_CODES = ["5000", "5100", "5200"];
export const DEFAULT_INCOME_TAX_CODES = ["9000"];

export const INCOME_STATEMENT_TEMPLATE: ReportTemplate = {
  code: "IS",
  name: "Income Statement",
  version: 1,
  isSystem: true,
  definition: {
    rows: [
      {
        id: "header_rev",
        kind: "HEADER",
        label: "Revenue",
      },
      {
        id: "rev",
        kind: "ACCOUNTS",
        label: "Total revenue",
        filter: { types: ["REVENUE"] },
        signFlip: true,
        showAccountDetail: true,
      },
      { id: "spacer_1", kind: "SPACER" },
      {
        id: "header_cogs",
        kind: "HEADER",
        label: "Cost of goods sold",
      },
      {
        id: "cogs",
        kind: "ACCOUNTS",
        label: "Total COGS",
        filter: {
          types: ["EXPENSE"],
          subtypes: ["COGS"],
          // Fallback for charts without COGS subtype — see comment above.
          includeCodes: DEFAULT_COGS_CODES,
        },
        showAccountDetail: true,
      },
      {
        id: "gp",
        kind: "FORMULA",
        label: "Gross profit",
        add: ["rev"],
        subtract: ["cogs"],
      },
      { id: "spacer_2", kind: "SPACER" },
      {
        id: "header_opex",
        kind: "HEADER",
        label: "Operating expenses",
      },
      {
        id: "opex",
        kind: "ACCOUNTS",
        label: "Total operating expenses",
        filter: {
          types: ["EXPENSE"],
          excludeCodes: [...DEFAULT_COGS_CODES, ...DEFAULT_INCOME_TAX_CODES],
        },
        showAccountDetail: true,
      },
      {
        id: "opinc",
        kind: "FORMULA",
        label: "Operating income",
        add: ["gp"],
        subtract: ["opex"],
      },
      { id: "spacer_3", kind: "SPACER" },
      {
        id: "tax",
        kind: "ACCOUNTS",
        label: "Income tax expense",
        filter: {
          types: ["EXPENSE"],
          includeCodes: DEFAULT_INCOME_TAX_CODES,
        },
      },
      {
        id: "ni",
        kind: "FORMULA",
        label: "Net income",
        add: ["opinc"],
        subtract: ["tax"],
      },
    ],
    columns: [
      {
        id: "current",
        kind: "SCOPE",
        label: "Current period",
        offset: { type: "current", basis: "YTD" },
      },
    ],
    presentation: {
      moneyFormat: { decimals: 2, thousands: true, parens: true },
      showDrillDown: true,
      showAccountCodes: false,
    },
  },
};
