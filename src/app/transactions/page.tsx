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
// `transactionsHref()` — no modal, no shared client store, no endpoint.
//
// This page is also the reference implementation of the column contract
// (src/components/ui/data-table.tsx): alignment is declared once per column
// instead of once per cell, and the visible set is a URL parameter, so the
// Columns control is an `<a href>` and a saved view captures your columns.

import Link from "next/link";

import type { Prisma } from "@prisma/client";

import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listViews } from "@/app/actions/saved-views";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ColumnPicker } from "@/components/ui/column-picker";
import { Pagination } from "@/components/ui/pagination";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterChips } from "@/components/ui/filter-chips";
import { SavedViews } from "@/components/ui/saved-views";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { toggleVisible, type ColumnMeta } from "@/lib/surfaces/columns";
import {
  buildUrl,
  defaultsOf,
  filterChips,
  parseUrlState,
  type RawParams,
} from "@/lib/url-state";
import {
  TRANSACTIONS_SPEC as SPEC,
  TRANSACTIONS_PATH,
  TRANSACTION_COLUMNS,
  type TransactionColumnKey,
} from "@/lib/surfaces/transactions";

const PAGE_SIZE = 50;

/**
 * Declared as a const so the row type below is derived from it rather than
 * hand-written — a select and a type that drift produce cells rendering
 * `undefined` with no compiler complaint.
 */
const LINE_SELECT = {
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
} satisfies Prisma.JournalLineSelect;

type LineRow = Prisma.JournalLineGetPayload<{ select: typeof LINE_SELECT }>;

const dash = <span className="text-ink-500">—</span>;

/** An amount cell that shows a dash rather than 0.00 for the unused side. */
function amount(value: Prisma.Decimal) {
  return new Decimal(value.toString()).isZero() ? dash : formatMoney(value);
}

/**
 * The render half of each column. The metadata half lives in
 * `src/lib/surfaces/transactions.ts` — this is `Record<TransactionColumnKey, …>`,
 * so adding a column there is a COMPILE ERROR here until it has a cell, and a
 * cell for a column that no longer exists is a compile error too. Two lists
 * that must agree, reduced to one list plus a type.
 */
const CELLS: Record<TransactionColumnKey, Omit<Column<LineRow>, keyof ColumnMeta>> = {
  date: {
    cell: (l) => formatDate(l.entry.documentDate),
    cellClassName: "whitespace-nowrap",
  },
  entry: {
    // The entry number repeats down consecutive rows when one entry has many
    // lines. That is correct and is what makes this the line-level view.
    cell: (l) => (
      <Link
        href={`/journal-entries/${l.entry.id}`}
        className="font-mono text-xs text-ink-900 hover:underline"
      >
        {l.entry.entryNumber}
      </Link>
    ),
  },
  account: {
    cell: (l) => (
      <>
        <span className="font-mono text-xs">{l.account.code}</span>{" "}
        <span className="text-ink-500">{l.account.name}</span>
      </>
    ),
    cellClassName: "whitespace-nowrap",
  },
  debit: { numeric: true, cell: (l) => amount(l.debit) },
  credit: { numeric: true, cell: (l) => amount(l.credit) },
  description: {
    cell: (l) => l.description ?? l.entry.memo ?? dash,
    cellClassName: "text-ink-700",
  },
  // Was rendered inside the description cell. Its own column means it can be
  // turned off, and that it lines up down the page.
  party: {
    cell: (l) => (l.party?.code ? <span className="font-mono text-xs">{l.party.code}</span> : dash),
  },
  // ⚠️ `source` and `lineNo` were already being SELECTED and thrown away — the
  // query paid for both and the table rendered neither.
  source: {
    cell: (l) => <span className="font-mono text-xs text-ink-700">{l.entry.source}</span>,
  },
  lineNo: { numeric: true, cell: (l) => l.lineNo },
};

const COLUMNS: Column<LineRow>[] = TRANSACTION_COLUMNS.map((meta) => ({
  ...meta,
  ...CELLS[meta.key],
}));

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
  const { account, from, to, q, page, cols } = state;
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
      select: LINE_SELECT,
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

      <div className="flex flex-wrap items-end justify-between gap-4">
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
        <form method="GET" className="flex flex-wrap items-end gap-2">
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
          {/* The column choice is a URL parameter, so a GET form that does not
              carry it would silently reset the reader's columns on every
              Apply. Hidden, because the picker owns the control. */}
          {SPEC.cols.serialize(cols) !== undefined && (
            <input type="hidden" name="cols" value={SPEC.cols.serialize(cols)} />
          )}
          <button
            type="submit"
            className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
          >
            Apply
          </button>
        </form>
      </div>

      <Card>
        {/* CardHeader is already `flex items-center justify-between`. */}
        <CardHeader className="gap-4">
          <CardTitle>Lines</CardTitle>
          <ColumnPicker
            columns={TRANSACTION_COLUMNS}
            visible={cols}
            hrefFor={(key) =>
              buildUrl(TRANSACTIONS_PATH, SPEC, state, {
                cols: toggleVisible(TRANSACTION_COLUMNS, cols, key),
              })
            }
            resetHref={buildUrl(TRANSACTIONS_PATH, SPEC, state, {
              cols: defaultsOf(SPEC).cols,
            })}
          />
        </CardHeader>
        <CardContent>
          <DataTable
            columns={COLUMNS}
            rows={lines}
            visible={cols}
            getRowKey={(l) => l.id}
            empty={
              <EmptyState
                title="No lines match"
                description="Widen the date range, clear a filter, or check the account code."
              />
            }
            // Keyed by COLUMN KEY, so hiding Debit takes its total with it
            // instead of shifting every remaining total one column left.
            footer={{
              label: "This page",
              cells: {
                debit: formatMoney(pageDebit),
                credit: formatMoney(pageCredit),
              },
            }}
          />

          <Pagination
            page={currentPage}
            totalPages={totalPages}
            totalCount={totalCount}
            pageSize={PAGE_SIZE}
            hrefFor={pageUrl}
          />
        </CardContent>
      </Card>
    </div>
  );
}
