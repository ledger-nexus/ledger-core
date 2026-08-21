// One field grid, for every detail page.
//
// §5 of docs/design/campfire-product-surface.md describes the detail-page
// contract as "a dense read-only field grid, label above value, small muted
// label, larger value", with two rules that matter more than the styling:
// empty renders as a dash, and **every field shows even when null**.
//
// ⚠️ THREE `Field` COMPONENTS ALREADY EXISTED, one per detail page, agreeing on
// nothing:
//
//   src/app/journal-entries/[id]   <div>/<div>,  11px label, text-ink-800, no empty rule
//   src/app/admin/audit-log/[id]   <dt>/<dd>,    11px label, text-ink-800, `?? "—"` built in
//   src/app/recurring-entries/[id] <dt>/<dd>,   text-xs label, text-ink-900, callers write "—"
//
// So the never-blank rule was already implemented — in one of the three, and
// not the one on the busiest page. The journal-entry grid is also the only one
// that is not a description list, which is a semantics difference and not a
// styling one. This module is the merge of all three.
//
// ⚠️ THE COMPONENT RENDERS THE DASH, so a caller never needs `{x && <Field/>}`.
// That guard is what makes a field disappear, and `tests/detail-page-contract
// .test.ts` fails if one comes back.

import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";
import { EMPTY_FIELD, isEmptyFieldValue } from "@/lib/utils/field-display";

export interface FieldProps {
  label: string;
  /** The value. Renders a dash when empty — see `isEmptyFieldValue`. */
  value?: ReactNode;
  /** Alternative to `value`, for markup that is easier written as children. */
  children?: ReactNode;
  /** Ids, codes and amounts. */
  mono?: boolean;
  /** A short muted line under the value — a foreign key's id, a unit, a source. */
  hint?: ReactNode;
  className?: string;
}

export function Field({ label, value, children, mono, hint, className }: FieldProps) {
  // `children` wins when both are given; a caller writing children meant them.
  const content = children ?? value;
  // ⚠️ `isEmptyFieldValue`, not `!content`. On a ledger `0` is an answer, and
  // a falsy check renders it as a dash.
  const empty = children === undefined && isEmptyFieldValue(value);

  return (
    <div className={className}>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-sm",
          mono && "font-mono",
          // The dash is muted; a real value is not. Otherwise a screen of
          // dashes reads with the same weight as a screen of data.
          empty ? "text-ink-500" : "text-ink-800"
        )}
      >
        {empty ? EMPTY_FIELD : content}
        {hint !== undefined && !isEmptyFieldValue(hint) && (
          <span className="mt-0.5 block font-mono text-xs text-ink-500">{hint}</span>
        )}
      </dd>
    </div>
  );
}

export interface FieldGridProps {
  /** §5's shape is three columns; ours vary by page, so it is a prop. */
  columns?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}

/**
 * A `<dl>`, because that is what a list of label/value pairs is. All three
 * pre-existing grids were doing this except the journal-entry one, which used
 * plain divs and therefore told a screen reader nothing about the pairing.
 */
export function FieldGrid({ columns = 3, children, className }: FieldGridProps) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-4",
        // Written out rather than interpolated: Tailwind scans source text, so
        // `sm:grid-cols-${columns}` produces no CSS at all — the exact failure
        // #359 found with `bg-warning/5`.
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-3",
        columns === 4 && "sm:grid-cols-4",
        className
      )}
    >
      {children}
    </dl>
  );
}
