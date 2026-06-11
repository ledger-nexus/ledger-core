// BlackLine arc — Phase 1 PR 8: per-period reconciliation rollup.
//
// `getReconciliationRollup(prisma, scope)` returns the controller's
// month-end signoff snapshot for (tenant, entity, book, period):
//
//   {
//     total:        N total recons opened for the period
//     reconciled:   N marked RECONCILED (preparer+reviewer signed)
//     waived:       N admin-waived
//     prepared:     N awaiting reviewer signature
//     inProgress:   N sent back to preparer
//     open:         N not yet started
//     exception:    N over-tolerance, blocked
//     done:         reconciled + waived (the operator's "off the
//                                         plate" count — both states
//                                         are terminal)
//     pctDone:      done / total × 100 (0 when total = 0)
//   }
//
// Used by:
//   - The month-end packet's tie-out checks strip ("23/23 ✓ recons
//     signed off" or "20/23 ✗ — 3 exceptions")
//   - The CSV + PDF exports
//   - The Phase 2 close-task calendar will consume the same shape
//     when it materializes the recons task.
//
// Tenant-scoped. The recon model already carries tenantId; the
// query filters on it before the (entity, book, period) tuple to
// keep the plan tight on the (tenantId, periodId, status) index.

import type { ReconStatus } from "@prisma/client";
import type { DbClient } from "@/lib/db";


export interface ReconciliationRollup {
  total: number;
  reconciled: number;
  waived: number;
  prepared: number;
  inProgress: number;
  open: number;
  exception: number;
  done: number;
  pctDone: number;
}

export async function getReconciliationRollup(
  prisma: DbClient,
  scope: {
    tenantId: string;
    entityId: string;
    bookId: string;
    periodId: string;
  }
): Promise<ReconciliationRollup> {
  // ONE groupBy call. Postgres returns 0..6 rows (one per distinct
  // status). We hydrate the histogram from the rows and zero-fill
  // missing statuses.
  const rows = await prisma.reconciliation.groupBy({
    by: ["status"],
    where: {
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      bookId: scope.bookId,
      periodId: scope.periodId,
    },
    _count: { _all: true },
  });

  const counts: Record<ReconStatus, number> = {
    OPEN: 0,
    IN_PROGRESS: 0,
    PREPARED: 0,
    RECONCILED: 0,
    EXCEPTION: 0,
    WAIVED: 0,
  };
  for (const row of rows) {
    counts[row.status] = row._count._all;
  }

  const total =
    counts.OPEN +
    counts.IN_PROGRESS +
    counts.PREPARED +
    counts.RECONCILED +
    counts.EXCEPTION +
    counts.WAIVED;
  const done = counts.RECONCILED + counts.WAIVED;
  // Math.round so a 22/23 = 95.652% renders as 96% in the UI rather
  // than 95.65 (overprecision for a control-level dashboard).
  const pctDone = total === 0 ? 0 : Math.round((done / total) * 100);

  return {
    total,
    reconciled: counts.RECONCILED,
    waived: counts.WAIVED,
    prepared: counts.PREPARED,
    inProgress: counts.IN_PROGRESS,
    open: counts.OPEN,
    exception: counts.EXCEPTION,
    done,
    pctDone,
  };
}

/** A one-liner the cover page / CSV header / PDF can use. */
export function rollupSummaryLine(r: ReconciliationRollup): string {
  if (r.total === 0) return "No reconciliations opened for this period";
  const parts: string[] = [`${r.done} of ${r.total} signed off (${r.pctDone}%)`];
  if (r.exception > 0) parts.push(`${r.exception} exception${r.exception === 1 ? "" : "s"}`);
  if (r.prepared > 0)
    parts.push(`${r.prepared} awaiting review`);
  if (r.inProgress > 0)
    parts.push(`${r.inProgress} sent back`);
  if (r.open > 0) parts.push(`${r.open} not started`);
  return parts.join(" · ");
}
