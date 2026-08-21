// One pager, for every paged list.
//
// Phase 1 of the build order asks for "one pagination component"
// (docs/design/campfire-product-surface.md §14). Two lists had hand-rolled it
// identically — `/journal-entries` and `/transactions`, forty lines each —
// and the duplication had already cost something concrete: the disabled
// Prev/Next state uses `text-ink-300`, which the contrast guard rejects, so
// BOTH pages carried their own `file:token` exemption in
// tests/design-system.test.ts. Two exemptions for one pattern is two places to
// re-justify it. Now the pattern lives here and so does the single exemption.
//
// Server Component. Every page is a real URL built by the caller from its
// surface spec, so paging back and forward is browser history, not state.

import type { ReactNode } from "react";

import Link from "next/link";

export interface PaginationProps {
  /** 1-based, already clamped to `totalPages` by the caller. */
  page: number;
  totalPages: number;
  /** Total matching rows, for the "Showing 1–50 of 4,201" line. */
  totalCount: number;
  pageSize: number;
  hrefFor: (page: number) => string;
  /**
   * Optional middle slot — e.g. the page's debit/credit subtotal.
   * Kept a slot rather than a prop because what a page totals is its own
   * business; the pager should not learn about debits.
   */
  children?: ReactNode;
}

const CONTROL = "rounded-md border border-ink-200 px-3 py-1.5";

export function Pagination({
  page,
  totalPages,
  totalCount,
  pageSize,
  hrefFor,
  children,
}: PaginationProps) {
  const first = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalCount);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-sm text-ink-500">
      <span>
        Showing {first}–{last} of {totalCount}
      </span>
      {children}
      {totalPages > 1 && (
        <nav className="flex items-center gap-2" aria-label="Pagination">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className={`${CONTROL} hover:bg-ink-50`} rel="prev">
              ← Prev
            </Link>
          ) : (
            // Disabled, not hidden: the control keeps its place so the pager
            // does not jump one button's width between page 1 and page 2.
            // `text-ink-300` is below the contrast floor and exempt as a
            // disabled control — the one exemption this component carries.
            <span className={`${CONTROL} text-ink-300`} aria-disabled="true">
              ← Prev
            </span>
          )}
          <span className="font-mono text-xs">
            {page} / {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={hrefFor(page + 1)} className={`${CONTROL} hover:bg-ink-50`} rel="next">
              Next →
            </Link>
          ) : (
            <span className={`${CONTROL} text-ink-300`} aria-disabled="true">
              Next →
            </span>
          )}
        </nav>
      )}
    </div>
  );
}
