// Applied filters, shown as removable chips.
//
// The rule this exists to enforce: **a filter that is applied must be
// visible**. A control bar alone hides state — a date range narrowed three
// screens ago silently explains an empty table, and the usual support question
// ("why can't I see the entry I just posted") is almost always a filter nobody
// could see. Chips put the whole predicate on screen.
//
// Chips are DERIVED from the surface's URL spec (`filterChips` in
// src/lib/url-state.ts), never assembled here, so they cannot disagree with
// what the query actually filtered on.
//
// Renders nothing at all when no filter is active — an empty chip rail is
// visual noise that teaches the reader to stop looking at that strip.

import Link from "next/link";

import type { FilterChip } from "@/lib/url-state";

export function FilterChips({
  chips,
  clearAllHref,
}: {
  chips: FilterChip[];
  /** Href with every filter back at its default. Omit to hide "Clear all". */
  clearAllHref?: string;
}) {
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Applied filters">
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.clearHref}
          // The chip IS the remove control — the whole thing is the link, not
          // a 12px × that needs aiming at.
          className="group inline-flex items-center gap-1.5 rounded-md border border-accent-200 bg-accent-50 px-2 py-1 text-xs text-accent-900 transition-colors duration-150 ease-snap hover:bg-accent-100"
          title={`Remove filter: ${chip.label}`}
        >
          <span>{chip.label}</span>
          <span aria-hidden="true" className="text-accent-600 group-hover:text-accent-900">
            ×
          </span>
          <span className="sr-only">Remove filter</span>
        </Link>
      ))}
      {clearAllHref && chips.length > 1 && (
        <Link href={clearAllHref} className="text-xs text-ink-500 underline hover:text-ink-700">
          Clear all
        </Link>
      )}
    </div>
  );
}
