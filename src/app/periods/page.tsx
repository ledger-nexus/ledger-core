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
import { getCurrentUser, isAdmin } from "@/lib/auth/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import PeriodActions from "./period-actions";

export default async function PeriodsPage() {
  // Tenant-verified scope. Closes the cross-tenant read leak the
  // raw lc-scope cookie used to enable.
  const scope = await getCurrentScope();
  const user = await getCurrentUser();
  const admin = isAdmin(user);

  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity to view periods."
      />
    );
  }

  // Entity is already resolved + tenant-verified inside getCurrentScope.
  // Look up by entityId directly to skip the redundant findFirst.
  const [entity, book] = await Promise.all([
    prisma.legalEntity.findUnique({
      where: { id: scope.entityId },
      select: { id: true, code: true, name: true },
    }),
    prisma.book.findUnique({
      where: { code: scope.bookCode },
      select: { id: true, code: true, name: true },
    }),
  ]);

  if (!entity || !book) {
    return (
      <EmptyState
        title="Scope not found"
        description={`Could not resolve entity "${scope.entityCode}" / book "${scope.bookCode}". Switch scope from the sidebar.`}
      />
    );
  }

  // Periods are per-calendar; calendars belong to a tenant. Scope to
  // the resolved tenant so we never cross over into another tenant's
  // fiscal-calendar setup.
  const periods = await prisma.period.findMany({
    where: { tenantId: scope.tenantId },
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
    where: { entityId: entity.id, bookId: book.id },
    select: { periodId: true, closedAt: true, closedBy: true },
  });
  const closeByPeriod = new Map(closes.map((c) => [c.periodId, c]));

  // Per-period JE count so the table previews how much "stuff" each
  // period contains. Cheap aggregate; if it gets slow we can move to
  // a materialized view.
  const jeCounts = await prisma.journalEntry.groupBy({
    by: ["periodId"],
    where: { entityId: entity.id, bookId: book.id, periodId: { not: null } },
    _count: { _all: true },
  });
  const countByPeriod = new Map<string, number>();
  for (const row of jeCounts) {
    if (row.periodId) countByPeriod.set(row.periodId, row._count._all);
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Periods</h1>
        <p className="text-sm text-ink-500">
          Per-(entity, book) close status for every fiscal period. Closing a period
          freezes posting against it; the substrate{" "}
          <code className="font-mono text-xs">postJournalEntry</code> rejects writes
          with{" "}
          <code className="font-mono text-xs">PERIOD_CLOSED</code> for any{" "}
          <strong>(entity, book, period)</strong> in this list with a Closed badge.
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
              description="Run the seed (pnpm db:seed) to create the monthly fiscal calendar."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Period</TH>
                  <TH>Calendar</TH>
                  <TH>Range</TH>
                  <TH>JEs</TH>
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
