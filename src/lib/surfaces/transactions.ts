// The URL contract for the line-level transactions surface.
//
// Lives outside the page so a report cell can build a drill-down link without
// importing the page module (which would pull the whole component, its Prisma
// queries and its imports into the report's bundle). One module owns the
// parameter names; the page and every drill-down source read them from here.

import {
  buildUrl,
  defaultsOf,
  int,
  isoDate,
  str,
  type SurfaceSpec,
} from "@/lib/url-state";

/**
 * ⚠️ `account` is the chart CODE, not the uuid.
 *
 * It is what a person reads on a report row, and it is what a drill-down link
 * can build without a second lookup. Campfire's own URL carries both the id
 * and the display name (`account=2001&accountName=Usage-BasedRevenue`) — two
 * sources of truth for one fact, and the name is the half that drifts. See
 * docs/design/campfire-product-surface.md §13. The name is resolved
 * server-side for the chip instead.
 */
export const TRANSACTIONS_SPEC = {
  account: str("", { chip: (v) => (v ? `Account: ${v}` : null) }),
  from: isoDate("2026-01-01", { chip: (v) => (v === "2026-01-01" ? null : `From ${v}`) }),
  to: isoDate("2026-12-31", { chip: (v) => (v === "2026-12-31" ? null : `To ${v}`) }),
  q: str("", { chip: (v) => (v ? `Search: ${v}` : null) }),
  page: int(1, { min: 1 }),
} satisfies SurfaceSpec;

export const TRANSACTIONS_PATH = "/transactions";

/**
 * A drill-down link into the transactions list.
 *
 * This is the whole payoff of keeping surface state in the URL: a report cell
 * knows its account and its period, so "show me the lines behind this number"
 * is an `<a href>`. No modal, no shared client store, no new endpoint.
 *
 * Dates are ISO `YYYY-MM-DD`; anything else falls back to the surface default
 * rather than throwing, so a caller passing a bad period degrades to a wider
 * range instead of a 500.
 */
export function transactionsHref(opts: {
  accountCode: string;
  from: string;
  to: string;
}): string {
  return buildUrl(TRANSACTIONS_PATH, TRANSACTIONS_SPEC, {
    ...defaultsOf(TRANSACTIONS_SPEC),
    account: opts.accountCode,
    from: opts.from,
    to: opts.to,
  });
}
