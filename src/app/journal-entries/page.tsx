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
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { tenantScopeOrNone } from "@/lib/db-sentinels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SourceBadge } from "@/components/ui/source-badge";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";

const PAGE_SIZE = 50;

export default async function JournalEntriesPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; q?: string; page?: string };
}) {
  const scope = getScope();
  const from = searchParams.from ?? "2026-01-01";
  const to = searchParams.to ?? "2026-12-31";
  const q = (searchParams.q ?? "").trim();
  // Page is 1-indexed for the URL (CPAs read "page 1 of 12" naturally);
  // we'll convert to offset for the query.
  const pageRaw = Number.parseInt(searchParams.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const fromDate = new Date(from);
  const toDate = new Date(to);

  // Tenant-scope (Phase 4c): defense-in-depth against cross-tenant reads.
  // JournalEntry has a denormalized tenantId; filtering on it cuts the
  // query plan AND closes the leak when Phase 4b makes entityCode no
  // longer globally unique.
  const tenant = await getCurrentTenant();
  const tenantFilter = tenantScopeOrNone(tenant?.id);

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

  // Build a query-string for the prev/next links that preserves filter
  // params (date range + search). Just rewrite the `page` field.
  function pageUrl(p: number): string {
    const params = new URLSearchParams();
    params.set("from", from);
    params.set("to", to);
    if (q) params.set("q", q);
    if (p > 1) params.set("page", String(p));
    return `?${params.toString()}`;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
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
        <form method="GET" className="flex items-end gap-2">
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
                          <span className="text-xs text-ink-400">—</span>
                        )}
                      </TD>
                      <TD className="amount-cell text-right">{formatMoney(total)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
          {entries.length > 0 && totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
              <span>
                Showing {(currentPage - 1) * PAGE_SIZE + 1}–
                {Math.min(currentPage * PAGE_SIZE, totalCount)} of {totalCount}
              </span>
              <div className="flex items-center gap-2">
                {currentPage > 1 ? (
                  <Link
                    href={pageUrl(currentPage - 1)}
                    className="rounded-md border border-ink-200 px-3 py-1.5 hover:bg-ink-50"
                  >
                    ← Prev
                  </Link>
                ) : (
                  <span className="rounded-md border border-ink-200 px-3 py-1.5 text-ink-300">
                    ← Prev
                  </span>
                )}
                <span className="font-mono text-xs">
                  {currentPage} / {totalPages}
                </span>
                {currentPage < totalPages ? (
                  <Link
                    href={pageUrl(currentPage + 1)}
                    className="rounded-md border border-ink-200 px-3 py-1.5 hover:bg-ink-50"
                  >
                    Next →
                  </Link>
                ) : (
                  <span className="rounded-md border border-ink-200 px-3 py-1.5 text-ink-300">
                    Next →
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
