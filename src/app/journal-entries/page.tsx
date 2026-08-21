// Journal entries list — paginated table for the current scope. Filters
// by date range (defaults to 2026 YTD) via URL search params so links and
// browser back/forward work naturally.
//
// Optional `?q=` search: matches against memo (header), entryNumber,
// any line.description, and any line.party.code. Case-insensitive; works
// across the whole date range. Designed for "where did I book that
// vacation accrual" — typing "vacation" surfaces every entry whose memo
// or any line description contains the word.

import Link from "next/link";
import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SourceBadge } from "@/components/ui/source-badge";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { FilterChips } from "@/components/ui/filter-chips";
import { SavedViews } from "@/components/ui/saved-views";
import { listViews } from "@/app/actions/saved-views";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  buildUrl,
  defaultsOf,
  filterChips,
  int,
  isoDate,
  parseUrlState,
  str,
  type RawParams,
  type SurfaceSpec,
} from "@/lib/url-state";

const PAGE_SIZE = 50;

/**
 * This surface's URL contract — see `src/lib/url-state.ts` and
 * docs/design/campfire-product-surface.md §3.
 *
 * Declared once. Parsing, href building and the filter chips all read this
 * list, so a filter cannot be applied without a chip and a chip's clear link
 * cannot forget a sibling parameter.
 */
const SPEC = {
  from: isoDate("2026-01-01", { chip: (v) => (v === "2026-01-01" ? null : `From ${v}`) }),
  to: isoDate("2026-12-31", { chip: (v) => (v === "2026-12-31" ? null : `To ${v}`) }),
  q: str("", { chip: (v) => (v ? `Search: ${v}` : null) }),
  page: int(1, { min: 1 }),
} satisfies SurfaceSpec;

export default async function JournalEntriesPage({
  searchParams,
}: {
  searchParams: RawParams;
}) {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity to view journal entries."
      />
    );
  }
  // Page is 1-indexed for the URL (CPAs read "page 1 of 12" naturally);
  // we convert to offset for the query. Coercion, defaults and the
  // garbage-tolerance that keeps `?page=abc` out of a database query all live
  // in the spec now rather than being re-derived here.
  const state = parseUrlState(SPEC, searchParams);
  const { from, to, q, page } = state;
  const chips = filterChips("/journal-entries", SPEC, state, defaultsOf(SPEC));
  // A saved view is this surface's query string plus a name, so "the current
  // filters" is literally what buildUrl already produces — no second
  // serializer to keep in step with the first.
  const currentQuery = buildUrl("", SPEC, state).replace(/^\?/, "");
  const [views, viewer] = await Promise.all([
    listViews("journal-entries").catch(() => []),
    getCurrentUser().catch(() => null),
  ]);
  const fromDate = new Date(from);
  const toDate = new Date(to);

  // Tenant pin from the verified scope. JournalEntry has a denormalized
  // tenantId; filtering on it cuts the query plan AND closes the leak
  // now that Phase 4b makes entityCode no longer globally unique.
  const tenantFilter = { tenantId: scope.tenantId };

  // Search predicate. Postgres' `mode: "insensitive"` does an ILIKE
  // under the hood; for v1 we accept the full-table scan (the date
  // range already narrows the rows substantially). If this gets slow
  // we'd add a tsvector + GIN index on memo + description.
  const searchFilter = q
    ? {
        OR: [
          { memo: { contains: q, mode: "insensitive" as const } },
          { entryNumber: { contains: q, mode: "insensitive" as const } },
          {
            lines: {
              some: {
                OR: [
                  { description: { contains: q, mode: "insensitive" as const } },
                  { party: { code: { contains: q, mode: "insensitive" as const } } },
                ],
              },
            },
          },
        ],
      }
    : {};

  const whereClause = {
    ...tenantFilter,
    entity: { code: scope.entityCode },
    book: { code: scope.bookCode },
    documentDate: { gte: fromDate, lte: toDate },
    ...searchFilter,
  };

  const [entries, totalCount] = await Promise.all([
    prisma.journalEntry.findMany({
      where: whereClause,
      orderBy: [{ documentDate: "desc" }, { entryNumber: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        entryNumber: true,
        documentDate: true,
        memo: true,
        source: true,
        status: true,
        sourceSystem: true,
        sourceRecordType: true,
        lines: { select: { debit: true } },
        // Count unresolved notes per entry. Tiny query addition — Prisma
        // batches it into one COUNT(*) per row. Surface a badge on rows
        // with open review questions.
        _count: {
          select: {
            notes: { where: { resolvedAt: null } },
          },
        },
      },
    }),
    prisma.journalEntry.count({ where: whereClause }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  // Clamp the page so a stale URL with too-high page doesn't show empty.
  const currentPage = Math.min(page, totalPages);

  // Prev/next preserve every filter because `buildUrl` walks the spec rather
  // than a hand-kept list. The previous version of this function had to
  // remember `from`, `to` and `q` by name, and would have silently dropped
  // any filter added later — which is the drift `url-state.ts` exists to stop.
  // It also wrote `from`/`to` even at their defaults; now an unfiltered page 2
  // is just `?page=2`.
  const pageUrl = (p: number) => buildUrl("/journal-entries", SPEC, state, { page: p });

  return (
    <div className="flex flex-col gap-6">
      {viewer && (
        <SavedViews
          surface="journal-entries"
          views={views}
          currentQuery={currentQuery}
          currentUserId={viewer.id}
        />
      )}
      <FilterChips
        chips={chips}
        clearAllHref={buildUrl("/journal-entries", SPEC, defaultsOf(SPEC))}
      />
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Journal entries</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · {totalCount} entr
            {totalCount === 1 ? "y" : "ies"} · {formatDate(fromDate)} →{" "}
            {formatDate(toDate)}
            {q && (
              <>
                {" "}
                · matching <span className="font-mono">{q}</span>
              </>
            )}
          </p>
        </div>
        <form method="GET" className="flex items-end gap-2 flex-wrap">
          <div className="min-w-[200px]">
            <Label htmlFor="q">Search</Label>
            <Input
              type="search"
              name="q"
              id="q"
              defaultValue={q}
              placeholder="memo · description · party"
            />
          </div>
          <div>
            <Label htmlFor="from">From</Label>
            <Input type="date" name="from" id="from" defaultValue={from} />
          </div>
          <div>
            <Label htmlFor="to">To</Label>
            <Input type="date" name="to" id="to" defaultValue={to} />
          </div>
          <button
            type="submit"
            className="h-9 rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800"
          >
            Filter
          </button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Entries (newest first)</CardTitle>
          <span className="text-xs text-ink-500">
            {q
              ? `Searching memo / description / party / entry number across the date range`
              : `Page ${currentPage} of ${totalPages}, ${PAGE_SIZE} per page`}
          </span>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <EmptyState
              title={q ? `No entries matching "${q}"` : "No entries match this filter"}
              description={q ? "Try a shorter or different search term." : undefined}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Entry #</TH>
                  <TH>Date</TH>
                  <TH>Memo</TH>
                  <TH>Source</TH>
                  <TH>Lineage</TH>
                  <TH className="text-right">Total</TH>
                </tr>
              </THead>
              <TBody>
                {entries.map((entry) => {
                  const total = entry.lines.reduce(
                    (acc, l) => acc.plus(new Decimal(l.debit.toString())),
                    new Decimal(0)
                  );
                  return (
                    <TR key={entry.id}>
                      <TD className="font-mono text-xs">
                        <Link href={`/journal-entries/${entry.id}`} className="text-ink-900 hover:underline">
                          {entry.entryNumber}
                        </Link>
                      </TD>
                      <TD className="text-ink-500">{formatDate(entry.documentDate)}</TD>
                      <TD className="text-ink-800">
                        {entry.memo}
                        {entry.status !== "POSTED" && (
                          <Badge tone={entry.status === "REVERSED" ? "warning" : "neutral"} className="ml-2">
                            {entry.status}
                          </Badge>
                        )}
                        {entry._count.notes > 0 && (
                          <Badge tone="warning" className="ml-2" title="Open review notes">
                            {entry._count.notes} note{entry._count.notes === 1 ? "" : "s"}
                          </Badge>
                        )}
                      </TD>
                      <TD>
                        <SourceBadge source={entry.source} />
                      </TD>
                      <TD>
                        {entry.sourceSystem ? (
                          <span className="text-xs text-ink-500">
                            {entry.sourceSystem} · {entry.sourceRecordType}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-500">—</span>
                        )}
                      </TD>
                      <TD className="amount-cell text-right">{formatMoney(total)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
          {/* ⚠️ The "Showing 1–12 of 12" line now renders on a single page too.
              It used to be gated behind `totalPages > 1` here and was not on
              /transactions — one of the two divergences that came out of the
              same block being written twice. */}
          {entries.length > 0 && (
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              totalCount={totalCount}
              pageSize={PAGE_SIZE}
              hrefFor={pageUrl}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
