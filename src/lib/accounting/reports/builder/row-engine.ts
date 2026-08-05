// Layer 2: Row engine.
//
// Walks a RowDef tree + computes the value for each row given an
// already-fetched balance map. Returns RenderedRow[] aligned with one
// column (the column engine in PR 3 calls this once per column).
//
// PR 2 SCOPE:
//   - ACCOUNTS: sum filtered balances, apply signFlip
//   - SUBTOTAL: sum child row values, apply signFlip
//   - FORMULA: add[] − subtract[] (row ids OR @cross-template refs)
//   - SPACER / HEADER: no value
//
// PR 3 (deferred):
//   - PERIOD_DELTA: needs opening + closing balance maps; the column
//     engine handles fetching both. v1 PR 2 stubs this with value=0
//     and a TODO; the row engine returns it as a regular row but
//     value is 0 until PR 3 wires the deltas.
//
// CROSS-TEMPLATE REFERENCES (@IS.ni):
//   The row engine accepts a crossTemplateValues map from caller. Caller
//   (Layer 3 column engine OR a higher-level renderer) is responsible
//   for evaluating referenced templates first and passing their row
//   values in. The row engine just looks them up. This avoids the row
//   engine recursing into other templates.

import { Decimal } from "@/lib/utils/decimal";

import type { RowDef, RenderedCell, ColumnScope } from "./types";
import { filterBalances, type AccountBalances } from "./balances";

export interface RowEngineInput {
  /** The row tree to evaluate. */
  rows: RowDef[];
  /** Already-fetched balances for the scope (Layer 1 output). */
  balances: AccountBalances;
  /** The column scope this evaluation belongs to (for cell.drillDown). */
  scope: ColumnScope;
  /** Cross-template row values, keyed by alias (e.g. "@IS.ni" → Decimal). */
  crossTemplateValues?: Map<string, Decimal>;
  /**
   * Opening balance map (asOf = period.fromDate − 1 day). Required when
   * the template has PERIOD_DELTA rows. PR 3's column engine fetches
   * this when needed and passes it through.
   */
  openingBalances?: AccountBalances;
}

export interface EvaluatedRow {
  id: string;
  label: string;
  value: Decimal;
  /** Account codes that contributed (drill-down). Empty for FORMULA/SUBTOTAL. */
  contributingCodes: string[];
  isHeader?: boolean;
  isSpacer?: boolean;
  isFormula?: boolean;
  isSubtotal?: boolean;
}

export interface RowEngineResult {
  /** Evaluated rows in document order. */
  rows: EvaluatedRow[];
  /** Map by row id for FORMULA / SUBTOTAL lookups. */
  byId: Map<string, EvaluatedRow>;
  /** Warnings surfaced during evaluation (unresolved refs etc.). */
  warnings: string[];
}

/**
 * Evaluate a row tree against a balance map. Pure function (no I/O).
 *
 * Document-order: ACCOUNTS / SUBTOTAL / FORMULA / PERIOD_DELTA / SPACER
 * / HEADER are evaluated in the order they appear in `rows`. SUBTOTAL
 * and FORMULA references must point at earlier rows (or cross-template
 * aliases) — forward references are not supported in v1.
 */
export function runRowEngine(input: RowEngineInput): RowEngineResult {
  const { rows, balances, crossTemplateValues } = input;
  const evaluated: EvaluatedRow[] = [];
  const byId = new Map<string, EvaluatedRow>();
  const warnings: string[] = [];

  function getValueByRef(ref: string): Decimal | null {
    // Cross-template alias: "@IS.ni"
    if (ref.startsWith("@")) {
      const val = crossTemplateValues?.get(ref);
      if (val == null) {
        warnings.push(`Cross-template reference unresolved: ${ref}`);
        return new Decimal(0);
      }
      return val;
    }
    // Same-template row id.
    const row = byId.get(ref);
    if (!row) {
      warnings.push(`Row reference unresolved: ${ref}`);
      return new Decimal(0);
    }
    return row.value;
  }

  for (const row of rows) {
    let value = new Decimal(0);
    let contributingCodes: string[] = [];
    const flags = {
      isHeader: false,
      isSpacer: false,
      isFormula: false,
      isSubtotal: false,
    };

    switch (row.kind) {
      case "ACCOUNTS": {
        const matches = filterBalances(balances, row.filter);
        for (const m of matches) {
          value = value.plus(m.balance);
          contributingCodes.push(m.code);
        }
        if (row.signFlip) {
          value = value.negated();
        }
        break;
      }
      case "SUBTOTAL": {
        flags.isSubtotal = true;
        for (const childId of row.childIds) {
          const ref = getValueByRef(childId);
          if (ref != null) value = value.plus(ref);
          // Subtotals don't track contributing codes — they inherit
          // from children via UI traversal (PR 6).
        }
        if (row.signFlip) {
          value = value.negated();
        }
        break;
      }
      case "FORMULA": {
        flags.isFormula = true;
        for (const addRef of row.add ?? []) {
          const ref = getValueByRef(addRef);
          if (ref != null) value = value.plus(ref);
        }
        for (const subRef of row.subtract ?? []) {
          const ref = getValueByRef(subRef);
          if (ref != null) value = value.minus(ref);
        }
        break;
      }
      case "PERIOD_DELTA": {
        // Requires opening balance map. If not provided, default to 0
        // with a warning (e.g. caller is a point-in-time report like
        // BS where PERIOD_DELTA is nonsensical).
        if (!input.openingBalances) {
          warnings.push(
            `PERIOD_DELTA row "${row.id}" needs openingBalances; defaulting to 0`
          );
          break;
        }
        // closing − opening per matching account, summed.
        const closingMatches = filterBalances(balances, row.filter);
        for (const closing of closingMatches) {
          const opening = input.openingBalances.get(closing.code);
          const openingBal = opening?.balance ?? new Decimal(0);
          const delta = closing.balance.minus(openingBal);
          value = value.plus(delta);
          contributingCodes.push(closing.code);
        }
        // direction "increase" means cash moves OPPOSITE to the account
        // change (e.g. AR went UP → cash went DOWN → flip sign in CF).
        // direction "decrease" means cash moves WITH the account (AP
        // went UP → cash went UP → preserve sign).
        if (row.direction === "increase") {
          value = value.negated();
        }
        break;
      }
      case "HEADER": {
        flags.isHeader = true;
        break;
      }
      case "SPACER": {
        flags.isSpacer = true;
        break;
      }
    }

    const evaluatedRow: EvaluatedRow = {
      id: row.id,
      label: "label" in row ? row.label : "",
      value,
      contributingCodes,
      ...flags,
    };
    evaluated.push(evaluatedRow);
    byId.set(row.id, evaluatedRow);
  }

  return { rows: evaluated, byId, warnings };
}

// ---- Helper: format an EvaluatedRow into a RenderedCell ------------

export interface FormatOptions {
  decimals: number;
  thousands: boolean;
  parens: boolean;
}

export const DEFAULT_FORMAT: FormatOptions = {
  decimals: 2,
  thousands: true,
  parens: true,
};

export function formatCell(
  evaluated: EvaluatedRow,
  scope: ColumnScope,
  showDrillDown: boolean,
  format: FormatOptions = DEFAULT_FORMAT
): RenderedCell {
  const value = evaluated.value;
  const formatted = formatMoney(value, format);
  const cell: RenderedCell = {
    value: value.toFixed(format.decimals),
    display: formatted,
  };
  if (showDrillDown && evaluated.contributingCodes.length > 0) {
    cell.drillDown = {
      accountCodes: evaluated.contributingCodes,
      scope,
    };
  }
  return cell;
}

function formatMoney(value: Decimal, options: FormatOptions): string {
  const abs = value.abs();
  const fixed = abs.toFixed(options.decimals);
  const [intPart, decPart] = fixed.split(".");
  const withThousands = options.thousands ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : intPart;
  const positiveDisplay = decPart ? `${withThousands}.${decPart}` : withThousands;
  if (value.isZero()) return positiveDisplay;
  if (value.isNegative()) {
    return options.parens ? `(${positiveDisplay})` : `-${positiveDisplay}`;
  }
  return positiveDisplay;
}
