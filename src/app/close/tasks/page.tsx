// BlackLine arc — Phase 2 PR 3: Close Task list page.
//
// /close/tasks is the controller's "what's left to do" landing page
// during close. Mirrors BlackLine's calendar UX: tasks grouped by
// status (urgency-first), filter pills for category, "my tasks"
// toggle, overdue badge on rows whose dueAt < today.
//
// Layout (top to bottom):
//   - Header + period chips (top 12)
//   - Filter strip: category pills (9 buckets), "my tasks" toggle,
//     status filter, per-status histogram + progress
//   - Status sections (grouped by urgency):
//       1. BLOCKED      — top priority; someone needs eyes
//       2. IN_PROGRESS  — in flight
//       3. NOT_STARTED  — backlog
//       4. DONE         — terminal (collapsed to N count chip by default)
//       5. WAIVED       — terminal (chip)
//
// Each row: name + category badge · status · owner · due ·
// dependsOn count · evidence indicator. Click-through to detail page
// (PR 4).
//
// URL params:
//   ?period=YYYY-MM       — period code; default = latest OPEN
//   ?category=ACCRUAL     — filter to one category
//   ?status=BLOCKED       — filter to one status
//   ?mine=1               — only tasks where ownerId = current user
//
// Multi-tenant: tenant-scoped via getCurrentTenant + tenantId filter.
//
// A period with no tasks yet gets the instantiate CTA on the empty
// state — that's the entry point to instantiateCalendarForPeriod, which
// turns the tenant's template catalog into this period's checklist.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getCurrentScope } from "@/lib/scope";
import { tenantScopeOrNone } from "@/lib/db-sentinels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import { resolveCloseCalendarState } from "@/lib/close-tasks/calendar-state";
import InstantiateCalendarButton from "../instantiate-calendar-button";
import type { CloseTaskStatus, CloseTaskCategory } from "@prisma/client";

// Status tone — single source of truth shared with the detail page and
// progress widgets so the kanban and individual rows render the same
// colors.
const STATUS_TONES: Record<
  CloseTaskStatus,
  "neutral" | "positive" | "negative" | "warning" | "info"
> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "info",
  BLOCKED: "negative",
  DONE: "positive",
  WAIVED: "neutral",
};

const ALL_STATUSES: CloseTaskStatus[] = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
  "WAIVED",
];

const ALL_CATEGORIES: CloseTaskCategory[] = [
  "ACCRUAL",
  "RECON",
  "DEPRECIATION",
  "FX",
  "REVENUE",
  "INVENTORY",
  "TAX",
  "REPORTING",
  "ADMIN",
];

// Urgency-descending order for the grouped sections. BLOCKED at top so
// the controller's eye lands on what needs unblocking.
const SECTION_ORDER: CloseTaskStatus[] = [
  "BLOCKED",
  "IN_PROGRESS",
  "NOT_STARTED",
  "DONE",
  "WAIVED",
];

export default async function CloseTasksListPage({
  searchParams,
}: {
  searchParams: {
    period?: string;
    category?: string;
    status?: string;
    mine?: string;
  };
}) {
  const user = await getCurrentUser();
  const tenant = await getCurrentTenant();
  const tenantFilter = tenantScopeOrNone(tenant?.id);

  // Pull periods — the tasks page is tenant-wide (no entity/book
  // scoping at the list level; tasks have nullable entity/book per
  // schema). Period defaults to the latest open period across all
  // (entity, book) tuples for the tenant.
  const allPeriods = await prisma.period.findMany({
    where: { ...tenantFilter },
    // `id` breaks ties between the N same-code rows one per entity
    // calendar produces — without it Postgres may return them in any
    // order and the "which 2026-12?" pick would drift between requests.
    orderBy: [{ startsOn: "desc" }, { id: "asc" }],
    select: {
      id: true,
      code: true,
      startsOn: true,
      endsOn: true,
      calendar: { select: { entityId: true } },
    },
  });

  if (allPeriods.length === 0) {
    return (
      <EmptyState
        title="No periods seeded"
        description="This entity has no fiscal calendar yet, so close tasks cannot be scheduled."
      />
    );
  }

  // A Period belongs to exactly ONE entity's fiscal calendar, so a
  // tenant with N entities has N distinct rows sharing each code —
  // "2026-12" is 12 different rows here, not one. `?period=<code>` is
  // therefore ambiguous, and picking the first match by insertion order
  // meant a click-through from /close (which scopes periods to the
  // viewer's entity) could land on ANOTHER entity's identically-coded
  // period: the list showed the wrong period's tasks, and the
  // instantiate CTA would have opened a checklist against it. Resolve
  // to the current scope's entity when it has a row with that code.
  const scope = await getCurrentScope();
  const scopedEntityId = scope?.entityId ?? null;
  function preferScoped<T extends { calendar: { entityId: string } | null }>(
    candidates: T[]
  ): T | undefined {
    if (scopedEntityId) {
      const scoped = candidates.find(
        (p) => p.calendar?.entityId === scopedEntityId
      );
      if (scoped) return scoped;
    }
    return candidates[0];
  }

  // One chip per CODE — deduped the same way, so the chip a user clicks
  // resolves to the same row the chip was built from.
  const periodChips: typeof allPeriods = [];
  const seenCodes = new Set<string>();
  for (const p of allPeriods) {
    if (seenCodes.has(p.code)) continue;
    seenCodes.add(p.code);
    const chosen = preferScoped(allPeriods.filter((q) => q.code === p.code));
    if (chosen) periodChips.push(chosen);
  }

  let selectedPeriod = periodChips[0];
  if (searchParams.period) {
    const match = preferScoped(
      allPeriods.filter((p) => p.code === searchParams.period)
    );
    if (!match) {
      return (
        <EmptyState
          title={`Period "${searchParams.period}" not found`}
          description="No fiscal period with that code for this tenant."
        />
      );
    }
    selectedPeriod = match;
  } else {
    // Latest period with at least one open task (preferred); fallback
    // to the latest period overall.
    const latestWithOpen = await prisma.closeTask.findFirst({
      where: {
        ...tenantFilter,
        status: { not: { in: ["DONE", "WAIVED"] } },
      },
      orderBy: { period: { startsOn: "desc" } },
      select: {
        period: {
          select: {
            id: true,
            code: true,
            startsOn: true,
            endsOn: true,
            calendar: { select: { entityId: true } },
          },
        },
      },
    });
    if (latestWithOpen?.period) selectedPeriod = latestWithOpen.period;
  }

  // Filters.
  const categoryFilter =
    searchParams.category &&
    (ALL_CATEGORIES as string[]).includes(searchParams.category)
      ? (searchParams.category as CloseTaskCategory)
      : null;
  const statusFilter =
    searchParams.status &&
    (ALL_STATUSES as string[]).includes(searchParams.status)
      ? (searchParams.status as CloseTaskStatus)
      : null;
  const mineOnly = searchParams.mine === "1";

  const tasks = await prisma.closeTask.findMany({
    where: {
      ...tenantFilter,
      periodId: selectedPeriod.id,
      ...(categoryFilter ? { category: categoryFilter } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(mineOnly && user ? { ownerId: user.id } : {}),
    },
    select: {
      id: true,
      name: true,
      category: true,
      status: true,
      requiredForClose: true,
      dueAt: true,
      ownerId: true,
      ownerType: true,
      dependsOnIds: true,
      completedAt: true,
      evidenceUrl: true,
      // Owner display — resolve when ownerType=USER.
      owner: { select: { displayName: true } },
      _count: { select: { comments: true } },
    },
    orderBy: [{ dueAt: "asc" }, { name: "asc" }],
  });

  // Calendar readiness for the empty state. `periodTaskCount` is the
  // UNFILTERED count for the period — the filtered `tasks.length` below
  // can be zero simply because the operator picked a category, which is
  // a different empty state than "this period was never instantiated".
  const [templateCount, periodTaskCount, anyPeriodClose] = await Promise.all([
    prisma.closeTaskTemplate.count({
      where: { ...tenantFilter, active: true },
    }),
    categoryFilter || statusFilter || mineOnly
      ? prisma.closeTask.count({
          where: { ...tenantFilter, periodId: selectedPeriod.id },
        })
      : Promise.resolve(null), // unfiltered — tasks.length already is it
    prisma.periodClose.findFirst({
      where: { ...tenantFilter, periodId: selectedPeriod.id },
      select: { id: true },
    }),
  ]);

  // Rollup the histogram + progress in-page (groupBy would be one more
  // round-trip when tasks is already in memory).
  const histogram: Record<CloseTaskStatus, number> = {
    NOT_STARTED: 0,
    IN_PROGRESS: 0,
    BLOCKED: 0,
    DONE: 0,
    WAIVED: 0,
  };
  for (const t of tasks) histogram[t.status]++;
  const total = tasks.length;
  const done = histogram.DONE + histogram.WAIVED;
  const pctDone = total === 0 ? 0 : Math.round((done / total) * 100);

  const calendarState = resolveCloseCalendarState({
    templateCount,
    taskCount: periodTaskCount ?? total,
    periodClosed: !!anyPeriodClose,
  });

  // Group tasks by status for the swimlanes.
  const tasksByStatus: Record<CloseTaskStatus, typeof tasks> = {
    NOT_STARTED: [],
    IN_PROGRESS: [],
    BLOCKED: [],
    DONE: [],
    WAIVED: [],
  };
  for (const t of tasks) tasksByStatus[t.status].push(t);

  // Today's date for the overdue check. Server-side date is fine; the
  // user's wall clock can differ by a few hours but "overdue" granularity
  // is days, not minutes.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  function isOverdue(
    dueAt: Date | null,
    status: CloseTaskStatus
  ): boolean {
    if (!dueAt) return false;
    if (status === "DONE" || status === "WAIVED") return false;
    return dueAt < today;
  }

  function urlWith(overrides: {
    period?: string;
    category?: string | null;
    status?: string | null;
    mine?: boolean | null;
  }): string {
    const p = new URLSearchParams();
    p.set("period", overrides.period ?? selectedPeriod.code);
    const cat = overrides.category !== undefined ? overrides.category : categoryFilter;
    if (cat) p.set("category", cat);
    const stat = overrides.status !== undefined ? overrides.status : statusFilter;
    if (stat) p.set("status", stat);
    const m = overrides.mine !== undefined ? overrides.mine : mineOnly;
    if (m) p.set("mine", "1");
    return `?${p.toString()}`;
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">Close tasks</h1>
        <p className="text-sm text-ink-500">
          The controller's checklist for this period. Blocked tasks
          surface first; dependencies enforce order.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Period: <span className="font-mono">{selectedPeriod.code}</span> (
          {formatDate(selectedPeriod.startsOn)} → {formatDate(selectedPeriod.endsOn)})
        </p>
      </header>

      {/* Period switcher chips */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-500">Period:</span>
        {periodChips.slice(0, 12).map((p) => {
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

      {/* Filter strip: My tasks · category pills · status counts · CSV */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Link
          href={urlWith({ mine: !mineOnly })}
          className={
            mineOnly
              ? "rounded-full bg-ink-900 px-2.5 py-0.5 font-medium text-white"
              : "rounded-full bg-ink-100 px-2.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200"
          }
        >
          {mineOnly ? "✓ My tasks" : "My tasks"}
        </Link>
        <span className="text-ink-300">·</span>
        <Link
          href={urlWith({ category: null })}
          className={
            !categoryFilter
              ? "rounded-full bg-ink-900 px-2.5 py-0.5 font-medium text-white"
              : "rounded-full bg-ink-100 px-2.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200"
          }
        >
          All
        </Link>
        {ALL_CATEGORIES.map((cat) => (
          <Link
            key={cat}
            href={urlWith({ category: cat })}
            className={
              categoryFilter === cat
                ? "rounded-full bg-ink-900 px-2.5 py-0.5 font-medium text-white"
                : "rounded-full bg-ink-100 px-2.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200"
            }
          >
            {cat}
          </Link>
        ))}
        <span className="ml-auto text-ink-500">
          {done} / {total} done · {pctDone}%
        </span>
      </div>

      {/* Empty state. Three distinct reasons the list can be blank, and
          they need different exits: the filters hide everything, the
          workspace has no template catalog, or the catalog was never
          instantiated for this period (the common one — that's the CTA). */}
      {total === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3">
            {calendarState.kind === "INSTANTIATED" ? (
              <EmptyState
                title="No tasks match these filters"
                description="This period has a checklist — the current filters just exclude every row. Try clearing them."
                className="w-full"
              />
            ) : calendarState.kind === "NO_TEMPLATES" ? (
              <EmptyState
                title="No close-task catalog yet"
                description="Close tasks come from a workspace-wide template catalog. A workspace admin seeds it once, then each period's checklist is opened from it."
                action={{ href: "/periods", label: "Seed the catalog on Periods" }}
                className="w-full"
              />
            ) : calendarState.kind === "PERIOD_CLOSED" ? (
              <EmptyState
                title={`${selectedPeriod.code} is closed`}
                description="No checklist was opened for this period before it closed, and a closed period can't take one. Reopen the period first if you need it."
                action={{ href: "/periods", label: "Go to Periods" }}
                className="w-full"
              />
            ) : (
              <>
                <EmptyState
                  title="No checklist opened for this period yet"
                  description={`The workspace has ${calendarState.templateCount} close-task template${calendarState.templateCount === 1 ? "" : "s"}. Open the checklist to create this period's tasks, with due dates and dependencies carried over from the catalog.`}
                  className="w-full"
                />
                <InstantiateCalendarButton
                  periodId={selectedPeriod.id}
                  periodCode={selectedPeriod.code}
                  templateCount={calendarState.templateCount}
                />
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Status sections — urgency-descending. Hidden sections
              collapse to zero-height; SECTION_ORDER controls render
              order so BLOCKED is always at the top. */}
          {SECTION_ORDER.map((sectionStatus) => {
            const rows = tasksByStatus[sectionStatus];
            if (rows.length === 0) return null;
            return (
              <Card key={sectionStatus}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge tone={STATUS_TONES[sectionStatus]}>
                      {sectionStatus}
                    </Badge>
                    <span className="text-sm font-normal text-ink-700">
                      {rows.length} task{rows.length === 1 ? "" : "s"}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <THead>
                      <tr>
                        <TH>Task</TH>
                        <TH>Category</TH>
                        <TH>Owner</TH>
                        <TH>Due</TH>
                        <TH>Deps</TH>
                        <TH>Evidence</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {rows.map((t) => {
                        const overdue = isOverdue(t.dueAt, t.status);
                        return (
                          <TR key={t.id}>
                            <TD>
                              <Link
                                href={`/close/tasks/${t.id}`}
                                className="text-ink-900 hover:underline"
                              >
                                {t.name}
                              </Link>
                              {!t.requiredForClose && (
                                <Badge tone="neutral" className="ml-2" title="Optional — does not block period close">
                                  optional
                                </Badge>
                              )}
                              {t._count.comments > 0 && (
                                <Badge tone="info" className="ml-1.5">
                                  {t._count.comments} comment
                                  {t._count.comments === 1 ? "" : "s"}
                                </Badge>
                              )}
                            </TD>
                            <TD>
                              <Badge tone="neutral">{t.category}</Badge>
                            </TD>
                            <TD className="text-xs">
                              {t.ownerType === "QUEUE" ? (
                                <span className="text-ink-700">
                                  queue · {t.ownerId?.slice(0, 8) ?? "—"}
                                </span>
                              ) : t.owner?.displayName ? (
                                <span className="text-ink-700">
                                  {t.owner.displayName}
                                </span>
                              ) : (
                                <span className="text-ink-500">—</span>
                              )}
                            </TD>
                            <TD className="text-xs">
                              {t.dueAt ? (
                                <span
                                  className={
                                    overdue
                                      ? "text-red-700 font-medium"
                                      : "text-ink-700"
                                  }
                                >
                                  {formatDate(t.dueAt)}
                                  {overdue && (
                                    <span className="ml-1 text-[11px] uppercase tracking-wide">
                                      overdue
                                    </span>
                                  )}
                                </span>
                              ) : (
                                <span className="text-ink-500">—</span>
                              )}
                            </TD>
                            <TD className="text-xs">
                              {t.dependsOnIds.length > 0 ? (
                                <Badge tone="warning">
                                  {t.dependsOnIds.length}
                                </Badge>
                              ) : (
                                <span className="text-ink-500">—</span>
                              )}
                            </TD>
                            <TD className="text-xs">
                              {t.evidenceUrl ? (
                                <a
                                  href={t.evidenceUrl}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="text-accent-600 hover:underline"
                                >
                                  link
                                </a>
                              ) : (
                                <span className="text-ink-500">—</span>
                              )}
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </CardContent>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
