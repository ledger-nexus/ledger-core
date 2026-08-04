// Cash Flow Statement — system template (3 of 4 GAAP financial statements).
//
// INDIRECT METHOD. Standard 3-section layout:
//
//   Cash from operating activities:
//     Net income (cross-template @IS.ni)
//     + Depreciation, amortization, other non-cash
//     + Δ working capital (-Δ AR, +Δ AP, -Δ Inventory, +Δ Deferred rev, etc.)
//     = Net cash from operations
//
//   Cash from investing activities:
//     - Capital expenditures (additions to PP&E)
//     +/- Asset sales / acquisitions
//     = Net cash from investing
//
//   Cash from financing activities:
//     + Stock issuance / contributions
//     - Distributions / dividends
//     +/- Debt issuance / repayment
//     - Lease payments (financing portion)
//     = Net cash from financing
//
//   Net change in cash = sum of all three
//   Beginning cash balance
//   = Ending cash balance
//
// HONEST CAVEAT (from the design doc):
//
//   The indirect-method math uses PERIOD_DELTA rows (closing balance −
//   opening balance for the period). This is a new RowDef kind the
//   existing reports.ts doesn't have. The row engine in PR 2 implements
//   it; until then this template just declares the structure.
//
//   The OPERATING / INVESTING / FINANCING classification heuristic
//   currently lives inside getCashFlowStatement (account.subtype + a
//   few special rules). For PR 1, we hard-code the subtype categories
//   into the template filters. PR 2's row engine uses these filters
//   directly; the heuristic moves from code to data.
//
//   If the row engine doesn't cleanly support PERIOD_DELTA, this
//   template stays declarative and the actual cash flow render
//   continues to call the existing getCashFlowStatement(). That's
//   the hybrid approach flagged in the design doc.

import type { ReportTemplate } from "../types";

export const CASH_FLOW_TEMPLATE: ReportTemplate = {
  code: "CF",
  name: "Statement of Cash Flows",
  version: 1,
  isSystem: true,
  definition: {
    rows: [
      {
        id: "header_op",
        kind: "HEADER",
        label: "Cash flows from operating activities",
      },
      {
        id: "ni",
        kind: "FORMULA",
        label: "Net income",
        add: ["@IS.ni"],
      },
      {
        id: "depr",
        kind: "ACCOUNTS",
        label: "Depreciation and amortization",
        filter: {
          types: ["EXPENSE"],
          subtypes: ["DEPRECIATION"],
        },
      },
      {
        id: "bad_debt",
        kind: "ACCOUNTS",
        label: "Bad debt expense (non-cash)",
        filter: {
          types: ["EXPENSE"],
          subtypes: ["BAD_DEBT"],
        },
      },
      {
        id: "delta_ar",
        kind: "PERIOD_DELTA",
        label: "Change in AR",
        filter: {
          types: ["ASSET"],
          subtypes: ["AR_TRADE"],
        },
        direction: "increase", // AR up = cash down → flip sign in row engine
      },
      {
        id: "delta_ap",
        kind: "PERIOD_DELTA",
        label: "Change in AP",
        filter: {
          types: ["LIABILITY"],
          subtypes: ["AP_TRADE"],
        },
        direction: "decrease", // AP up = cash up → preserve sign
      },
      {
        id: "delta_def_rev",
        kind: "PERIOD_DELTA",
        label: "Change in deferred revenue",
        filter: {
          types: ["LIABILITY"],
          subtypes: ["DEFERRED_REV"],
        },
        direction: "decrease",
      },
      {
        id: "delta_prepaid",
        kind: "PERIOD_DELTA",
        label: "Change in prepaid expenses",
        filter: {
          types: ["ASSET"],
          subtypes: ["PREPAID"],
        },
        direction: "increase",
      },
      {
        id: "net_op",
        kind: "FORMULA",
        label: "Net cash from operating activities",
        add: ["ni", "depr", "bad_debt", "delta_ap", "delta_def_rev"],
        subtract: ["delta_ar", "delta_prepaid"],
      },
      { id: "spacer_1", kind: "SPACER" },
      {
        id: "header_inv",
        kind: "HEADER",
        label: "Cash flows from investing activities",
      },
      {
        id: "capex",
        kind: "PERIOD_DELTA",
        label: "Capital expenditures",
        filter: {
          types: ["ASSET"],
          subtypes: ["FIXED_ASSET"],
        },
        direction: "increase", // PP&E up = cash down for capex
      },
      {
        id: "net_inv",
        kind: "FORMULA",
        label: "Net cash from investing activities",
        subtract: ["capex"],
      },
      { id: "spacer_2", kind: "SPACER" },
      {
        id: "header_fin",
        kind: "HEADER",
        label: "Cash flows from financing activities",
      },
      {
        id: "delta_equity",
        kind: "PERIOD_DELTA",
        label: "Equity contributions / (distributions)",
        filter: { types: ["EQUITY"] },
        direction: "decrease", // Equity up = cash up (contribution)
      },
      {
        id: "delta_lease",
        kind: "PERIOD_DELTA",
        label: "Change in lease liability",
        filter: {
          types: ["LIABILITY"],
          subtypes: ["LEASE_LIABILITY"],
        },
        direction: "decrease",
      },
      {
        id: "net_fin",
        kind: "FORMULA",
        label: "Net cash from financing activities",
        add: ["delta_equity", "delta_lease"],
      },
      { id: "spacer_3", kind: "SPACER" },
      {
        id: "net_change",
        kind: "FORMULA",
        label: "Net change in cash",
        add: ["net_op", "net_inv", "net_fin"],
      },
      {
        id: "beginning_cash",
        kind: "PERIOD_DELTA",
        label: "Cash at beginning of period",
        filter: {
          types: ["ASSET"],
          subtypes: ["CASH"],
        },
        // Special: this row uses the OPENING balance only, not a delta.
        // Row engine handles via direction = undefined for the "opening
        // balance" use case (vs. "increase"/"decrease" for proper deltas).
      },
      {
        id: "ending_cash",
        kind: "FORMULA",
        label: "Cash at end of period",
        add: ["beginning_cash", "net_change"],
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
    references: [
      {
        alias: "@IS.ni",
        templateCode: "IS",
        rowId: "ni",
      },
    ],
  },
};
