// An amount that opens the lines behind it.
//
// Campfire's income statement puts a focus ring on the selected cell
// (docs/design/campfire-product-surface.md §9); the affordance is that a number
// on a report is a doorway to its detail. This is that doorway.
//
// Deliberately understated: a report is a dense grid of numbers, and making
// every one of them look like a link would turn the statement into a wall of
// blue. The cue is a dotted underline that solidifies on hover, so the grid
// still reads as a grid.

import Link from "next/link";

export function DrilldownAmount({
  href,
  label,
  children,
}: {
  href: string;
  /** For the accessible name — "$1,234.00" alone says nothing about where it goes. */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={`Show transactions for ${label}`}
      aria-label={`Show transactions for ${label}`}
      className="underline decoration-ink-300 decoration-dotted underline-offset-4 transition-colors duration-150 ease-snap hover:decoration-ink-700 hover:decoration-solid focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-accent-500/40"
    >
      {children}
    </Link>
  );
}
