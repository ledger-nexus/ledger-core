// Which columns a table shows, and in what order.
//
// WHY THIS EXISTS. Alignment in this codebase is declared PER CELL: 183
// hand-written `text-right` classes across 43 files and 54 `<Table>` blocks.
// That is not merely repetitive — it drifts. A scan of every table found three
// columns whose header sits left of its own right-aligned numbers
// (`/recurring-entries` Lines and Due, `/recurring-entries/[id]` Line), because
// nothing ties a `<TH>` to the `<TD>`s underneath it. A column spec ties them:
// `align` is declared once and both cells derive from it, so the mismatch
// stops being expressible rather than being fixed and re-introduced.
//
// The picker is the second half. Campfire pins a Columns tab to the right edge
// of every list (docs/design/campfire-product-surface.md §6, phase 1 in §14),
// and the reason it is cheap for them is the reason it is cheap for us: the
// state is already in the URL (src/lib/url-state.ts). A column choice is a
// query parameter, so it round-trips, it is shareable, it survives the back
// button, and — because a SavedView stores the query string (#376) — saving a
// view saves your columns for free, with no extra model and no `config Json`.
//
// ⚠️ THIS FILE IS PURE. No React, no Prisma. The rules below are the ones
// worth guarding — required columns cannot be hidden, declared order beats URL
// order, a hand-edited URL cannot produce an empty table — and they are
// guarded in tests/data-table-columns.test.ts without rendering anything.

import type { ParamSpec } from "@/lib/url-state";

/** The picker's view of a column. The renderer adds `cell` on top of this. */
export interface ColumnMeta {
  /** Stable id. Appears in the URL, so renaming one invalidates saved views. */
  key: string;
  /** The picker's label. Usually the header text, spelled out if the header is an icon. */
  label: string;
  /**
   * A column the reader cannot turn off.
   *
   * Identity columns earn this: hide the date and entry number on a
   * transactions list and the remaining rows cannot be told apart, which is a
   * state a shared URL should not be able to put someone in.
   */
  required?: boolean;
  /** Off until asked for. Useful detail that would otherwise crowd the default view. */
  defaultHidden?: boolean;
}

const SEP = ",";

/** Declared order, dropping the opt-in columns. */
export function defaultVisible(columns: readonly ColumnMeta[]): string[] {
  return columns.filter((c) => !c.defaultHidden).map((c) => c.key);
}

/**
 * The visible keys for a raw `cols=` value.
 *
 * ⚠️ Order comes from the DECLARATION, never from the URL. Letting the query
 * string reorder columns sounds like a free feature and is not: it is a second
 * way to express layout, it makes two URLs showing the same data render
 * differently, and column ORDER is a real feature that deserves its own design
 * rather than falling out of a parser.
 *
 * ⚠️ Never returns an empty list. A hand-edited `?cols=nonsense` is a normal
 * thing for a person to do, and it must land on the default table rather than
 * on a header row with nothing under it.
 */
export function resolveVisible(columns: readonly ColumnMeta[], raw: string | undefined): string[] {
  const asked = new Set(
    (raw ?? "")
      .split(SEP)
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (asked.size === 0) return defaultVisible(columns);

  const resolved = columns
    .filter((c) => c.required || asked.has(c.key))
    .map((c) => c.key);

  // Every key was unknown — a stale saved view, or a typo. Defaults, not blank.
  const anyReal = columns.some((c) => asked.has(c.key));
  return anyReal ? resolved : defaultVisible(columns);
}

/**
 * The `cols=` value for a visible set, or `undefined` when it is the default.
 *
 * Omitting the default is what keeps a shared link clean: a table nobody has
 * touched carries no column parameter at all.
 */
export function serializeVisible(
  columns: readonly ColumnMeta[],
  visible: readonly string[]
): string | undefined {
  const ordered = columns.filter((c) => visible.includes(c.key)).map((c) => c.key);
  const def = defaultVisible(columns);
  const same = ordered.length === def.length && ordered.every((k, i) => k === def[i]);
  return same ? undefined : ordered.join(SEP);
}

/**
 * Flip one column. Required columns do not flip, and the last visible column
 * does not turn off — both are no-ops rather than errors, because this feeds
 * an `<a href>` and a link that renders a broken table is worse than a link
 * that renders the same table.
 */
export function toggleVisible(
  columns: readonly ColumnMeta[],
  visible: readonly string[],
  key: string
): string[] {
  const col = columns.find((c) => c.key === key);
  if (!col || col.required) return [...visible];

  const on = visible.includes(key);
  if (on && visible.length <= 1) return [...visible];

  const next = new Set(visible);
  if (on) next.delete(key);
  else next.add(key);
  return columns.filter((c) => next.has(c.key)).map((c) => c.key);
}

/**
 * The column choice as a surface parameter, so it composes with everything
 * `url-state.ts` already does — `buildUrl` writes it, `parseUrlState` reads it,
 * and a saved view captures it because a saved view is the query string.
 *
 * No chip: a hidden column is not a filter. Chips answer "why am I seeing
 * fewer rows than I expect", and columns do not change the row count.
 */
export function columnsParam(columns: readonly ColumnMeta[]): ParamSpec<string[]> {
  return {
    parse: (raw) => resolveVisible(columns, raw),
    serialize: (value) => serializeVisible(columns, value),
    chip: () => null,
  };
}

/** Duplicate keys silently drop columns from the picker. Callable from a guard. */
export function duplicateKeys(columns: readonly ColumnMeta[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const c of columns) {
    if (seen.has(c.key)) dupes.add(c.key);
    seen.add(c.key);
  }
  return [...dupes];
}
