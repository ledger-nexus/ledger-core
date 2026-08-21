// Per-account detail + edit page. Code-keyed URL because codes are
// what CPAs say out loud ("Edit 1500"); UUIDs are not.
//
// The centerpiece is the account register — the running-balance ledger of
// every posting that hit this account in the current (entity, book). It's
// the "checkbook register" every QuickBooks user reaches for: you open an
// account to see what happened and what the balance is. This page used to
// show only a count ("Posted lines: 42"), which answers neither question.

import { notFound } from "next/navigation";
import { LEDGER_EFFECTIVE_STATUSES } from "@/lib/accounting/types";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getViewerRole } from "@/lib/auth/authorize";
import { canEditAccounts } from "@/lib/auth/policy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/badge";
import { SourceBadge } from "@/components/ui/source-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";
import { balanceFromSums, olderThan, withRunningBalance } from "@/lib/accounting/register";
import { buildUrl, int, parseUrlState, type RawParams, type SurfaceSpec } from "@/lib/url-state";
import EditAccountForm from "./edit-account-form";

// One page of the register.
//
// ⚠️ THIS USED TO BE A DISPLAY CAP OVER A FULL FETCH. The page read every line
// ever posted to the account — with its entry and party joins — accumulated
// the running balance from zero, rendered `.slice(-250)`, and said "newest 250
// of N". Two things were wrong with that: the query's cost grew with the
// account's whole history to show a fixed 250 rows, and **there was no way to
// reach line 251**. "Show me last March" is the most ordinary request an
// accountant has of a register, and the page could not answer it.
//
// Now the balance before a page comes from one aggregate (see
// src/lib/accounting/register.ts) and the page itself is `take`. Page 1 shows
// exactly what it showed before.
const REGISTER_PAGE_SIZE = 250;

/** The register's only parameter. Kept here — no other surface links into it. */
const REGISTER_SPEC = { page: int(1, { min: 1 }) } satisfies SurfaceSpec;

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: { code: string };
  searchParams: RawParams;
}) {
  const scope = await getCurrentScope();
  if (!scope) return notFound();
  const canEdit = canEditAccounts(await getViewerRole());

  // Try entity-specific first, fall back to shared. Mirrors how the
  // chart of accounts dedups in reports.
  const account =
    (await prisma.account.findFirst({
      where: {
        tenantId: scope.tenantId,
        code: params.code,
        entity: { code: scope.entityCode },
      },
      include: {
        parent: { select: { code: true, name: true } },
        children: { orderBy: { code: "asc" }, select: { code: true, name: true } },
        entity: { select: { code: true } },
      },
    })) ??
    (await prisma.account.findFirst({
      where: {
        tenantId: scope.tenantId,
        code: params.code,
        entityId: null,
      },
      include: {
        parent: { select: { code: true, name: true } },
        children: { orderBy: { code: "asc" }, select: { code: true, name: true } },
        entity: { select: { code: true } },
      },
    }));

  if (!account) return notFound();

  // Candidate parents: same scope, same type, not the account itself.
  const candidates = await prisma.account.findMany({
    where: {
      tenantId: scope.tenantId,
      active: true,
      type: account.type,
      id: { not: account.id },
      OR: [{ entityId: null }, { entityId: account.entityId ?? undefined }],
    },
    orderBy: { code: "asc" },
    select: { code: true, name: true },
  });

  // Register: every posting to this account in the CURRENT (entity, book).
  // A shared account (entityId null) collects lines from many entities and
  // books, so the scope filter is what makes the running balance match the
  // scope the rest of the page is showing.
  //
  // ⚠️ THE `tenantId` TERM IS NOT REDUNDANT DECORATION. `accountId` is a uuid
  // resolved from the tenant-scoped lookup above, so the rows are already this
  // tenant's transitively — but the register now runs an `aggregate` as well as
  // a `findMany`, and a scoping argument that has to be traced through a
  // variable is one nobody re-checks when the query moves. `JournalLine`
  // carries its own denormalized `tenantId` (this is what /transactions filters
  // on), so naming it is free, index-friendly, and readable at the query.
  //
  // tests/tenant-scope-guard.test.ts flagged the new aggregate for exactly this
  // — the guard reads the query, not the provenance of `account.id`.
  const registerWhere: Prisma.JournalLineWhereInput = {
    tenantId: scope.tenantId,
    accountId: account.id,
    entry: {
      entity: { code: scope.entityCode },
      book: { code: scope.bookCode },
      // Register running balance = ledger truth: pending/void entries
      // carry lines but must not move the balance.
      status: { in: [...LEDGER_EFFECTIVE_STATUSES] },
    },
  };

  // Running balance on the account's NORMAL side, so a positive number
  // always reads as "more of what this account normally holds": for a
  // bank account (debit-normal) a deposit raises it; for a credit card
  // (credit-normal) a charge raises it.
  const normalIsDebit = account.normalBalance === "DEBIT";

  const [totalLines, allTotals] = await Promise.all([
    prisma.journalLine.count({ where: registerWhere }),
    // The account's balance, without returning a single line. This is what
    // the full fetch was really being used for.
    prisma.journalLine.aggregate({ where: registerWhere, _sum: { debit: true, credit: true } }),
  ]);
  const currentBalance = balanceFromSums(allTotals._sum, normalIsDebit);

  const totalPages = Math.max(1, Math.ceil(totalLines / REGISTER_PAGE_SIZE));
  const registerPage = Math.min(parseUrlState(REGISTER_SPEC, searchParams).page, totalPages);

  // Newest first, because that is how a register reads — page 1 is the most
  // recent activity and its top row carries the account's current balance.
  const windowDesc = await prisma.journalLine.findMany({
    where: registerWhere,
    orderBy: [
      { entry: { documentDate: "desc" } },
      { entry: { entryNumber: "desc" } },
      { lineNo: "desc" },
    ],
    skip: (registerPage - 1) * REGISTER_PAGE_SIZE,
    take: REGISTER_PAGE_SIZE,
    select: {
      id: true,
      lineNo: true,
      debit: true,
      credit: true,
      description: true,
      party: { select: { displayName: true } },
      entry: {
        select: {
          id: true,
          entryNumber: true,
          documentDate: true,
          memo: true,
          source: true,
        },
      },
    },
  });

  // The balance the page opens on: everything strictly older than its oldest
  // row. ⚠️ The oldest row of a newest-first window is the LAST element, and
  // the comparison is over the whole ordering triple — see `olderThan`.
  const oldest = windowDesc[windowDesc.length - 1];
  const opening = oldest
    ? balanceFromSums(
        (
          await prisma.journalLine.aggregate({
            where: {
              // Named at the query, not only inside `registerWhere` — the
              // tenant-scope guard reads the query it can see, and so does
              // the next person to move this aggregate somewhere else.
              tenantId: scope.tenantId,
              AND: [
                registerWhere,
                olderThan({
                  documentDate: oldest.entry.documentDate,
                  entryNumber: oldest.entry.entryNumber,
                  lineNo: oldest.lineNo,
                }),
              ],
            },
            _sum: { debit: true, credit: true },
          })
        )._sum,
        normalIsDebit
      )
    : new Decimal(0);

  // Accumulate oldest→newest inside the window, then reverse for display.
  const displayRows = withRunningBalance(
    [...windowDesc].reverse(),
    opening,
    normalIsDebit
  ).reverse();

  const registerUrl = (p: number) =>
    buildUrl(`/accounts/${account.code}`, REGISTER_SPEC, { page: p });

  type RegisterRow = (typeof displayRows)[number];
  const REGISTER_COLUMNS: Column<RegisterRow>[] = [
    {
      key: "date",
      label: "Date",
      cell: (r) => formatDate(r.line.entry.documentDate),
      cellClassName: "whitespace-nowrap text-ink-500",
    },
    {
      key: "entry",
      label: "Entry",
      cell: (r) => (
        <Link
          href={`/journal-entries/${r.line.entry.id}`}
          className="text-link hover:underline"
        >
          {r.line.entry.entryNumber}
        </Link>
      ),
      cellClassName: "whitespace-nowrap font-mono text-xs",
    },
    {
      key: "description",
      label: "Description",
      cell: (r) => (
        <>
          {r.line.description || r.line.entry.memo}
          {r.line.party?.displayName && (
            <span className="ml-1 text-ink-500">· {r.line.party.displayName}</span>
          )}
          {r.line.entry.source !== "MANUAL" && (
            <span className="ml-2 inline-flex align-middle">
              <SourceBadge source={r.line.entry.source} />
            </span>
          )}
        </>
      ),
      cellClassName: "text-ink-800",
    },
    { key: "debit", label: "Debit", numeric: true, cell: (r) => (r.debit.isZero() ? "" : formatMoney(r.debit)) },
    { key: "credit", label: "Credit", numeric: true, cell: (r) => (r.credit.isZero() ? "" : formatMoney(r.credit)) },
    {
      key: "balance",
      label: "Balance",
      numeric: true,
      // ⚠️ The one column whose colour is data: a balance on the wrong side of
      // zero for this account type reads red.
      cell: (r) => <span className={moneyClass(r.balance)}>{formatMoney(r.balance)}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-500">
          <Link href="/accounts" className="text-link hover:underline">
            ← Chart of Accounts
          </Link>
        </p>
        <h2 className="mt-2 text-xl font-semibold text-ink-900">
          <span className="font-mono">{account.code}</span> — {account.name}
        </h2>
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-500">
          <Badge tone="info">{account.type}</Badge>
          <Badge tone="neutral">{account.normalBalance}</Badge>
          {account.entityId === null ? (
            <Badge tone="neutral">shared</Badge>
          ) : (
            <Badge tone="neutral">{account.entity?.code ?? "entity"}</Badge>
          )}
          {!account.active && <Badge tone="warning">inactive</Badge>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-baseline gap-2">
            <CardTitle>Balance</CardTitle>
            <span className="text-xs text-ink-500">
              in {scope.entityCode} / {scope.bookCode}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-500">
                Current balance
              </div>
              <div
                className={`mt-0.5 font-mono text-xl font-semibold tabular-nums ${moneyClass(
                  currentBalance
                )}`}
              >
                {formatMoney(currentBalance)}
              </div>
            </div>
            <Stat label="Postings" value={totalLines.toString()} />
            <Stat
              label="Parent"
              value={
                account.parent ? `${account.parent.code} — ${account.parent.name}` : "—"
              }
            />
          </div>
          {account.children.length > 0 && (
            <div className="mt-4 text-xs text-ink-500">
              <span className="uppercase font-medium tracking-wider">Children:</span>{" "}
              {account.children.map((c, i) => (
                <span key={c.code}>
                  <Link href={`/accounts/${c.code}`} className="font-mono text-link hover:underline">
                    {c.code}
                  </Link>
                  {i < account.children.length - 1 ? ", " : ""}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Register</CardTitle>
          {totalPages > 1 && (
            <span className="text-xs text-ink-500">
              page {registerPage} of {totalPages} — newest first
            </span>
          )}
        </CardHeader>
        <CardContent>
          <DataTable
            columns={REGISTER_COLUMNS}
            rows={displayRows}
            visible={REGISTER_COLUMNS.map((c) => c.key)}
            getRowKey={(r) => r.line.id}
            empty={
              <EmptyState
                title="No activity in this account yet"
                description={`Nothing has posted to ${account.code} in ${scope.entityCode} / ${scope.bookCode}.`}
              />
            }
          />
          {totalLines > 0 && (
            <Pagination
              page={registerPage}
              totalPages={totalPages}
              totalCount={totalLines}
              pageSize={REGISTER_PAGE_SIZE}
              hrefFor={registerUrl}
            />
          )}
        </CardContent>
      </Card>

      {canEdit ? (
        <EditAccountForm
          accountId={account.id}
          initialName={account.name}
          initialSubtype={account.subtype ?? ""}
          initialParentCode={account.parent?.code ?? ""}
          initialIsContra={account.isContra}
          initialIsControlAccount={account.isControlAccount}
          initialIsBank={account.isBank}
          initialActive={account.active}
          candidates={candidates}
        />
      ) : (
        <EmptyState
          title="Read-only"
          description="Editing accounts requires admin permission."
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className="mt-0.5 text-ink-900">{value}</div>
    </div>
  );
}
