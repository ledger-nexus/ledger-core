// One table contract, so a header and its own column cannot disagree.
//
// The primitives in `./table.tsx` are unopinionated `<TH>` / `<TD>` wrappers,
// which means every page decides alignment cell by cell. That produced 183
// hand-written `text-right` classes and three columns whose header is left of
// its numbers (see src/lib/surfaces/columns.ts for the scan). Here a column
// declares `align` — or `numeric`, which implies right — ONCE, and the header
// and body cells are generated from that one declaration.
//
// The second thing it derives is `colSpan`. Empty-state rows and totals rows
// are currently written as `colSpan={3}` by hand; when a column picker can
// hide a column, every one of those literals is wrong. `footer.cells` is keyed
// by COLUMN KEY, so a total sits under its own column and disappears with it.
//
// Deliberately a Server Component — no "use client", no sorting state, no row
// selection. Sorting and bulk actions are real features that belong in the URL
// (§6 of the design doc) and will land as parameters, not as component state.

import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import type { ColumnMeta } from "@/lib/surfaces/columns";

export interface Column<Row> extends ColumnMeta {
  /** The header cell. Defaults to `label`, which is what the picker shows. */
  header?: ReactNode;
  /** The body cell for one row. */
  cell: (row: Row) => ReactNode;
  /**
   * Money and counts: right-aligned, monospaced, tabular figures.
   * `.amount-cell` is the codebase's existing idiom — this names it.
   */
  numeric?: boolean;
  align?: "left" | "right";
  /** Extra classes on every body cell of this column. */
  cellClassName?: string;
  /** Extra classes on the header cell. */
  headClassName?: string;
}

export interface DataTableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row, index: number) => string;
  /** Keys to render, in declared order — from `resolveVisible()`. */
  visible: readonly string[];
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode;
  /**
   * A totals row. `cells` is keyed by column key so a total tracks its column
   * under any visibility; `label` fills the leading columns that have none.
   */
  footer?: { label?: ReactNode; cells?: Record<string, ReactNode> };
}

/** The single place alignment is turned into classes. */
function alignOf<Row>(col: Column<Row>): "left" | "right" {
  return col.align ?? (col.numeric ? "right" : "left");
}

export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  visible,
  empty,
  footer,
}: DataTableProps<Row>) {
  // Declared order, not the caller's order — the same rule `resolveVisible`
  // applies to the URL, applied again here so a hand-passed array cannot
  // reorder columns either.
  const shown = columns.filter((c) => visible.includes(c.key));
  const span = Math.max(1, shown.length);

  return (
    <Table>
      <THead>
        <TR>
          {shown.map((col) => (
            <TH
              key={col.key}
              className={cn(
                alignOf(col) === "right" && "text-right",
                col.headClassName
              )}
              // A right-aligned column is a numeric one in practice; saying so
              // lets a screen reader announce the column the way it reads.
              scope="col"
            >
              {col.header ?? col.label}
            </TH>
          ))}
        </TR>
      </THead>
      <TBody>
        {rows.length === 0 ? (
          <TR>
            <TD colSpan={span} className="py-6 text-center text-ink-500">
              {empty ?? "Nothing to show."}
            </TD>
          </TR>
        ) : (
          rows.map((row, i) => (
            <TR key={getRowKey(row, i)}>
              {shown.map((col) => (
                <TD
                  key={col.key}
                  className={cn(
                    alignOf(col) === "right" && "text-right",
                    col.numeric && "amount-cell",
                    col.cellClassName
                  )}
                >
                  {col.cell(row)}
                </TD>
              ))}
            </TR>
          ))
        )}
        {footer && rows.length > 0 && <FooterRow shown={shown} footer={footer} />}
      </TBody>
    </Table>
  );
}

/**
 * The totals row.
 *
 * The leading columns with no footer cell of their own collapse into one
 * spanning cell carrying the label — which is what `colSpan={3}` was doing by
 * hand, except this one recomputes when a column is hidden instead of silently
 * shifting every total one column to the left.
 */
function FooterRow<Row>({
  shown,
  footer,
}: {
  shown: readonly Column<Row>[];
  footer: { label?: ReactNode; cells?: Record<string, ReactNode> };
}) {
  const cells = footer.cells ?? {};
  let lead = 0;
  while (lead < shown.length && !(shown[lead].key in cells)) lead++;

  return (
    <TR className="border-t-2 border-ink-200 font-medium">
      {lead > 0 && (
        <TD colSpan={lead} className="text-ink-900">
          {footer.label}
        </TD>
      )}
      {shown.slice(lead).map((col) => (
        <TD
          key={col.key}
          className={cn(
            alignOf(col) === "right" && "text-right",
            col.numeric && "amount-cell",
            "text-ink-900"
          )}
        >
          {cells[col.key] ?? null}
        </TD>
      ))}
    </TR>
  );
}
