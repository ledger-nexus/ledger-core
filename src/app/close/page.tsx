// BlackLine arc — Phase 4 PR 1: cross-pillar close dashboard.
//
// /close is the controller's single landing page during close — three
// rollups side by side (Recons · Tasks · Flux) plus an at-a-glance
// "ready to close?" gate readiness summary.
//
// Pillar columns (each clicks through to its dedicated workflow):
//   - Recons      → /close/reconciliations
//   - Tasks       → /close/tasks
//   - Flux        → /close/flux
//
// The page also surfaces the period-close-gate composition: every
// blocker that would refuse `closePeriodAction` for this (entity, book,
// period) appears in the blockers strip with a deep link. This is the
// "ready to close" view BlackLine sells against the spreadsheet.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import { getReconciliationRollup } from "@/lib/recon/rollup";
import { getCloseTaskRollup, checkRequiredTasksComplete } from "@/lib/close-tasks/rollup";
import { resolveCloseCalendarState } from "@/lib/close-tasks/calendar-state";
import { getFluxRollup } from "@/lib/flux/rollup";
import InstantiateCalendarButton from "./instantiate-calendar-button";

export default async function CloseDashboardPage({
  searchParams,
}: {
  searchParams: { period?: string };
}) {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="Scope not found"
        description="Sign in and select a tenant with at least one entity to view the close dashboard."
      />
    );
  }
  const tenantFilter = { tenantId: scope.tenantId };

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
        description={`Could not resolve entity / book. Switch scope from the sidebar.`}
      />
    );
  }

  // Pick the period — same default logic as the reconciliations list:
  // explicit ?period= wins; otherwise latest OPEN; fall back to latest.
  const allPeriods = await prisma.period.findMany({
    where: { calendar: { entityId: entity.id } },
    orderBy: { startsOn: "desc" },
    select: { id: true, code: true, startsOn: true, endsOn: true },
  });
  if (allPeriods.length === 0) {
    return (
      <EmptyState
        title="No periods seeded"
        description="This entity has no fiscal calendar yet, so there is nothing to close."
      />
    );
  }

  let selectedPeriod = allPeriods[0];
  if (searchParams.period) {
    const match = allPeriods.find((p) => p.code === searchParams.period);
    if (match) selectedPeriod = match;
  } else {
    const closes = await prisma.periodClose.findMany({
      where: { entityId: entity.id, bookId: book.id },
      select: { periodId: true },
    });
    const closedIds = new Set(closes.map((c) => c.periodId));
    const latestOpen = allPeriods.find((p) => !closedIds.has(p.id));
    if (latestOpen) selectedPeriod = latestOpen;
  }

  // Close status for the selected period (entity, book, period scope).
  const close = await prisma.periodClose.findUnique({
    where: {
      entityId_bookId_periodId: {
        entityId: entity.id,
        bookId: book.id,
        periodId: selectedPeriod.id,
      },
    },
    select: { closedAt: true, closedBy: true },
  });
  const isClosed = !!close;

  // ── Three rollups in parallel ────────────────────────────────────────
  // ...plus the two counts the close-task card needs to tell "catalog
  // never seeded" apart from "catalog never instantiated for THIS
  // period". `anyPeriodClose` is period-wide (not scoped to this
  // entity/book) because that's exactly the guard
  // instantiateCalendarForPeriod applies.
  const [
    reconRollup,
    taskRollup,
    fluxRollup,
    taskBlockers,
    templateCount,
    anyPeriodClose,
  ] = await Promise.all([
    getReconciliationRollup(prisma, {
      tenantId: scope.tenantId,
      entityId: entity.id,
      bookId: book.id,
      periodId: selectedPeriod.id,
    }),
    getCloseTaskRollup(prisma, {
      tenantId: scope.tenantId,
      periodId: selectedPeriod.id,
    }),
    getFluxRollup(prisma, {
      tenantId: scope.tenantId,
      entityId: entity.id,
      bookId: book.id,
      toPeriodId: selectedPeriod.id,
    }),
    checkRequiredTasksComplete(prisma, {
      tenantId: scope.tenantId,
      periodId: selectedPeriod.id,
    }),
    prisma.closeTaskTemplate.count({
      where: { ...tenantFilter, active: true },
    }),
    prisma.periodClose.findFirst({
      where: { ...tenantFilter, periodId: selectedPeriod.id },
      select: { id: true },
    }),
  ]);

  const calendarState = resolveCloseCalendarState({
    templateCount,
    taskCount: taskRollup.total,
    periodClosed: !!anyPeriodClose,
  });

  // ── Gate readiness composition ───────────────────────────────────────
  // The period-close gate composes:
  //   1. Task gate (Phase 2 PR 6): requiredForClose tasks terminal
  //   2. Recon-completion gate (Phase 1 PR 8): all material recons signed
  //   3. Flux-signoff (Phase 3): all flux statements FINALIZED with no
  //      pending lines
  const reconReady =
    reconRollup.total === 0 ||
    reconRollup.done === reconRollup.total;
  const tasksReady = taskBlockers.length === 0;
  const fluxReady =
    !fluxRollup || fluxRollup.signedOff;
  const allReady = reconReady && tasksReady && fluxReady;

  // Overdue tasks list (not blocking but worth surfacing on the
  // dashboard).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdueTasks = await prisma.closeTask.findMany({
    where: {
      tenantId: scope.tenantId,
      periodId: selectedPeriod.id,
      dueAt: { lt: today },
      status: { notIn: ["DONE", "WAIVED"] },
    },
    orderBy: { dueAt: "asc" },
    take: 5,
    select: { id: true, name: true, dueAt: true, status: true },
  });

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">Close dashboard</h1>
        <p className="text-sm text-ink-500">
          Three pillars (recons · tasks · flux) side by side. Click any
          card to work that pillar.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Scope: <span className="font-mono">{entity.code}</span> ·{" "}
          <span className="font-mono">{book.code}</span> · Period{" "}
          <span className="font-mono">{selectedPeriod.code}</span> (
          {formatDate(selectedPeriod.startsOn)} →{" "}
          {formatDate(selectedPeriod.endsOn)})
        </p>
      </header>

      {/* Period chips */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-500">Period:</span>
        {allPeriods.slice(0, 12).map((p) => {
          const active = p.id === selectedPeriod.id;
          return (
            <Link
              key={p.id}
              href={`?period=${p.code}`}
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

      {/* "Ready to close?" gate summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {isClosed ? (
              <>
                <Badge tone="positive">Closed</Badge>
                <span className="text-sm font-normal text-ink-700">
                  on {formatDate(close.closedAt)} by{" "}
                  <span className="font-mono">{close.closedBy ?? "—"}</span>
                </span>
              </>
            ) : allReady ? (
              <>
                <Badge tone="positive">Ready to close</Badge>
                <span className="text-sm font-normal text-ink-700">
                  All pillars cleared. Visit{" "}
                  <Link
                    href="/periods"
                    className="text-accent-600 hover:underline"
                  >
                    Periods
                  </Link>{" "}
                  to close.
                </span>
              </>
            ) : (
              <>
                <Badge tone="warning">Open</Badge>
                <span className="text-sm font-normal text-ink-700">
                  Pillars below blocking the close. See blockers strip.
                </span>
              </>
            )}
          </CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-500">
            <span
              className={tasksReady ? "text-positive" : "text-negative"}
            >
              {tasksReady ? "✓" : "✗"} Tasks
              {taskBlockers.length > 0 && ` (${taskBlockers.length} blocking)`}
            </span>
            <span
              className={reconReady ? "text-positive" : "text-negative"}
            >
              {reconReady ? "✓" : "✗"} Recons (
              {reconRollup.done}/{reconRollup.total})
            </span>
            <span
              className={fluxReady ? "text-positive" : "text-negative"}
            >
              {fluxReady ? "✓" : "✗"} Flux
              {fluxRollup
                ? ` (${fluxRollup.signed}/${fluxRollup.material})`
                : " (n/a)"}
            </span>
          </div>
        </CardHeader>
      </Card>

      {/* Pillar rollup cards, side by side on wide screens */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ── Reconciliations ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <Link
                href={`/close/reconciliations?period=${selectedPeriod.code}`}
                className="hover:underline"
              >
                Reconciliations
              </Link>
              <Badge tone={reconReady ? "positive" : "warning"}>
                {reconRollup.pctDone}%
              </Badge>
            </CardTitle>
            <span className="text-xs text-ink-500">
              {reconRollup.total === 0
                ? "Not instantiated yet — open from the list page"
                : `${reconRollup.done} of ${reconRollup.total} signed off`}
            </span>
          </CardHeader>
          <CardContent>
            {reconRollup.total === 0 ? (
              <Link
                href={`/close/reconciliations?period=${selectedPeriod.code}`}
                className="text-sm text-accent-600 hover:underline"
              >
                → Open reconciliations
              </Link>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs">
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Reconciled</span>
                  <span className="text-ink-900">{reconRollup.reconciled}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Prepared (awaiting review)</span>
                  <span className="text-ink-900">{reconRollup.prepared}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Exception</span>
                  <span className={reconRollup.exception > 0 ? "text-negative font-medium" : "text-ink-900"}>
                    {reconRollup.exception}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Open / In progress</span>
                  <span className="text-ink-900">
                    {reconRollup.open + reconRollup.inProgress}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Waived</span>
                  <span className="text-ink-900">{reconRollup.waived}</span>
                </li>
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── Close tasks ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <Link
                href={`/close/tasks?period=${selectedPeriod.code}`}
                className="hover:underline"
              >
                Close tasks
              </Link>
              <Badge tone={tasksReady ? "positive" : "warning"}>
                {taskRollup.pctDone}%
              </Badge>
            </CardTitle>
            <span className="text-xs text-ink-500">
              {calendarState.kind === "NO_TEMPLATES"
                ? "No close-task catalog for this workspace yet"
                : calendarState.kind === "NOT_INSTANTIATED"
                  ? `${calendarState.templateCount} templates ready — no checklist opened for this period`
                  : calendarState.kind === "PERIOD_CLOSED"
                    ? "Period is closed — no checklist was opened for it"
                    : `${taskRollup.done + taskRollup.waived} of ${taskRollup.total} done`}
            </span>
          </CardHeader>
          <CardContent>
            {calendarState.kind === "NO_TEMPLATES" ? (
              <Link
                href="/periods"
                className="text-sm text-accent-600 hover:underline"
              >
                → Seed the close-task catalog on Periods (admin)
              </Link>
            ) : calendarState.kind === "NOT_INSTANTIATED" ? (
              <InstantiateCalendarButton
                periodId={selectedPeriod.id}
                periodCode={selectedPeriod.code}
                templateCount={calendarState.templateCount}
                size="sm"
              />
            ) : calendarState.kind === "PERIOD_CLOSED" ? (
              <p className="text-xs text-ink-500">
                A checklist can only be opened while the period is open.
                Reopen it from{" "}
                <Link
                  href="/periods"
                  className="text-accent-600 hover:underline"
                >
                  Periods
                </Link>{" "}
                first.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs">
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Done</span>
                  <span className="text-ink-900">{taskRollup.done}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">In progress</span>
                  <span className="text-ink-900">{taskRollup.inProgress}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Blocked</span>
                  <span className={taskRollup.blocked > 0 ? "text-negative font-medium" : "text-ink-900"}>
                    {taskRollup.blocked}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Not started</span>
                  <span className="text-ink-900">{taskRollup.notStarted}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Waived</span>
                  <span className="text-ink-900">{taskRollup.waived}</span>
                </li>
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── Flux analysis ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <Link
                href="/close/flux"
                className="hover:underline"
              >
                Flux analysis
              </Link>
              <Badge tone={fluxReady ? "positive" : "warning"}>
                {fluxRollup ? `${Math.round((fluxRollup.signed / Math.max(fluxRollup.material, 1)) * 100)}%` : "n/a"}
              </Badge>
            </CardTitle>
            <span className="text-xs text-ink-500">
              {fluxRollup
                ? `${fluxRollup.signed} of ${fluxRollup.material} material lines signed`
                : "No statement generated for this period"}
            </span>
          </CardHeader>
          <CardContent>
            {!fluxRollup ? (
              <Link
                href="/close/flux"
                className="text-sm text-accent-600 hover:underline"
              >
                → Generate flux statement
              </Link>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs">
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Explained</span>
                  <span className="text-ink-900">{fluxRollup.explained}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Waived</span>
                  <span className="text-ink-900">{fluxRollup.waived}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Pending</span>
                  <span className={fluxRollup.needsComment > 0 ? "text-negative font-medium" : "text-ink-900"}>
                    {fluxRollup.needsComment}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-500">Immaterial</span>
                  <span className="text-ink-900">{fluxRollup.immaterial}</span>
                </li>
                <li className="flex items-center justify-between border-t border-ink-100 pt-1.5">
                  <span className="text-ink-500">Statement</span>
                  <span className="text-ink-900">{fluxRollup.status}</span>
                </li>
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Blockers strip — what needs to happen before close fires */}
      {!isClosed && !allReady && (
        <Card>
          <CardHeader>
            <CardTitle>Blockers</CardTitle>
            <span className="text-xs text-ink-500">
              The period-close action will refuse until these clear
            </span>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {!tasksReady && (
                <li>
                  <Link
                    href={`/close/tasks?period=${selectedPeriod.code}&status=NOT_STARTED`}
                    className="text-negative hover:underline"
                  >
                    ✗ {taskBlockers.length} required close task
                    {taskBlockers.length === 1 ? "" : "s"} not yet terminal:{" "}
                    {taskBlockers
                      .slice(0, 3)
                      .map((b) => b.name)
                      .join(", ")}
                    {taskBlockers.length > 3 && ", ..."}
                  </Link>
                </li>
              )}
              {!reconReady && (
                <li>
                  <Link
                    href={`/close/reconciliations?period=${selectedPeriod.code}&status=EXCEPTION`}
                    className="text-negative hover:underline"
                  >
                    ✗ {reconRollup.total - reconRollup.done} reconciliation
                    {reconRollup.total - reconRollup.done === 1 ? "" : "s"} not signed off
                    {reconRollup.exception > 0 &&
                      ` (${reconRollup.exception} EXCEPTION)`}
                  </Link>
                </li>
              )}
              {!fluxReady && fluxRollup && (
                <li>
                  <Link
                    href={`/close/flux/${fluxRollup.statementId}`}
                    className="text-negative hover:underline"
                  >
                    ✗ Flux statement{" "}
                    {fluxRollup.status === "FINALIZED"
                      ? "missing commentary"
                      : "not finalized"}
                    {fluxRollup.needsComment > 0 &&
                      ` — ${fluxRollup.needsComment} material line${fluxRollup.needsComment === 1 ? "" : "s"} pending`}
                  </Link>
                </li>
              )}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Overdue tasks — non-blocking but worth highlighting */}
      {overdueTasks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Overdue tasks</CardTitle>
            <span className="text-xs text-ink-500">
              Past due-date and not yet terminal — top {overdueTasks.length}
            </span>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {overdueTasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between">
                  <Link
                    href={`/close/tasks/${t.id}`}
                    className="text-ink-900 hover:underline"
                  >
                    {t.name}
                  </Link>
                  <span className="text-xs text-negative">
                    due {t.dueAt ? formatDate(t.dueAt) : "—"} · {t.status}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
