// Statement of Stockholders' Equity — system template (4 of 4 GAAP).
//
// THE NEW ONE. ledger-core's hand-coded reports ship IS / BS / Cash Flow
// but NOT this — it's the missing 4th statement. Building it via the
// builder is the proof that the architecture supports brand-new report
// shapes, not just refactors.
//
// Standard layout (matrix form):
//
//   Columns: Common Stock | APIC | Retained Earnings | AOCI | Total
//   Rows:    Beginning balance
//            + Net income                              (only RE column has value)
//            + Contributions / Stock issuance
//            - Distributions / Dividends
//            + Other comprehensive income              (only AOCI column has value)
//            = Ending balance
//
// IMPORTANT v1 LIMITATION (from the design doc):
//
//   The matrix presentation — where each column has its OWN account-
//   filter — needs a small extension to ColumnDef.scope. Specifically:
//   a column needs to be able to narrow the ACCOUNTS row filter further
//   (e.g., "Common Stock" column filters Equity rows to subtype CS only).
//
//   v1's ColumnDef doesn't support this. For PR 1 we declare the
//   template structure and document the gap. PR 2's column engine
//   either:
//
//     a) Extends ColumnDef.scope with a per-column AccountFilter that
//        gets merged with the row's filter
//     b) Ships Equity as a single-column "total equity roll-forward"
//        (less GAAP-correct but simpler)
//
//   PR 4 (this is the "proof-of-builder" PR) decides between (a) and (b)
//   based on what the column engine actually supports.
//
// Cross-template ref:
//   The "Net income" row reads IS.ni — same mechanism the BS uses for
//   Retained Earnings.

import type { ReportTemplate } from "../types";

export const EQUITY_TEMPLATE: ReportTemplate = {
  code: "EQ",
  name: "Statement of Stockholders' Equity",
  version: 1,
  isSystem: true,
  definition: {
    rows: [
      {
        id: "begin",
        kind: "ACCOUNTS",
        label: "Beginning balance",
        filter: { types: ["EQUITY"] },
        signFlip: true,
        // Note: Row engine in PR 2 needs to compute this as "balance
        // at period start" — which equals balance at prior period end.
        // Maps to an asOf override on the column scope.
      },
      {
        id: "ni",
        kind: "FORMULA",
        label: "Net income",
        add: ["@IS.ni"],
      },
      {
        id: "ctb",
        kind: "ACCOUNTS",
        label: "Contributions / stock issuance",
        // Equity contributions live in the chart as plain EQUITY type
        // (no EQUITY_CONTRIBUTION subtype today). Filter by codes for
        // the v1 Northwind chart. Operators editing per-tenant can
        // tighten to a subtype filter once their chart carries it.
        filter: {
          types: ["EQUITY"],
          includeCodes: ["3000", "3100"], // Common Stock + APIC
        },
        signFlip: true,
      },
      {
        id: "dist",
        kind: "ACCOUNTS",
        label: "Distributions / dividends",
        filter: {
          types: ["EQUITY"],
          // EQUITY_DISTRIBUTION / EQUITY_DIVIDEND subtypes don't exist
          // in the v1 Northwind chart. When they land, switch to:
          //   subtypes: ["EQUITY_DISTRIBUTION", "EQUITY_DIVIDEND"]
          // For now, this filter is intentionally empty (the row will
          // render 0) until the chart carries the subtype taxonomy.
          excludeCodes: ["3000", "3100"], // everything except contributions
        },
      },
      {
        id: "oci",
        kind: "ACCOUNTS",
        label: "Other comprehensive income",
        filter: {
          types: ["EQUITY"],
          // OCI subtype doesn't exist in the v1 chart. Same caveat
          // as Distributions above. PR 4 may either add the subtype
          // to the chart-of-accounts OR mark this row hidden.
          subtypes: ["OCI"],
        },
        signFlip: true,
      },
      {
        id: "end",
        kind: "FORMULA",
        label: "Ending balance",
        add: ["begin", "ni", "ctb", "oci"],
        subtract: ["dist"],
      },
    ],
    columns: [
      // v1 column shape: single "Total Equity" column. The proper
      // matrix layout (one column per equity sub-category) needs the
      // ColumnDef.scope.accountFilter extension flagged above.
      {
        id: "total",
        kind: "SCOPE",
        label: "Total Equity",
        offset: { type: "current", basis: "YTD" },
      },
      // FUTURE (PR 4 may add):
      // { id: "cs", kind: "SCOPE", label: "Common Stock",
      //   scope: { accountFilter: { includeCodes: ["3000"] } }, ... },
      // { id: "apic", kind: "SCOPE", label: "APIC",
      //   scope: { accountFilter: { includeCodes: ["3100"] } }, ... },
      // { id: "re", kind: "SCOPE", label: "Retained Earnings", ... },
      // { id: "aoci", kind: "SCOPE", label: "AOCI", ... },
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
