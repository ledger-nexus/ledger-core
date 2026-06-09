// Layer 3: Column engine.
//
// Expands ColumnDef DSL into concrete scope tuples, fetches balance
// maps, runs the row engine once per column, assembles into
// RenderedMatrix. Also wires PERIOD_DELTA support by fetching both
// opening + closing balance maps per period column.
//
// Dedupes balance fetches: if two columns share the same (entity,
// book, asOf or period) tuple, the underlying balance query runs once.

import { Decimal } from "decimal.js";
import type { PrismaClient, Prisma } from "@prisma/client";

import { getAccountBalances, type AccountBalances } from "./balances";
import { runRowEngine, formatCell, type FormatOptions, DEFAULT_FORMAT } from "./row-engine";
import type {
  ColumnDef,
  ColumnScope,
  PeriodOffset,
  ReportTemplate,
  RenderedMatrix,
  RenderedRow,
  RenderedCell,
} from "./types";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface ColumnEngineOptions {
  /** Reference date for resolving PeriodOffset shapes. */
  asOfDate: Date;
  entityCode: string;
  bookCode: string;
  tenantId?: string;
  /**
   * Cross-template values resolved by the orchestrator before this
   * template renders. Used by FORMULA rows referencing @TEMPLATE.row.
   */
  crossTemplateValues?: Map<string, Decimal>;
}

/**
 * Resolve a PeriodOffset against a reference asOfDate to a concrete
 * ColumnScope.
 *
 * v1 hard-codes the point-vs-range distinction by template code (BS/EQ
 * → point; IS/CF → range). When the renderer calls this it passes a
 * `mode` hint. PR 5 may move this to an explicit PeriodOffset field.
 */
export function resolvePeriodOffset(
  offset: PeriodOffset,
  refDate: Date,
  mode: "POINT" | "RANGE"
): { asOf?: Date; fromDate?: Date; toDate?: Date } {
  switch (offset.type) {
    case "absolute": {
      return {
        asOf: offset.asOf ? new Date(offset.asOf) : undefined,
        fromDate: offset.fromDate ? new Date(offset.fromDate) : undefined,
        toDate: offset.toDate ? new Date(offset.toDate) : undefined,
      };
    }
    case "current": {
      switch (offset.basis) {
        case "YTD": {
          const year = refDate.getUTCFullYear();
          return mode === "RANGE"
            ? { fromDate: new Date(Date.UTC(year, 0, 1)), toDate: refDate }
            : { asOf: refDate };
        }
        case "QTD": {
          const year = refDate.getUTCFullYear();
          const month = refDate.getUTCMonth();
          const qStart = month - (month % 3);
          return mode === "RANGE"
            ? { fromDate: new Date(Date.UTC(year, qStart, 1)), toDate: refDate }
            : { asOf: refDate };
        }
        case "MONTH": {
          const year = refDate.getUTCFullYear();
          const month = refDate.getUTCMonth();
          return mode === "RANGE"
            ? {
                fromDate: new Date(Date.UTC(year, month, 1)),
                toDate: new Date(Date.UTC(year, month + 1, 0)),
              }
            : { asOf: new Date(Date.UTC(year, month + 1, 0)) };
        }
        case "QUARTER": {
          const year = refDate.getUTCFullYear();
          const month = refDate.getUTCMonth();
          const qStart = month - (month % 3);
          return mode === "RANGE"
            ? {
                fromDate: new Date(Date.UTC(year, qStart, 1)),
                toDate: new Date(Date.UTC(year, qStart + 3, 0)),
              }
            : { asOf: new Date(Date.UTC(year, qStart + 3, 0)) };
        }
        case "YEAR": {
          const year = refDate.getUTCFullYear();
          return mode === "RANGE"
            ? {
                fromDate: new Date(Date.UTC(year, 0, 1)),
                toDate: new Date(Date.UTC(year, 11, 31)),
              }
            : { asOf: new Date(Date.UTC(year, 11, 31)) };
        }
      }
    }
    case "prior": {
      switch (offset.basis) {
        case "YEAR": {
          const year = refDate.getUTCFullYear() - offset.offset;
          return mode === "RANGE"
            ? {
                fromDate: new Date(Date.UTC(year, 0, 1)),
                toDate: new Date(Date.UTC(year, 11, 31)),
              }
            : { asOf: new Date(Date.UTC(year, 11, 31)) };
        }
        case "MONTH": {
          const year = refDate.getUTCFullYear();
          const month = refDate.getUTCMonth() - offset.offset;
          return mode === "RANGE"
            ? {
                fromDate: new Date(Date.UTC(year, month, 1)),
                toDate: new Date(Date.UTC(year, month + 1, 0)),
              }
            : { asOf: new Date(Date.UTC(year, month + 1, 0)) };
        }
        case "QUARTER":
        case "QTD":
        case "YTD": {
          // PR 5 may flesh these out — v1 covers the most common cases.
          throw new Error(`PeriodOffset.prior basis ${offset.basis} not yet implemented in v1`);
        }
      }
    }
  }
}

/**
 * Run the column engine: resolve each ColumnDef into a concrete scope,
 * fetch balances, run the row engine, assemble into RenderedMatrix.
 */
export async function runColumnEngine(
  prisma: DbClient,
  template: ReportTemplate,
  options: ColumnEngineOptions
): Promise<RenderedMatrix> {
  // Determine point-vs-range mode from template code (v1 hard-coding).
  const mode = inferTemplateMode(template);

  // Resolve each SCOPE column into a concrete scope.
  const resolvedScopes = new Map<string, ColumnScope>();
  for (const col of template.definition.columns) {
    if (col.kind === "VARIANCE") continue;
    const colScope = resolveColumnScope(col, options, mode);
    resolvedScopes.set(col.id, colScope);
  }

  // Detect whether the template has any PERIOD_DELTA rows. If yes,
  // we need to fetch opening balance maps too.
  const hasPeriodDelta = template.definition.rows.some((r) => r.kind === "PERIOD_DELTA");

  // Fetch balance maps per column. Dedupe by JSON-stringified scope so
  // shared scopes (e.g. 2 columns at same asOf) hit the same map.
  const balanceCache = new Map<string, AccountBalances>();
  const openingCache = new Map<string, AccountBalances>();

  async function fetchBalances(scope: ColumnScope): Promise<AccountBalances> {
    const key = scopeKey(scope);
    let map = balanceCache.get(key);
    if (!map) {
      map = await getAccountBalances(prisma, {
        entityCode: scope.entityCode,
        bookCode: scope.bookCode,
        tenantId: options.tenantId,
        asOf: scope.asOf ? new Date(scope.asOf) : undefined,
        fromDate: scope.period?.fromDate ? new Date(scope.period.fromDate) : undefined,
        toDate: scope.period?.toDate ? new Date(scope.period.toDate) : undefined,
      });
      balanceCache.set(key, map);
    }
    return map;
  }

  async function fetchOpening(scope: ColumnScope): Promise<AccountBalances | undefined> {
    if (!hasPeriodDelta) return undefined;
    if (!scope.period?.fromDate) return undefined; // point-in-time scope; no opening
    const openingAsOf = new Date(new Date(scope.period.fromDate).getTime() - 86400000);
    const key = `OPENING|${scopeKey(scope)}`;
    let map = openingCache.get(key);
    if (!map) {
      map = await getAccountBalances(prisma, {
        entityCode: scope.entityCode,
        bookCode: scope.bookCode,
        tenantId: options.tenantId,
        asOf: openingAsOf,
      });
      openingCache.set(key, map);
    }
    return map;
  }

  // Run row engine once per SCOPE column. Cells per column id.
  const cellsByColId = new Map<string, Map<string, RenderedCell>>(); // col id → row id → cell
  const valuesByColId = new Map<string, Map<string, Decimal>>(); // col id → row id → raw value

  for (const col of template.definition.columns) {
    if (col.kind === "VARIANCE") continue;
    const scope = resolvedScopes.get(col.id)!;
    const balances = await fetchBalances(scope);
    const opening = await fetchOpening(scope);

    const result = runRowEngine({
      rows: template.definition.rows,
      balances,
      scope,
      crossTemplateValues: options.crossTemplateValues,
      // PR 3 extension: pass opening balances for PERIOD_DELTA support.
      // Row engine looks for `openingBalances` in input.
      openingBalances: opening,
    });

    const formatOpts = template.definition.presentation.moneyFormat ?? DEFAULT_FORMAT;
    const showDrillDown = template.definition.presentation.showDrillDown ?? false;

    const rowCells = new Map<string, RenderedCell>();
    const rowValues = new Map<string, Decimal>();
    for (const r of result.rows) {
      rowCells.set(r.id, formatCell(r, scope, showDrillDown, formatOpts));
      rowValues.set(r.id, r.value);
    }
    cellsByColId.set(col.id, rowCells);
    valuesByColId.set(col.id, rowValues);
  }

  // Compute VARIANCE columns from already-evaluated columns.
  for (const col of template.definition.columns) {
    if (col.kind !== "VARIANCE") continue;
    const fromVals = valuesByColId.get(col.from);
    const toVals = valuesByColId.get(col.to);
    if (!fromVals || !toVals) {
      throw new Error(`VARIANCE column ${col.id} references unknown column ${col.from} or ${col.to}`);
    }
    const rowCells = new Map<string, RenderedCell>();
    const formatOpts = template.definition.presentation.moneyFormat ?? DEFAULT_FORMAT;
    for (const row of template.definition.rows) {
      const fromV = fromVals.get(row.id) ?? new Decimal(0);
      const toV = toVals.get(row.id) ?? new Decimal(0);
      let variance: Decimal;
      let display: string;
      if (col.format === "percent") {
        if (fromV.isZero()) {
          variance = new Decimal(0);
          display = "—";
        } else {
          variance = toV.minus(fromV).dividedBy(fromV).times(100);
          display = `${variance.toFixed(1)}%`;
        }
      } else {
        variance = toV.minus(fromV);
        display = formatMoneyValue(variance, formatOpts);
      }
      rowCells.set(row.id, { value: variance.toFixed(formatOpts.decimals), display });
    }
    cellsByColId.set(col.id, rowCells);
  }

  // Assemble RenderedMatrix.
  const renderedRows: RenderedRow[] = template.definition.rows.map((row) => {
    const cells: RenderedCell[] = template.definition.columns.map(
      (col) => cellsByColId.get(col.id)?.get(row.id) ?? { value: "0", display: "—" }
    );
    return {
      id: row.id,
      label: "label" in row ? row.label : "",
      cells,
      isHeader: row.kind === "HEADER",
      isSpacer: row.kind === "SPACER",
      isFormula: row.kind === "FORMULA",
      isSubtotal: row.kind === "SUBTOTAL",
    };
  });

  return {
    template,
    columns: template.definition.columns.map((c) => ({ id: c.id, label: c.label })),
    rows: renderedRows,
  };
}

// ---- Helpers ----------------------------------------------------

function resolveColumnScope(
  col: Extract<ColumnDef, { kind: "SCOPE" }>,
  options: ColumnEngineOptions,
  mode: "POINT" | "RANGE"
): ColumnScope {
  if (col.scope) {
    return {
      entityCode: col.scope.entityCode ?? options.entityCode,
      bookCode: col.scope.bookCode ?? options.bookCode,
      asOf: col.scope.asOf,
      period: col.scope.period,
      currencyCode: col.scope.currencyCode,
    };
  }
  if (col.offset) {
    const resolved = resolvePeriodOffset(col.offset, options.asOfDate, mode);
    return {
      entityCode: options.entityCode,
      bookCode: options.bookCode,
      asOf: resolved.asOf?.toISOString().slice(0, 10),
      period:
        resolved.fromDate && resolved.toDate
          ? {
              fromDate: resolved.fromDate.toISOString().slice(0, 10),
              toDate: resolved.toDate.toISOString().slice(0, 10),
            }
          : undefined,
    };
  }
  throw new Error(`Column ${col.id} has neither scope nor offset`);
}

function scopeKey(scope: ColumnScope): string {
  return JSON.stringify({
    e: scope.entityCode,
    b: scope.bookCode,
    a: scope.asOf,
    p: scope.period,
    c: scope.currencyCode,
  });
}

function inferTemplateMode(template: ReportTemplate): "POINT" | "RANGE" {
  // v1 hard-coding by template code. PR 5 may move to explicit field.
  if (template.code === "BS" || template.code === "EQ") return "POINT";
  return "RANGE"; // IS, CF, anything else
}

function formatMoneyValue(value: Decimal, options: FormatOptions): string {
  const abs = value.abs();
  const fixed = abs.toFixed(options.decimals);
  const [intPart, decPart] = fixed.split(".");
  const withThousands = options.thousands ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : intPart;
  const positiveDisplay = decPart ? `${withThousands}.${decPart}` : withThousands;
  if (value.isZero()) return positiveDisplay;
  if (value.isNegative()) return options.parens ? `(${positiveDisplay})` : `-${positiveDisplay}`;
  return positiveDisplay;
}
