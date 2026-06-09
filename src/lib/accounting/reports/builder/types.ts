// Report Builder — type definitions.
//
// 4-layer architecture (per docs/report-builder-design.md):
//
//   Layer 4 PRESENTATION   ReportTemplate (DB-persisted DSL)
//   Layer 3 COLUMN ENGINE  Expands column DSL → scope tuples
//   Layer 2 ROW ENGINE     Walks row tree, filters accounts, computes formulas
//   Layer 1 MATH PRIMITIVE getAccountBalances → balance by account code
//
// PR 1 of the arc ships the SCHEMA + TYPES + 4 system templates only.
// The actual engines that consume these types ship in PR 2 (row) + PR 3
// (column).
//
// Types are intentionally Json-serializable: every RowDef / ColumnDef
// shape persists as-is into ReportTemplate.definition (Prisma Json column).

import type { AccountType } from "@prisma/client";

// ---- Layer 2: Row layout ------------------------------------------

/**
 * Filter for selecting accounts into a row.
 *
 * Order of precedence (when multiple criteria set):
 *   includeCodes wins absolutely (explicit override).
 *   Otherwise: types OR'd with subtypes OR'd with parentCodes.
 *   excludeCodes then subtracts.
 *
 * This mirrors how NetSuite's Financial Report Builder evaluates section
 * account criteria.
 */
export interface AccountFilter {
  types?: AccountType[];
  subtypes?: string[];
  parentCodes?: string[];
  includeCodes?: string[];
  excludeCodes?: string[];
  /**
   * Exclude accounts whose subtype is in this list. Added in PR 5 so
   * the BS template's `noncurrent_liabilities` row can say "all LIAB
   * accounts EXCEPT the current-liability subtypes" without enumerating
   * every code. Without this, the prior template used
   * `excludeCodes: []` which was a silent no-op and caused
   * current_liabilities + noncurrent_liabilities to double-count.
   */
  excludeSubtypes?: string[];
}

/**
 * Discriminated union of row kinds. ROW ENGINE branches on `kind` and
 * computes the cell value for each column accordingly.
 *
 * - ACCOUNTS — sum the matching account balances per AccountFilter.
 *   signFlip presents credit-normal accounts as positive (Revenue).
 *   showAccountDetail: if true, expand to per-account rows under this
 *   row; if false, roll up into one row.
 *
 * - SUBTOTAL — sum of other row values. childIds reference RowDef.ids.
 *   signFlip applies after the sum.
 *
 * - FORMULA — `add[] − subtract[]` expressed as row id arrays.
 *   v1 intentionally avoids a parser; 95% of GAAP statement formulas
 *   fit this shape (Gross Profit = Revenue − COGS).
 *
 * - PERIOD_DELTA — closing balance minus opening balance for the period.
 *   Used by Cash Flow Statement for working-capital changes (Δ AR, Δ AP).
 *   direction: "increase" means a positive number indicates an increase
 *   in the source account (e.g., AR went UP → cash WENT DOWN, so the
 *   working-capital adjustment flips sign).
 *
 * - SPACER / HEADER — presentation only, no value.
 */
export type RowDef =
  | {
      id: string;
      kind: "ACCOUNTS";
      label: string;
      filter: AccountFilter;
      signFlip?: boolean;
      showAccountDetail?: boolean;
    }
  | {
      id: string;
      kind: "SUBTOTAL";
      label: string;
      childIds: string[];
      signFlip?: boolean;
    }
  | {
      id: string;
      kind: "FORMULA";
      label: string;
      add?: string[];
      subtract?: string[];
    }
  | {
      id: string;
      kind: "PERIOD_DELTA";
      label: string;
      filter: AccountFilter;
      direction?: "increase" | "decrease";
    }
  | { id: string; kind: "SPACER" }
  | { id: string; kind: "HEADER"; label: string };

// ---- Layer 3: Column layout ---------------------------------------

/**
 * The concrete scope a column evaluates against. Either point-in-time
 * (asOf, for BS / Equity ending balance) or range (period, for IS /
 * Cash Flow).
 *
 * currencyCode: null = book's reporting currency. Override triggers
 * translation via the existing getTranslationRate helper.
 */
export interface ColumnScope {
  entityCode: string;
  bookCode: string;
  asOf?: string; // ISO date string — Json-serializable
  period?: { fromDate: string; toDate: string };
  currencyCode?: string;
}

/**
 * A period-offset DSL that resolves to a concrete scope at render time.
 *
 * Examples:
 *   { type: "current", basis: "YTD" }      → Jan 1 current year through asOf
 *   { type: "prior", basis: "YEAR", offset: 1 } → entire prior year
 *   { type: "absolute", asOf: "2026-06-30" } → fixed point in time
 */
export type PeriodOffset =
  | { type: "current"; basis: "MONTH" | "QUARTER" | "YEAR" | "YTD" | "QTD" }
  | { type: "prior"; basis: "MONTH" | "QUARTER" | "YEAR" | "YTD" | "QTD"; offset: number }
  | { type: "absolute"; asOf?: string; fromDate?: string; toDate?: string };

export type ColumnDef =
  | {
      id: string;
      kind: "SCOPE";
      label: string;
      // Either a concrete scope or an offset that resolves at render.
      // Concrete is used for ad-hoc reports; offset is used for system
      // templates so the same template renders for any period.
      scope?: ColumnScope;
      offset?: PeriodOffset;
      /**
       * Column-level account filter (PR 4). When set, narrows the
       * balance map BEFORE the row engine runs for this column.
       *
       * Used by matrix layouts like Statement of Stockholders' Equity
       * where each column scopes to one equity sub-category (Common
       * Stock, APIC, Retained Earnings). The column-level filter
       * intersects with the row's ACCOUNTS filter — both must match
       * for an account to contribute to a cell.
       *
       * FORMULA / SUBTOTAL / PERIOD_DELTA rows are unaffected (they
       * don't query accounts directly). Cross-template @aliases also
       * bypass column filters — a @IS.ni reference resolves to the
       * IS template's Net Income regardless of EQ column.
       */
      accountFilter?: AccountFilter;
    }
  | {
      id: string;
      kind: "VARIANCE";
      label: string;
      from: string; // column id
      to: string; // column id
      format: "money" | "percent";
    };

// ---- Layer 4: Template --------------------------------------------

export interface ReportPresentation {
  moneyFormat?: {
    decimals: number;
    thousands: boolean;
    parens: boolean; // negative numbers as (1,234) instead of -1,234
  };
  showDrillDown?: boolean;
  showAccountCodes?: boolean;
}

export interface CrossTemplateReference {
  alias: string; // "@IS.ni" — used in FORMULA add[]/subtract[] arrays
  templateCode: string; // "IS"
  rowId: string; // "ni"
}

export interface ReportTemplateDefinition {
  rows: RowDef[];
  columns: ColumnDef[];
  presentation: ReportPresentation;
  references?: CrossTemplateReference[];
}

export interface ReportTemplate {
  code: string; // "IS" / "BS" / "CF" / "EQ" / "MY-CUSTOM-1"
  name: string;
  version: number;
  isSystem: boolean; // true for the 4 GAAP defaults
  definition: ReportTemplateDefinition;
}

// ---- Render output (Layer 2/3 produce; Layer 4 consumes) ---------

export interface RenderedCell {
  value: string; // Decimal string — keep precision through serialization
  display: string; // Formatted per presentation
  drillDown?: {
    accountCodes: string[];
    scope: ColumnScope;
  };
}

export interface RenderedRow {
  id: string;
  label: string;
  cells: RenderedCell[]; // one per column
  indent?: number; // visual nesting from SUBTOTAL nodes
  isSubtotal?: boolean;
  isFormula?: boolean;
  isHeader?: boolean;
  isSpacer?: boolean;
}

export interface RenderedMatrix {
  template: ReportTemplate;
  columns: Array<{ id: string; label: string }>;
  rows: RenderedRow[];
}
