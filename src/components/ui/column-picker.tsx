// The Columns control.
//
// Campfire pins this to the right edge of every list as a vertical tab
// (docs/design/campfire-product-surface.md §6). Ours is a disclosure above the
// table, and every toggle is an ordinary `<a href>` — no client component, no
// state, no JavaScript. That is possible only because the column choice is a
// URL parameter (src/lib/surfaces/columns.ts), which also means the choice is
// shareable, survives the back button, and is captured by a saved view for
// free, since a saved view IS the query string (#376).
//
// ⚠️ THE COUNT IS IN THE SUMMARY, not behind it. A disclosure that hides how
// many things exist is the pattern rejected for navigation — "More (N)" tells
// you a number but not what you are missing. "Columns · 5 of 7" says both how
// many you have and that two are off, before you open anything.
//
// ⚠️ REQUIRED COLUMNS RENDER, DISABLED, RATHER THAN BEING OMITTED. A picker
// that silently drops the date column from its own list reads as an incomplete
// list; one that shows it fixed says "this is deliberate".

import Link from "next/link";

import { cn } from "@/lib/utils/cn";
import type { ColumnMeta } from "@/lib/surfaces/columns";

export interface ColumnPickerProps {
  columns: readonly ColumnMeta[];
  visible: readonly string[];
  /** The URL with this one column flipped — built by the surface from its spec. */
  hrefFor: (key: string) => string;
  /** The URL with the default column set restored. */
  resetHref: string;
}

export function ColumnPicker({ columns, visible, hrefFor, resetHref }: ColumnPickerProps) {
  const shownCount = columns.filter((c) => visible.includes(c.key)).length;
  const isDefault = shownCount === columns.filter((c) => !c.defaultHidden).length;
  // The last visible column cannot be turned off — the table would have no
  // columns. Mirrors `toggleVisible`, which makes that link a no-op anyway.
  const atMinimum = shownCount <= 1;

  return (
    <details className="group rounded-md border border-ink-200 bg-white text-sm">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-ink-700 hover:bg-ink-50">
        Columns{" "}
        <span className="text-ink-500">
          · {shownCount} of {columns.length}
        </span>
      </summary>
      <div className="border-t border-ink-200 p-2">
        <ul className="flex flex-col">
          {columns.map((col) => {
            const on = visible.includes(col.key);
            const locked = Boolean(col.required) || (on && atMinimum);
            const mark = on ? "☑" : "☐";

            if (locked) {
              return (
                <li
                  key={col.key}
                  className="flex items-center gap-2 rounded px-2 py-1 text-ink-500"
                  title={
                    col.required
                      ? "Always shown — rows could not be told apart without it"
                      : "The last column cannot be hidden"
                  }
                >
                  <span aria-hidden="true">{mark}</span>
                  <span>{col.label}</span>
                  <span className="ml-auto text-xs uppercase tracking-wide">
                    {col.required ? "always" : "last"}
                  </span>
                </li>
              );
            }

            return (
              <li key={col.key}>
                <Link
                  href={hrefFor(col.key)}
                  // The state is on the link, not only in the glyph, so it is
                  // announced rather than shown.
                  aria-label={`${on ? "Hide" : "Show"} the ${col.label} column`}
                  className={cn(
                    "flex items-center gap-2 rounded px-2 py-1 hover:bg-ink-50",
                    on ? "text-ink-900" : "text-ink-500"
                  )}
                >
                  <span aria-hidden="true">{mark}</span>
                  <span>{col.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        {!isDefault && (
          <Link
            href={resetHref}
            className="mt-1 block rounded px-2 py-1 text-xs text-link hover:bg-ink-50 hover:underline"
          >
            Reset to default columns
          </Link>
        )}
      </div>
    </details>
  );
}
