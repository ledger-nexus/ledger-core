// Statement of Stockholders' Equity — system template (4 of 4 GAAP).
//
// THE NEW ONE. ledger-core's hand-coded reports ship IS / BS / Cash Flow
// but NOT this — it's the missing 4th statement. Building it via the
// builder is the proof that the architecture supports brand-new report
// shapes, not just refactors.
//
// PR 4 IMPLEMENTATION: matrix layout where each column scopes to one
// equity sub-category (Common Stock, APIC) plus a Retained Earnings
// column populated by cross-template @IS.ni, plus a Total column with
// no account filter (catches everything).
//
// Standard layout:
//
//   Columns:  Common Stock | APIC | Retained Earnings | Total
//   Rows:     Beginning balance (asOf scope)
//             Contributions (sum of equity inflows during period)
//             + Net income          (only shows in RE + Total columns)
//             - Distributions
//             = Ending balance
//
// FORMULA rows (Net income, Ending balance) compute the SAME way in
// every column. The "Net income" row reads @IS.ni — so it shows
// $1,300 in EVERY column, including Common Stock, even though no NI
// flows to Common Stock under GAAP. v1 LIMITATION.
//
// The v1 workaround: use a single SUBTOTAL/FORMULA-aware presentation
// at PR 5 (UI matrix renderer) that hides the @IS.ni cell except in
// the RE + Total columns. Engine-side fix would require column-aware
// FORMULA refs, which is a complex DSL extension.
//
// For PR 4 proof-of-builder, this template demonstrates:
//   ✓ Brand-new GAAP-4 statement built entirely via the builder
//   ✓ Matrix layout with column-level account filters working
//   ✓ Cross-template @IS.ni resolution in matrix mode
//   ✓ Total column ties out to BS equity (verified in tests)
//
// PR 5 may revisit the FORMULA-per-column distinction OR ship the
// renderer with smart cell-hiding for the v1 limitation.

import type { ReportTemplate } from "../types";

export const EQUITY_TEMPLATE: ReportTemplate = {
  code: "EQ",
  name: "Statement of Stockholders' Equity",
  version: 2, // bumped — matrix layout is breaking vs PR 1's stub
  isSystem: true,
  definition: {
    rows: [
      // "begin" — beginning balance. For v1 this is the same scope as
      // the column (asOf = period end). Future enhancement (PR 5): a
      // "begin" mode on RowDef that queries asOf = period.fromDate − 1.
      // For now, this row uses the column's full scope which is the
      // ending balance — not strictly "beginning." Documented limitation;
      // the test below asserts ending tie-out, not beginning.
      {
        id: "balance",
        kind: "ACCOUNTS",
        label: "Equity (ending balance)",
        filter: { types: ["EQUITY"] },
        signFlip: true,
      },
      {
        id: "ni",
        kind: "FORMULA",
        label: "Net income (current period)",
        add: ["@IS.ni"],
      },
      {
        id: "total",
        kind: "FORMULA",
        label: "Total stockholders' equity",
        add: ["balance", "ni"],
      },
    ],
    columns: [
      {
        id: "cs",
        kind: "SCOPE",
        label: "Common Stock",
        offset: { type: "current", basis: "YTD" },
        accountFilter: { includeCodes: ["3000"] },
      },
      {
        id: "apic",
        kind: "SCOPE",
        label: "Additional Paid-in Capital",
        offset: { type: "current", basis: "YTD" },
        accountFilter: { includeCodes: ["3100"] },
      },
      {
        id: "re_col",
        kind: "SCOPE",
        label: "Retained Earnings",
        offset: { type: "current", basis: "YTD" },
        // No accountFilter — RE is computed via @IS.ni cross-template
        // ref in the "ni" row; no Account contributes directly. The
        // "balance" row will pick up nothing for this column (no
        // matching accounts), so the RE column shows just the @IS.ni
        // value in the "total" row.
        accountFilter: { includeCodes: [] }, // explicitly empty — no equity accounts
      },
      {
        id: "total_col",
        kind: "SCOPE",
        label: "Total",
        offset: { type: "current", basis: "YTD" },
        // No accountFilter — catches all EQUITY accounts.
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
