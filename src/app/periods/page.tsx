// Periods page — list every fiscal period for the active scope's
// calendar, with per-(entity, book) close status. Admin users see
// Close / Reopen buttons; non-admins see the status only.
//
// Multi-book is on display here: the (entity, book) tuple from the
// scope cookie drives which PeriodClose rows we look up. Switching
// scope reloads the close-status column without changing the period
// list (the same fiscal calendar applies across books for a given
// entity by convention; future work may decouple them).

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getViewerRole } from "@/lib/auth/authorize";
import { canClosePeriods } from "@/lib/auth/policy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import PeriodActions from "./period-actions";
import SeedTemplatesButton from "./seed-templates-button";

export default async function PeriodsPage() {
  // Tenant-verified scope. Raw getScope() would let a hand-edited
  // lc-scope cookie name another tenant's entity code; getCurrentScope()
  // resolves it against THIS tenant's entities and pre-resolves
  // entityId + tenantId, so every query below is tenant-pinned.
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before viewing periods."
      />
    );
  }
  const admin = canClosePeriods(await getViewerRole());

  // Resolve the entity by its tenant-verified id (for its display name).
  const entity = await prisma.legalEntity.findUnique({
    where: { id: scope.entityId },
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

  // Periods for THIS entity's calendar(s). This previously had NO where
  // clause — it loaded every period across every tenant (a cross-tenant
  // leak). Scope it to the tenant + the resolved entity's calendars. In
  // v1 a company typically has ONE calendar (monthly 12-period). Sorted
  // startsOn DESC so the most recent month is on top.
  const periods = await prisma.period.findMany({
    where: {
      tenantId: scope.tenantId,
      calendar: { entityId: scope.entityId },
    },
    orderBy: { startsOn: "desc" },
    select: {
      id: true,
      code: true,
      ordinal: true,
      startsOn: true,
      endsOn: true,
      calendar: { select: { code: true } },
    },
  });

  // Per (entity, book) close rows. Map by periodId for O(1) lookup
  // when rendering the table.
  const closes = await prisma.periodClose.findMany({
    where: { tenantId: scope.tenantId, entityId: entity.id, bookId: book.id },
    select: { periodId: true, closedAt: true, closedBy: true },
  });
  const closeByPeriod = new Map(closes.map((c) => [c.periodId, c]));

  // Per-period JE count so the table previews how much "stuff" each
  // period contains. Cheap aggregate; if it gets slow we can move to
  // a materialized view.
  const jeCounts = await prisma.journalEntry.groupBy({
    by: ["periodId"],
    where: {
      tenantId: scope.tenantId,
      entityId: entity.id,
      bookId: book.id,
      periodId: { not: null },
    },
    _count: { _all: true },
  });
  const countByPeriod = new Map<string, number>();
  for (const row of jeCounts) {
    if (row.periodId) countByPeriod.set(row.periodId, row._count._all);
  }

  // BlackLine arc Phase 2 PR 6 — close-task rollup per period. Tasks
  // are tenant-scoped (no entity/book), so we groupBy(status) by
  // periodId and aggregate in JS for the visible periods. One query
  // for all periods instead of N per-period queries.
  type TaskRollup = { total: number; done: number; pctDone: number };
  const taskRollupByPeriod = new Map<string, TaskRollup>();
  let templateCount = 0;
  {
    const visiblePeriodIds = periods.map((p) => p.id);
    if (visiblePeriodIds.length > 0) {
      const rows = await prisma.closeTask.groupBy({
        by: ["periodId", "status"],
        where: {
          tenantId: scope.tenantId,
          periodId: { in: visiblePeriodIds },
        },
        _count: { _all: true },
      });
      // Build per-period totals + terminal counts.
      const tally = new Map<string, { total: number; terminal: number }>();
      for (const r of rows) {
        const cur = tally.get(r.periodId) ?? { total: 0, terminal: 0 };
        cur.total += r._count._all;
        if (r.status === "DONE" || r.status === "WAIVED") {
          cur.terminal += r._count._all;
        }
        tally.set(r.periodId, cur);
      }
      for (const [pid, t] of tally) {
        const pct = t.total === 0 ? 0 : Math.round((t.terminal / t.total) * 100);
        taskRollupByPeriod.set(pid, {
          total: t.total,
          done: t.terminal,
          pctDone: pct,
        });
      }
    }
    // Surface "no templates seeded yet" so the operator sees the
    // first-run affordance.
    templateCount = await prisma.closeTaskTemplate.count({
      where: { tenantId: scope.tenantId, active: true },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {admin && templateCount === 0 && (
        <Card>
          <CardContent className="flex items-center justify-between gap-4">
            <div className="text-sm text-ink-700">
              <strong>First-run setup:</strong> seed the BlackLine-standard
              close-task catalog (50 templates across 9 categories) so the
              periods below can be instantiated with a checklist.
            </div>
            <SeedTemplatesButton />
          </CardContent>
        </Card>
      )}
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Periods</h1>
        <p className="text-sm text-ink-500">
          Close status for every fiscal period. Closing a period freezes it — any
          entry dated into a period marked <strong>Closed</strong> will be
          rejected. Closing is reversible by an admin.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Scope: <span className="font-mono">{entity.code}</span> ·{" "}
          <span className="font-mono">{book.code}</span> ({book.name})
          {admin ? null : (
            <>
              {" "}
              · <span className="text-amber-600">read-only (admin required to close)</span>
            </>
          )}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>
            {periods.length} period{periods.length === 1 ? "" : "s"}
          </CardTitle>
          <span className="text-xs text-ink-500">
            Newest first · close status scoped to {entity.code} / {book.code}
          </span>
        </CardHeader>
        <CardContent className={periods.length === 0 ? "" : "p-0"}>
          {periods.length === 0 ? (
            <EmptyState
              title="No periods seeded"
              description="This entity has no fiscal calendar yet, so there are no periods to open or close."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Period</TH>
                  <TH>Calendar</TH>
                  <TH>Range</TH>
                  <TH>JEs</TH>
                  <TH>Tasks</TH>
                  <TH>Status</TH>
                  <TH>Closed by</TH>
                  <TH>Closed at</TH>
                  <TH>Packet</TH>
                  {admin ? <TH>Action</TH> : null}
                </tr>
              </THead>
              <TBody>
                {periods.map((p) => {
                  const close = closeByPeriod.get(p.id);
                  const isClosed = !!close;
                  const jeCount = countByPeriod.get(p.id) ?? 0;
                  return (
                    <TR key={p.id}>
                      <TD className="font-mono text-xs text-ink-900">{p.code}</TD>
                      <TD className="font-mono text-xs text-ink-600">
                        {p.calendar.code}
                      </TD>
                      <TD className="text-xs text-ink-600">
                        {formatDate(p.startsOn)} → {formatDate(p.endsOn)}
                      </TD>
                      <TD className="text-xs text-ink-700">
                        {jeCount > 0 ? (
                          <Link
                            href={`/journal-entries?periodCode=${p.code}`}
                            className="text-accent-600 hover:underline"
                          >
                            {jeCount}
                          </Link>
                        ) : (
                          <span className="text-ink-400">0</span>
                        )}
                      </TD>
                      <TD className="text-xs">
                        {(() => {
                          const r = taskRollupByPeriod.get(p.id);
                          if (!r || r.total === 0) {
                            return <span className="text-ink-400">—</span>;
                          }
                          const allDone = r.done === r.total;
                          return (
                            <Link
                              href={`/close/tasks?period=${p.code}`}
                              className="hover:underline"
                            >
                              <Badge tone={allDone ? "positive" : "warning"}>
                                {r.done}/{r.total} · {r.pctDone}%
                              </Badge>
                            </Link>
                          );
                        })()}
                      </TD>
                      <TD>
                        {isClosed ? (
                          <Badge tone="negative">Closed</Badge>
                        ) : (
                          <Badge tone="positive">Open</Badge>
                        )}
                      </TD>
                      <TD className="font-mono text-xs text-ink-600">
                        {close?.closedBy ?? "—"}
                      </TD>
                      <TD className="text-xs text-ink-500">
                        {close ? formatDate(close.closedAt) : "—"}
                      </TD>
                      <TD className="text-xs">
                        {jeCount > 0 ? (
                          <span className="flex items-center gap-2">
                            <Link
                              href={`/api/reports/month-end/csv?period=${p.code}`}
                              className="text-accent-600 hover:underline"
                            >
                              CSV
                            </Link>
                            <Link
                              href={`/api/reports/month-end/pdf?period=${p.code}`}
                              className="text-accent-600 hover:underline"
                            >
                              PDF
                            </Link>
                            <Link
                              href={`/reports/month-end?period=${p.code}`}
                              className="text-ink-400 hover:text-accent-600"
                              title="Open month-end review"
                            >
                              ↗
                            </Link>
                          </span>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </TD>
                      {admin ? (
                        <TD>
                          <PeriodActions
                            entityCode={entity.code}
                            bookCode={book.code}
                            periodCode={p.code}
                            isClosed={isClosed}
                          />
                        </TD>
                      ) : null}
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
