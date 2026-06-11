// BlackLine arc — Phase 2 PR 6: close-task rollup + period-close gate.
//
// Mirrors src/lib/recon/rollup.ts in shape so the periods-page UI and
// the closePeriodAction can both consume one source of truth.
//
//   getCloseTaskRollup(prisma, scope) → histogram + pctDone
//   checkRequiredTasksComplete(prisma, scope) → array of blockers
//
// The rollup answers "what's the controller's progress this period?";
// the blocker check answers "is the close-gate satisfied?". They're
// different questions because `requiredForClose=false` tasks
// (post-mortem) count toward done% but never block the close.

import type { CloseTaskStatus } from "@prisma/client";
import type { DbClient } from "@/lib/db";


export interface CloseTaskRollup {
  total: number;
  notStarted: number;
  inProgress: number;
  blocked: number;
  done: number;
  waived: number;
  /** done + waived (both terminal — off the controller's plate). */
  terminal: number;
  /** terminal / total × 100, rounded. 0 when total=0. */
  pctDone: number;
}

/**
 * Per-period rollup across all close tasks for a tenant. The list page
 * and the periods page both consume this. ONE groupBy query; we hydrate
 * the histogram from 0..5 returned rows.
 *
 * `periodId` is the only scope key — tasks have nullable entity/book
 * (org-wide ADMIN tasks live with both null), so scoping by tenant +
 * period gets the full count without false negatives.
 */
export async function getCloseTaskRollup(
  prisma: DbClient,
  scope: { tenantId: string; periodId: string }
): Promise<CloseTaskRollup> {
  const rows = await prisma.closeTask.groupBy({
    by: ["status"],
    where: { tenantId: scope.tenantId, periodId: scope.periodId },
    _count: { _all: true },
  });

  const counts: Record<CloseTaskStatus, number> = {
    NOT_STARTED: 0,
    IN_PROGRESS: 0,
    BLOCKED: 0,
    DONE: 0,
    WAIVED: 0,
  };
  for (const row of rows) counts[row.status] = row._count._all;

  const total =
    counts.NOT_STARTED +
    counts.IN_PROGRESS +
    counts.BLOCKED +
    counts.DONE +
    counts.WAIVED;
  const terminal = counts.DONE + counts.WAIVED;
  const pctDone = total === 0 ? 0 : Math.round((terminal / total) * 100);

  return {
    total,
    notStarted: counts.NOT_STARTED,
    inProgress: counts.IN_PROGRESS,
    blocked: counts.BLOCKED,
    done: counts.DONE,
    waived: counts.WAIVED,
    terminal,
    pctDone,
  };
}

export interface CloseTaskBlocker {
  id: string;
  name: string;
  status: CloseTaskStatus;
}

/**
 * Return every `requiredForClose=true` task that isn't in a terminal
 * state (DONE or WAIVED). Empty array = close-gate is satisfied for
 * this period.
 *
 * NOTE the (entity, book) shape: a single period applies to N (entity,
 * book) tuples. The close-gate composes the CloseTask scope (tenant +
 * period) with the recon scope (tenant + entity + book + period) at
 * the closePeriodAction layer — tasks block the close PERIOD-WIDE,
 * recons block the close PER-(ENTITY, BOOK). That's by design: a
 * "close GL" task is per-period for the whole org; cash reconciliation
 * is per-(entity, book).
 */
export async function checkRequiredTasksComplete(
  prisma: DbClient,
  scope: { tenantId: string; periodId: string }
): Promise<CloseTaskBlocker[]> {
  const blockers = await prisma.closeTask.findMany({
    where: {
      tenantId: scope.tenantId,
      periodId: scope.periodId,
      requiredForClose: true,
      status: { notIn: ["DONE", "WAIVED"] },
    },
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  });
  return blockers;
}
