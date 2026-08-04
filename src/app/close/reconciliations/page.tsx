// BlackLine arc — Phase 1 PR 3: Account Reconciliations list page.
//
// /close/reconciliations is the controller's daily landing page during
// close. Shows every Reconciliation row in the active scope, sortable so
// the worst-disagreement rows surface first.
//
// Why this page exists:
//   - BlackLine's flagship screen is the "Reconciliations" grid. Operators
//     work it top-down: status badge, age, owner, biggest diff. We
//     mirror that mental model.
//   - Sort by `reconciledDiff` DESC (absolute value, computed at row-write
//     time and stored — see schema note) so a $500K disagreement on Cash
//     sorts above a $1.20 rounding diff on Prepaid Rent. The
//     `(periodId, status)` index keeps the WHERE plan tenant-fast.
//
// Filter knobs (URL search params):
//   ?period=YYYY-MM   — fiscal period code. Defaults to the latest OPEN
//                       period for the scope. If every period is closed,
//                       defaults to the most recent one.
//   ?status=...       — filter to one ReconStatus. Optional. Default = all.
//   ?sort=diff|status|account
//                     — column to sort by. Default = "diff" (BlackLine UX).
//
// Multi-tenant: scoped through `getCurrentTenant()` → tenantId filter.
// Multi-book: scoped through the sidebar cookie's (entity, book).
//
// Auto-instantiation (turning every BS account into an OPEN recon row on
// period-open) ships in PR 6; for now the page shows whatever rows exist,
// which means a brand-new period renders empty until somebody clicks an
// "Open recon" button on an Account detail page (PR 4) — fine for the
// list-page commit.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";
import type { ReconStatus } from "@prisma/client";
import AutoOpenButton from "./auto-open-button";

// ─────────────────────────────────────────────────────────────────────────
// Status → badge tone. Single source of truth so the list page, the
// detail page (PR 4), and the dashboard rollup all paint the same colors.
// ─────────────────────────────────────────────────────────────────────────
const STATUS_TONES: Record<
  ReconStatus,
  "neutral" | "positive" | "negative" | "warning" | "info"
> = {
  OPEN: "neutral",
  IN_PROGRESS: "info",
  PREPARED: "warning",
  RECONCILED: "positive",
  EXCEPTION: "negative",
  WAIVED: "neutral",
};

const ALL_STATUSES: ReconStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "PREPARED",
  "RECONCILED",
  "EXCEPTION",
  "WAIVED",
];

type SortKey = "diff" | "status" | "account";

function parseSort(raw: string | undefined): SortKey {
  return raw === "status" || raw === "account" ? raw : "diff";
}

export default async function ReconciliationsListPage({
  searchParams,
}: {
  searchParams: { period?: string; status?: string; sort?: string };
}) {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="Scope not found"
        description="Sign in and select a tenant with at least one entity."
      />
    );
  }
  const tenantFilter = { tenantId: scope.tenantId };

  // Resolve scope → entity + book IDs. Phase 4b: entity code is unique
  // per [tenantId, code].
  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId: scope.tenantId, code: scope.entityCode },
    select: { id: true, code: true, name: true },
  });
  const book = await prisma.book.findUnique({
    where: { code: scope.bookCode },
    select: { id: true, code: true, name: true },
  });

  if (!entity || !book) {
    return (
      <EmptyState
        title="Scope not found"
        description={`Could not resolve entity "${scope.entityCode}" / book "${scope.bookCode}". Switch scope from the sidebar.`}
      />
    );
  }

  // Pick the period: explicit ?period= wins; otherwise the latest OPEN
  // period for (entity, book). If every period is closed (rare in dev,
  // unheard of in prod — a fresh period always opens on the 1st), fall
  // back to the most recent period overall so the page still renders.
  const allPeriods = await prisma.period.findMany({
    where: { calendar: { entityId: entity.id } },
    orderBy: { startsOn: "desc" },
    select: { id: true, code: true, startsOn: true, endsOn: true },
  });

  if (allPeriods.length === 0) {
    return (
      <EmptyState
        title="No periods seeded"
        description={`${entity.code} has no fiscal periods yet, so there is nothing to reconcile.`}
      />
    );
  }

  let selectedPeriod = allPeriods[0];
  if (searchParams.period) {
    const match = allPeriods.find((p) => p.code === searchParams.period);
    if (!match) {
      return (
        <EmptyState
          title={`Period "${searchParams.period}" not found`}
          description={`No fiscal period with that code exists for ${entity.code}.`}
        />
      );
    }
    selectedPeriod = match;
  } else {
    // Find the latest OPEN period — i.e., one with no PeriodClose row.
    const closes = await prisma.periodClose.findMany({
      where: { entityId: entity.id, bookId: book.id },
      select: { periodId: true },
    });
    const closedIds = new Set(closes.map((c) => c.periodId));
    const latestOpen = allPeriods.find((p) => !closedIds.has(p.id));
    if (latestOpen) selectedPeriod = latestOpen;
  }

  // Is the selected period closed? Auto-open refuses on closed periods,
  // so we hide the affordance there.
  const selectedClose = await prisma.periodClose.findUnique({
    where: {
      entityId_bookId_periodId: {
        entityId: entity.id,
        bookId: book.id,
        periodId: selectedPeriod.id,
      },
    },
    select: { closedAt: true },
  });
  const periodIsClosed = !!selectedClose;

  // Status filter — optional.
  const statusFilter =
    searchParams.status && (ALL_STATUSES as string[]).includes(searchParams.status)
      ? (searchParams.status as ReconStatus)
      : null;

  const sortKey = parseSort(searchParams.sort);

  // Pull the recons. Tenant filter is defense-in-depth; the
  // (entityId, bookId, periodId) tuple already narrows tightly.
  const recons = await prisma.reconciliation.findMany({
    where: {
      ...tenantFilter,
      entityId: entity.id,
      bookId: book.id,
      periodId: selectedPeriod.id,
      ...(statusFilter ? { status: statusFilter } : {}),
    },
    select: {
      id: true,
      status: true,
      requiresReview: true,
      glBalance: true,
      supportingBalance: true,
      reconciledDiff: true,
      tolerance: true,
      preparedAt: true,
      reviewedAt: true,
      updatedAt: true,
      account: { select: { code: true, name: true, type: true } },
      preparer: { select: { displayName: true, email: true } },
      reviewer: { select: { displayName: true, email: true } },
      _count: { select: { attachments: true } },
    },
  });

  // In-memory sort. The default `diff` sort uses abs(reconciledDiff) DESC
  // so a $-100K shortage and a $+100K overage both sort to the top — the
  // CPA cares about magnitude of disagreement, not direction. Recons with
  // a null diff (preparer hasn't filed supporting balance yet) sort last
  // because there's no number to act on.
  const sorted = [...recons].sort((a, b) => {
    if (sortKey === "status") {
      // EXCEPTION → PREPARED → IN_PROGRESS → OPEN → RECONCILED → WAIVED
      // (urgency-descending — the things that need eyes go to the top).
      const order: Record<ReconStatus, number> = {
        EXCEPTION: 0,
        PREPARED: 1,
        IN_PROGRESS: 2,
        OPEN: 3,
        RECONCILED: 4,
        WAIVED: 5,
      };
      return order[a.status] - order[b.status];
    }
    if (sortKey === "account") {
      return a.account.code.localeCompare(b.account.code);
    }
    // sortKey === "diff" — abs DESC, nulls last.
    const aDiff = a.reconciledDiff
      ? new Decimal(a.reconciledDiff.toString()).abs()
      : null;
    const bDiff = b.reconciledDiff
      ? new Decimal(b.reconciledDiff.toString()).abs()
      : null;
    if (aDiff === null && bDiff === null) return 0;
    if (aDiff === null) return 1;
    if (bDiff === null) return -1;
    return bDiff.comparedTo(aDiff);
  });

  // Quick completion-percentage rollup for the page header. Counts WAIVED
  // toward "done" the same way BlackLine does — once an account is
  // formally excused for the period, it's off the controller's plate.
  const total = recons.length;
  const done = recons.filter(
    (r) => r.status === "RECONCILED" || r.status === "WAIVED"
  ).length;
  const pctDone = total === 0 ? 0 : Math.round((done / total) * 100);

  // Per-status histogram for the chip strip under the header. Helps the
  // controller see "I have 3 EXCEPTIONs that need eyes" at a glance.
  const histogram = ALL_STATUSES.map((s) => ({
    status: s,
    count: recons.filter((r) => r.status === s).length,
  }));

  function urlWith(overrides: {
    period?: string;
    status?: string | null;
    sort?: SortKey;
  }): string {
    const p = new URLSearchParams();
    p.set("period", overrides.period ?? selectedPeriod.code);
    if (overrides.status !== null) {
      const s = overrides.status ?? statusFilter;
      if (s) p.set("status", s);
    }
    p.set("sort", overrides.sort ?? sortKey);
    return `?${p.toString()}`;
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">Reconciliations</h1>
        <p className="text-sm text-ink-500">
          Per-account close-period reconciliations. Worst-disagreement rows
          sort to the top so the controller's eye lands on what needs work.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Scope: <span className="font-mono">{entity.code}</span> ·{" "}
          <span className="font-mono">{book.code}</span> ·{" "}
          <span className="font-mono">{selectedPeriod.code}</span> (
          {formatDate(selectedPeriod.startsOn)} →{" "}
          {formatDate(selectedPeriod.endsOn)})
        </p>
      </header>

      {/* Period switcher — render every period as a chip so a CPA can hop
          months without leaving the page. */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-500">Period:</span>
        {allPeriods.slice(0, 12).map((p) => {
          const active = p.id === selectedPeriod.id;
          return (
            <Link
              key={p.id}
              href={urlWith({ period: p.code })}
              className={
                active
                  ? "rounded-md bg-ink-900 px-2 py-1 font-mono text-white"
                  : "rounded-md border border-ink-200 px-2 py-1 font-mono text-ink-700 hover:bg-ink-50"
              }
            >
              {p.code}
            </Link>
          );
        })}
      </div>

      {/* Status histogram strip + "clear filter" link. */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Link
          href={urlWith({ status: null })}
          className={
            !statusFilter
              ? "rounded-full bg-ink-900 px-2.5 py-0.5 font-medium text-white"
              : "rounded-full bg-ink-100 px-2.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200"
          }
        >
          All · {total}
        </Link>
        {histogram.map(({ status, count }) => {
          if (count === 0) return null;
          const active = statusFilter === status;
          return (
            <Link
              key={status}
              href={urlWith({ status })}
              className={
                active
                  ? "rounded-full bg-ink-900 px-2.5 py-0.5 font-medium text-white"
                  : "rounded-full bg-ink-100 px-2.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200"
              }
            >
              {status} · {count}
            </Link>
          );
        })}
        <span className="ml-auto text-ink-500">
          {done} / {total} done · {pctDone}%
        </span>
        <Link
          href={`/api/close/reconciliations/csv?period=${selectedPeriod.code}${
            statusFilter ? `&status=${statusFilter}` : ""
          }`}
          className="rounded-md border border-ink-200 px-3 py-1 text-xs text-ink-700 hover:bg-ink-50"
        >
          Download CSV
        </Link>
      </div>

      {/* When the period has some recons already, hide auto-open in the
          header strip but keep it available as a "refresh from chart of
          accounts" command. Useful when a new BS account was added
          mid-period. */}
      {total > 0 && !periodIsClosed && (
        <div className="flex justify-end">
          <AutoOpenButton
            entityId={entity.id}
            bookId={book.id}
            periodId={selectedPeriod.id}
            periodCode={selectedPeriod.code}
            label="Sync recons from chart of accounts"
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {sorted.length} recon{sorted.length === 1 ? "" : "s"}
            {statusFilter ? ` · ${statusFilter}` : ""}
          </CardTitle>
          <span className="text-xs text-ink-500">
            Sorted by{" "}
            {sortKey === "diff"
              ? "biggest absolute disagreement"
              : sortKey === "status"
                ? "status (urgency first)"
                : "account code"}{" "}
            ·{" "}
            <Link
              href={urlWith({ sort: "diff" })}
              className={
                sortKey === "diff" ? "font-semibold text-ink-900" : "text-accent-600 hover:underline"
              }
            >
              by diff
            </Link>{" "}
            ·{" "}
            <Link
              href={urlWith({ sort: "status" })}
              className={
                sortKey === "status"
                  ? "font-semibold text-ink-900"
                  : "text-accent-600 hover:underline"
              }
            >
              by status
            </Link>{" "}
            ·{" "}
            <Link
              href={urlWith({ sort: "account" })}
              className={
                sortKey === "account"
                  ? "font-semibold text-ink-900"
                  : "text-accent-600 hover:underline"
              }
            >
              by account
            </Link>
          </span>
        </CardHeader>
        <CardContent className={sorted.length === 0 ? "" : "p-0"}>
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-8">
              <div className="text-center">
                <div className="text-sm font-medium text-ink-900">
                  {statusFilter
                    ? `No ${statusFilter} reconciliations`
                    : "No reconciliations for this period"}
                </div>
                <div className="mt-1 text-xs text-ink-500">
                  {statusFilter
                    ? "Try clearing the status filter."
                    : periodIsClosed
                      ? "This period is closed. Reopen it to instantiate recons."
                      : "Auto-instantiates one OPEN row per BS account using the requiresReview + tolerance cascade."}
                </div>
              </div>
              {!statusFilter && !periodIsClosed && (
                <AutoOpenButton
                  entityId={entity.id}
                  bookId={book.id}
                  periodId={selectedPeriod.id}
                  periodCode={selectedPeriod.code}
                />
              )}
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Account</TH>
                  <TH>Status</TH>
                  <TH className="text-right">GL balance</TH>
                  <TH className="text-right">Supporting</TH>
                  <TH className="text-right">Diff</TH>
                  <TH>Tolerance</TH>
                  <TH>Preparer</TH>
                  <TH>Reviewer</TH>
                  <TH>Updated</TH>
                  <TH>Files</TH>
                </tr>
              </THead>
              <TBody>
                {sorted.map((r) => {
                  const diff = r.reconciledDiff
                    ? new Decimal(r.reconciledDiff.toString())
                    : null;
                  const overTolerance =
                    diff &&
                    diff.abs().greaterThan(new Decimal(r.tolerance.toString()));
                  return (
                    <TR key={r.id}>
                      <TD>
                        <Link
                          href={`/close/reconciliations/${r.id}`}
                          className="text-ink-900 hover:underline"
                        >
                          <span className="font-mono text-xs">
                            {r.account.code}
                          </span>{" "}
                          <span className="text-ink-700">{r.account.name}</span>
                        </Link>
                      </TD>
                      <TD>
                        <Badge tone={STATUS_TONES[r.status]}>{r.status}</Badge>
                        {!r.requiresReview && (
                          <Badge tone="neutral" className="ml-1.5" title="Single sign-off">
                            1-sig
                          </Badge>
                        )}
                      </TD>
                      <TD className="amount-cell text-right">
                        {formatMoney(new Decimal(r.glBalance.toString()))}
                      </TD>
                      <TD className="amount-cell text-right">
                        {r.supportingBalance
                          ? formatMoney(
                              new Decimal(r.supportingBalance.toString())
                            )
                          : (
                            <span className="text-ink-400">—</span>
                          )}
                      </TD>
                      <TD
                        className={
                          overTolerance
                            ? "amount-cell text-right text-red-700 font-medium"
                            : "amount-cell text-right text-ink-700"
                        }
                      >
                        {diff ? (
                          formatMoney(diff)
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </TD>
                      <TD className="text-xs text-ink-500">
                        {new Decimal(r.tolerance.toString()).toFixed(2)}
                      </TD>
                      <TD className="text-xs text-ink-700">
                        {r.preparer?.displayName ?? (
                          <span className="text-ink-400">—</span>
                        )}
                        {r.preparedAt && (
                          <div className="text-[10px] text-ink-500">
                            {formatDate(r.preparedAt)}
                          </div>
                        )}
                      </TD>
                      <TD className="text-xs text-ink-700">
                        {r.reviewer?.displayName ?? (
                          <span className="text-ink-400">—</span>
                        )}
                        {r.reviewedAt && (
                          <div className="text-[10px] text-ink-500">
                            {formatDate(r.reviewedAt)}
                          </div>
                        )}
                      </TD>
                      <TD className="text-xs text-ink-500">
                        {formatDate(r.updatedAt)}
                      </TD>
                      <TD className="text-xs">
                        {r._count.attachments > 0 ? (
                          <Badge tone="info">{r._count.attachments}</Badge>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
