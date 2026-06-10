// BlackLine arc — Phase 4 PR 3: close-process retrospective metrics.
//
// `getCloseRetrospective(prisma, scope, lookbackPeriods=12)` returns
// the four signals controllers care about most when running a
// close-process improvement loop:
//
//   1. daysToCloseTrend — for each closed period in the window, how
//      many calendar days from period.endsOn → PeriodClose.closedAt.
//      Includes a SLA target (default close-day +5) and a per-period
//      `metTarget` flag so the controller can see at a glance which
//      months slipped.
//
//   2. avgTaskLeadTime — by category, average time from task
//      instantiation (createdAt) → DONE (completedAt). DEPRECIATION
//      and ACCRUAL tend to be fast; REPORTING and TAX tend to be
//      slow. Surfacing the average exposes where the bottleneck is.
//
//   3. exceptionRateTrend — per period: recon EXCEPTION count /
//      total recons. The headline number for "how clean are our
//      tie-outs". Trend down = process improving.
//
//   4. recurringBlockers — top close-task templates by EVER-BLOCKED
//      count across the lookback window. Uses the state-change log
//      (migration 0011) to capture tasks that hit BLOCKED at any
//      point — including those that were since unblocked. These
//      are the upstream dependency problems eating the most close
//      cycles — candidates for permanent process fixes (e.g.
//      "always wait on the auditor → escalate to weekly status").
//
// All math is read-only; no mutations. Sub-second runtime because the
// scope tuple lets us hit just the indices on (entity, book, period).
//
// SOC 2 CC6.1: every query carries tenantId + entityId + bookId.
// Cross-tenant retrospective is impossible.

import type { Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface RetrospectiveScope {
  tenantId: string;
  entityId: string;
  bookId: string;
}

export interface DaysToClosePoint {
  periodId: string;
  periodCode: string;
  endsOn: Date;
  closedAt: Date;
  daysToClose: number; // floor((closedAt - endsOn) / day)
  metTarget: boolean; // daysToClose <= targetDays
}

export interface TaskLeadTimeByCategory {
  category: string;
  avgLeadDays: number; // float, two decimals upstream
  sampleSize: number; // number of DONE tasks in window
}

export interface ExceptionRatePoint {
  periodId: string;
  periodCode: string;
  totalRecons: number;
  exceptionCount: number;
  rate: number; // exceptionCount / totalRecons, 0 if no recons
}

export interface RecurringBlocker {
  templateKey: string | null;
  name: string; // task.name (templateKey is null for ad-hoc; we still bucket by name)
  blockedCount: number; // distinct close-task rows that hit BLOCKED in window
  totalCount: number; // total instantiations in window
  blockRate: number; // blockedCount / totalCount
}

export interface RetrospectiveSummary {
  windowPeriods: number; // requested lookback
  closedPeriodCount: number; // periods actually closed in window
  avgDaysToClose: number | null; // null if no closed periods
  pctMetTarget: number | null; // null if no closed periods, else 0..1
  avgExceptionRate: number | null; // null if no recons in window
  totalTasksCompleted: number;
  totalReconsCompleted: number;
}

export interface CloseRetrospective {
  scope: RetrospectiveScope;
  targetDays: number; // SLA threshold used for metTarget
  summary: RetrospectiveSummary;
  daysToCloseTrend: DaysToClosePoint[]; // oldest → newest
  taskLeadTime: TaskLeadTimeByCategory[]; // sorted by avg desc
  exceptionRateTrend: ExceptionRatePoint[]; // oldest → newest
  recurringBlockers: RecurringBlocker[]; // top N by blockedCount desc
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Builds the retrospective rollup for an (entity, book) scope across
 * the last N periods (calendar-ordered, newest first; output trends
 * are flipped to oldest-first for charting convenience).
 *
 * `targetDays` is the close-day SLA — default 5 calendar days from
 * period end, the BlackLine F1000 baseline. Override for tenants with
 * a faster or slower cadence.
 */
export async function getCloseRetrospective(
  prisma: DbClient,
  scope: RetrospectiveScope,
  lookbackPeriods: number = 12,
  targetDays: number = 5
): Promise<CloseRetrospective> {
  // 1. Resolve the window: last N periods by startsOn DESC for this
  //    (entity) — we don't filter by book here because Period is
  //    entity-scoped; PeriodClose is the (entity, book) filter.
  const periods = await prisma.period.findMany({
    where: {
      tenantId: scope.tenantId,
      calendar: { entityId: scope.entityId },
    },
    orderBy: { startsOn: "desc" },
    take: lookbackPeriods,
    select: { id: true, code: true, startsOn: true, endsOn: true },
  });
  const periodIds = periods.map((p) => p.id);

  // 2. Days-to-close trend: only periods that were actually closed
  //    against this (entity, book) tuple appear. Open periods are
  //    excluded — they have no closedAt yet.
  const closes = await prisma.periodClose.findMany({
    where: {
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      bookId: scope.bookId,
      periodId: { in: periodIds },
    },
    select: { periodId: true, closedAt: true },
  });
  const closeByPeriod = new Map<string, Date>();
  for (const c of closes) closeByPeriod.set(c.periodId, c.closedAt);

  const daysToCloseTrend: DaysToClosePoint[] = [];
  for (const p of periods) {
    const closedAt = closeByPeriod.get(p.id);
    if (!closedAt) continue;
    const dtc = daysBetween(p.endsOn, closedAt);
    daysToCloseTrend.push({
      periodId: p.id,
      periodCode: p.code,
      endsOn: p.endsOn,
      closedAt,
      daysToClose: dtc,
      metTarget: dtc <= targetDays,
    });
  }
  // Flip to oldest-first for chart rendering.
  daysToCloseTrend.reverse();

  // 3. Task lead time by category: average over DONE tasks in window.
  //    completedAt − createdAt, in days. Tasks with no completedAt
  //    (still in flight) are excluded by status filter.
  const doneTasks = await prisma.closeTask.findMany({
    where: {
      tenantId: scope.tenantId,
      periodId: { in: periodIds },
      status: "DONE",
      completedAt: { not: null },
    },
    select: {
      category: true,
      createdAt: true,
      completedAt: true,
    },
  });
  const byCategory = new Map<string, { sumDays: number; n: number }>();
  for (const t of doneTasks) {
    if (!t.completedAt) continue;
    const leadDays = Math.max(0, daysBetween(t.createdAt, t.completedAt));
    const bucket = byCategory.get(t.category) ?? { sumDays: 0, n: 0 };
    bucket.sumDays += leadDays;
    bucket.n += 1;
    byCategory.set(t.category, bucket);
  }
  const taskLeadTime: TaskLeadTimeByCategory[] = Array.from(byCategory.entries())
    .map(([category, { sumDays, n }]) => ({
      category,
      avgLeadDays: n === 0 ? 0 : sumDays / n,
      sampleSize: n,
    }))
    .sort((a, b) => b.avgLeadDays - a.avgLeadDays); // worst → best

  // 4. Exception-rate trend: for each period (whether closed or not),
  //    count recons + count EXCEPTION/terminal-with-exception.
  //    Treating WAIVED as not-an-exception (it's an intentional
  //    disposition), and counting CURRENT status — historical
  //    state changes aren't tracked at the row level.
  const reconCounts = await prisma.reconciliation.groupBy({
    by: ["periodId", "status"],
    where: {
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      bookId: scope.bookId,
      periodId: { in: periodIds },
    },
    _count: { _all: true },
  });
  const totalByPeriod = new Map<string, number>();
  const exceptionByPeriod = new Map<string, number>();
  for (const row of reconCounts) {
    const total = totalByPeriod.get(row.periodId) ?? 0;
    totalByPeriod.set(row.periodId, total + row._count._all);
    if (row.status === "EXCEPTION") {
      const ex = exceptionByPeriod.get(row.periodId) ?? 0;
      exceptionByPeriod.set(row.periodId, ex + row._count._all);
    }
  }
  const exceptionRateTrend: ExceptionRatePoint[] = [];
  for (const p of periods) {
    const total = totalByPeriod.get(p.id) ?? 0;
    const ex = exceptionByPeriod.get(p.id) ?? 0;
    exceptionRateTrend.push({
      periodId: p.id,
      periodCode: p.code,
      totalRecons: total,
      exceptionCount: ex,
      rate: total === 0 ? 0 : ex / total,
    });
  }
  exceptionRateTrend.reverse(); // oldest → newest

  // 5. Recurring blockers: HISTORICAL count via the state-change log
  //    (migration 0011). `blockedCount` is the number of distinct
  //    in-window tasks per template that EVER hit BLOCKED — not the
  //    number currently in BLOCKED status. This catches the cohort
  //    that hit a blocker mid-period and then got unblocked, which
  //    is the actual signal for "this step keeps causing friction."
  //
  //    Two-query strategy:
  //      a. pull all tasks in window for total + name + templateKey
  //      b. pull all state-change rows with toStatus=BLOCKED for
  //         those task ids; build a set of EVER-blocked task ids
  //      c. bucket by templateKey (fallback adhoc:name); count
  //         ever-blocked per bucket
  const allTasks = await prisma.closeTask.findMany({
    where: {
      tenantId: scope.tenantId,
      periodId: { in: periodIds },
    },
    select: {
      id: true,
      templateKey: true,
      name: true,
    },
  });
  const taskIds = allTasks.map((t) => t.id);
  const blockedTransitions = taskIds.length > 0
    ? await prisma.closeTaskStateChange.findMany({
        where: {
          tenantId: scope.tenantId,
          closeTaskId: { in: taskIds },
          toStatus: "BLOCKED",
        },
        select: { closeTaskId: true },
      })
    : [];
  const everBlockedTaskIds = new Set(blockedTransitions.map((r) => r.closeTaskId));

  const blockerBuckets = new Map<
    string,
    { templateKey: string | null; name: string; blocked: number; total: number }
  >();
  for (const t of allTasks) {
    const key = t.templateKey ?? `adhoc:${t.name}`;
    const bucket = blockerBuckets.get(key) ?? {
      templateKey: t.templateKey,
      name: t.name,
      blocked: 0,
      total: 0,
    };
    bucket.total += 1;
    if (everBlockedTaskIds.has(t.id)) bucket.blocked += 1;
    blockerBuckets.set(key, bucket);
  }
  const recurringBlockers: RecurringBlocker[] = Array.from(blockerBuckets.values())
    .filter((b) => b.blocked > 0) // hide templates that never block
    .map((b) => ({
      templateKey: b.templateKey,
      name: b.name,
      blockedCount: b.blocked,
      totalCount: b.total,
      blockRate: b.total === 0 ? 0 : b.blocked / b.total,
    }))
    .sort((a, b) => b.blockedCount - a.blockedCount)
    .slice(0, 10); // top 10 — controller eyes can't process more

  // 6. Summary stats.
  const closedPeriodCount = daysToCloseTrend.length;
  const avgDaysToClose =
    closedPeriodCount === 0
      ? null
      : daysToCloseTrend.reduce((sum, p) => sum + p.daysToClose, 0) / closedPeriodCount;
  const metTargetCount = daysToCloseTrend.filter((p) => p.metTarget).length;
  const pctMetTarget = closedPeriodCount === 0 ? null : metTargetCount / closedPeriodCount;

  const totalReconsInWindow = exceptionRateTrend.reduce((s, p) => s + p.totalRecons, 0);
  const totalExceptionsInWindow = exceptionRateTrend.reduce((s, p) => s + p.exceptionCount, 0);
  const avgExceptionRate =
    totalReconsInWindow === 0 ? null : totalExceptionsInWindow / totalReconsInWindow;

  const summary: RetrospectiveSummary = {
    windowPeriods: lookbackPeriods,
    closedPeriodCount,
    avgDaysToClose,
    pctMetTarget,
    avgExceptionRate,
    totalTasksCompleted: doneTasks.length,
    totalReconsCompleted: totalReconsInWindow,
  };

  return {
    scope,
    targetDays,
    summary,
    daysToCloseTrend,
    taskLeadTime,
    exceptionRateTrend,
    recurringBlockers,
  };
}
