// Transactions — the LINE-level ledger view.
//
// ⚠️ THIS IS NOT A SECOND JOURNAL-ENTRIES LIST. `/journal-entries` is
// header-level: one row per JournalEntry, answering "what did we post". This is
// one row per JournalLine, answering "what is in this account" — and they are
// different screens because they answer different questions, with different
// columns and different natural filters.
//
// The distinction came out of reading Campfire's own transactions screen, where
// one entry number repeats down twelve consecutive rows
// (docs/design/campfire-product-surface.md §6). We had only the header-level
// half, which is why a report cell had nowhere to land.
//
// THAT IS WHAT THIS PAGE IS FOR. A number on the income statement is the sum of
// the lines that hit one account in one period; clicking it should show exactly
// those lines. Because the whole filter state lives in the URL
// (src/lib/url-state.ts), the drill-down is an <a href> built by
// `transactionsHref()` below — no modal, no shared client store, no endpoint.

import Link from "next/link";

import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listViews } from "@/app/actions/saved-views";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterChips } from "@/components/ui/filter-chips";
import { SavedViews } from "@/components/ui/saved-views";
import { formatDate, formatMoney } from "@/lib/utils/format";
import {
  buildUrl,
  defaultsOf,
  filterChips,
  parseUrlState,
  type RawParams,
} from "@/lib/url-state";
import { TRANSACTIONS_SPEC as SPEC, TRANSACTIONS_PATH } from "@/lib/surfaces/transactions";

const PAGE_SIZE = 50;

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: RawParams;
}) {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity to view transactions."
      />
    );
  }

  const state = parseUrlState(SPEC, searchParams);
  const { account, from, to, q, page } = state;
  const chips = filterChips(TRANSACTIONS_PATH, SPEC, state, defaultsOf(SPEC));
  const currentQuery = buildUrl("", SPEC, state).replace(/^\?/, "");

  // Tenant pin from the verified scope, on the LINE's own denormalized
  // tenantId — not only through the entry relation. Both are filtered: the
  // line's for the index, the entry's for the entity/book/date predicate.
  const where = {
    tenantId: scope.tenantId,
    entry: {
      tenantId: scope.tenantId,
      entity: { code: scope.entityCode },
      book: { code: scope.bookCode },
      documentDate: { gte: new Date(from), lte: new Date(to) },
    },
    ...(account ? { account: { code: account } } : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: "insensitive" as const } },
            { entry: { memo: { contains: q, mode: "insensitive" as const } } },
            { entry: { entryNumber: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [lines, totalCount, accountName, views, viewer] = await Promise.all([
    prisma.journalLine.findMany({
      where,
      orderBy: [{ entry: { documentDate: "desc" } }, { entryId: "desc" }, { lineNo: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        lineNo: true,
        debit: true,
        credit: true,
        description: true,
        account: { select: { code: true, name: true } },
        party: { select: { code: true } },
        entry: {
          select: { id: true, entryNumber: true, documentDate: true, memo: true, source: true },
        },
      },
    }),
    prisma.journalLine.count({ where }),
    // The display name for the chip — derived, never carried in the URL.
    account
      ? prisma.account
          .findFirst({
            where: { tenantId: scope.tenantId, code: account },
            select: { name: true },
          })
          .then((a) => a?.name ?? null)
      : Promise.resolve(null),
    listViews("transactions").catch(() => []),
    getCurrentUser().catch(() => null),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageUrl = (p: number) => buildUrl(TRANSACTIONS_PATH, SPEC, state, { page: p });

  // Debits and credits of what is on screen. Deliberately the PAGE total, and
  // labelled as such — a running total of 50 of 4,000 rows presented as "the
  // total" is the kind of number a reviewer quotes and then has to retract.
  const pageDebit = lines.reduce((a, l) => a.plus(new Decimal(l.debit.toString())), new Decimal(0));
  const pageCredit = lines.reduce((a, l) => a.plus(new Decimal(l.credit.toString())), new Decimal(0));

  return (
    <div className="flex flex-col gap-6">
      {viewer && (
        <SavedViews
          surface="transactions"
          views={views}
          currentQuery={currentQuery}
          currentUserId={viewer.id}
        />
      )}
      <FilterChips chips={chips} clearAllHref={buildUrl(TRANSACTIONS_PATH, SPEC, defaultsOf(SPEC))} />

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Transactions</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · {totalCount} line
            {totalCount === 1 ? "" : "s"} · {formatDate(new Date(from))} →{" "}
            {formatDate(new Date(to))}
            {account && (
              <>
                {" "}
                · <span className="font-mono">{account}</span>
                {accountName && ` ${accountName}`}
              </>
            )}
          </p>
        </div>
        <form method="GET" className="flex items-end gap-2 flex-wrap">
          <div className="w-32">
            <Label htmlFor="account">Account</Label>
            <Input id="account" name="account" defaultValue={account} placeholder="4010" />
          </div>
          <div className="w-36">
            <Label htmlFor="from">From</Label>
            <Input id="from" name="from" type="date" defaultValue={from} />
          </div>
          <div className="w-36">
            <Label htmlFor="to">To</Label>
            <Input id="to" name="to" type="date" defaultValue={to} />
          </div>
          <div className="min-w-[180px]">
            <Label htmlFor="q">Search</Label>
            <Input id="q" name="q" defaultValue={q} placeholder="description or entry" />
          </div>
          <button
            type="submit"
            className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
          >
            Apply
          </button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent>
          {lines.length === 0 ? (
            <EmptyState
              title="No lines match"
              description="Widen the date range, clear a filter, or check the account code."
            />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Entry</TH>
                    <TH>Account</TH>
                    <TH className="text-right">Debit</TH>
                    <TH className="text-right">Credit</TH>
                    <TH>Description</TH>
                  </TR>
                </THead>
                <TBody>
                  {lines.map((l) => (
                    <TR key={l.id}>
                      <TD className="whitespace-nowrap">{formatDate(l.entry.documentDate)}</TD>
                      <TD>
                        {/* The entry number repeats down consecutive rows when
                            one entry has many lines. That is correct and is
                            what makes this the line-level view. */}
                        <Link
                          href={`/journal-entries/${l.entry.id}`}
                          className="font-mono text-xs text-ink-900 hover:underline"
                        >
                          {l.entry.entryNumber}
                        </Link>
                      </TD>
                      <TD className="whitespace-nowrap">
                        <span className="font-mono text-xs">{l.account.code}</span>{" "}
                        <span className="text-ink-500">{l.account.name}</span>
                      </TD>
                      <TD className="amount-cell text-right">
                        {new Decimal(l.debit.toString()).isZero() ? (
                          <span className="text-ink-500">—</span>
                        ) : (
                          formatMoney(l.debit)
                        )}
                      </TD>
                      <TD className="amount-cell text-right">
                        {new Decimal(l.credit.toString()).isZero() ? (
                          <span className="text-ink-500">—</span>
                        ) : (
                          formatMoney(l.credit)
                        )}
                      </TD>
                      <TD className="text-ink-700">
                        {l.description ?? l.entry.memo ?? <span className="text-ink-500">—</span>}
                        {l.party?.code && (
                          <span className="ml-2 font-mono text-xs text-ink-500">
                            {l.party.code}
                          </span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>

              <div className="mt-4 flex items-center justify-between gap-4 text-sm text-ink-500 flex-wrap">
                <span>
                  Showing {(currentPage - 1) * PAGE_SIZE + 1}–
                  {Math.min(currentPage * PAGE_SIZE, totalCount)} of {totalCount}
                </span>
                <span className="font-mono text-xs">
                  This page: {formatMoney(pageDebit)} Dr / {formatMoney(pageCredit)} Cr
                </span>
                {totalPages > 1 && (
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
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
