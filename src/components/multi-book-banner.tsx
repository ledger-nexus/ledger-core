// v0.9 NS Books Phase 3.5.E — multi-book discovery banner.
//
// Renders a small banner on AR/AP pages when the operator's active
// scope book is NOT the only book with open items on this entity.
// Surfaces the "other books exist" reality of multi-book NS imports
// so operators don't miss data sitting on US_TAX while looking at
// US_GAAP.
//
// Side: Server Component (no client state). Pure data → DOM.

import Link from "next/link";
import type { EntityBookSummary } from "@/lib/accounting/sub-ledgers/cross-book";

export function MultiBookBanner({
  side,
  activeBookCode,
  books,
}: {
  side: "AR" | "AP";
  activeBookCode: string;
  /** Output of listEntityBooksWithOpenItems for the active entity. */
  books: EntityBookSummary[];
}) {
  // Show only the OTHER books — the active book is already on screen.
  // Filter for those that actually have open items on the same side
  // the page is showing (mixing the two would be visual noise).
  const others = books
    .filter((b) => b.bookCode !== activeBookCode)
    .filter((b) => (side === "AR" ? b.openArCount > 0 : b.openApCount > 0));
  if (others.length === 0) return null;

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <span className="font-medium">Multi-book entity:</span>{" "}
      This entity also has open {side} items on:{" "}
      {others.map((b, i) => (
        <span key={b.bookCode}>
          <code className="rounded bg-white px-1 ring-1 ring-amber-200">
            {b.bookCode}
          </code>{" "}
          <span className="opacity-70">
            ({side === "AR" ? b.openArCount : b.openApCount})
          </span>
          {i < others.length - 1 ? ", " : ""}
        </span>
      ))}
      .{" "}
      <Link
        href="/reports/consolidation"
        className="underline decoration-amber-400 underline-offset-2"
      >
        Open the consolidated view
      </Link>{" "}
      to compare side-by-side.
    </div>
  );
}
