// BlackLine arc — Phase 3 PR 4: flux rollup for the month-end packet.
//
// `getFluxRollup(prisma, scope, toPeriodId)` finds the latest flux
// statement for (tenant, entity, book, toPeriod) and returns its
// per-status histogram + finalize-readiness flags. Mirrors the recon
// rollup shape from Phase 1 PR 8 so the month-end page can render
// "✓ Flux signed off (47/47)" alongside the TB / BS / Sub-ledger /
// Recon tie-outs.
//
// Returns null when no statement exists for that scope — the
// month-end page renders the line as "n/a" rather than ✗.

import type { FluxLineStatus, FluxStatementStatus } from "@prisma/client";
import type { DbClient } from "@/lib/db";


export interface FluxRollup {
  statementId: string;
  status: FluxStatementStatus;
  finalizedAt: Date | null;
  finalizedBy: string | null; // displayName
  total: number;
  immaterial: number;
  needsComment: number;
  explained: number;
  waived: number;
  /** material = needsComment + explained + waived (all non-IMMATERIAL). */
  material: number;
  /** signed = explained + waived. */
  signed: number;
  /** true when status=FINALIZED AND signed === material. */
  signedOff: boolean;
}

/**
 * Find the latest flux statement for (tenant, entity, book) whose
 * toPeriod is the given periodId, and roll up its line histogram.
 * Returns null when no statement exists for that scope.
 *
 * "Latest" tie-breaker: most recently updated. A single (entity, book,
 * fromPeriod, toPeriod) tuple has at most one statement (the @@unique
 * key); multiple from-period comparisons against the same to-period
 * are allowed (e.g. May→June flux + Apr→June flux); the most-recently-
 * touched one is the controller's current focus.
 */
export async function getFluxRollup(
  prisma: DbClient,
  scope: {
    tenantId: string;
    entityId: string;
    bookId: string;
    toPeriodId: string;
  }
): Promise<FluxRollup | null> {
  const stmt = await prisma.fluxStatement.findFirst({
    where: {
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      bookId: scope.bookId,
      toPeriodId: scope.toPeriodId,
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      status: true,
      finalizedAt: true,
      finalizer: { select: { displayName: true } },
    },
  });
  if (!stmt) return null;

  const rows = await prisma.fluxLine.groupBy({
    by: ["status"],
    where: { statementId: stmt.id, tenantId: scope.tenantId },
    _count: { _all: true },
  });
  const counts: Record<FluxLineStatus, number> = {
    IMMATERIAL: 0,
    NEEDS_COMMENT: 0,
    EXPLAINED: 0,
    WAIVED: 0,
  };
  for (const r of rows) counts[r.status] = r._count._all;

  const total =
    counts.IMMATERIAL +
    counts.NEEDS_COMMENT +
    counts.EXPLAINED +
    counts.WAIVED;
  const material = counts.NEEDS_COMMENT + counts.EXPLAINED + counts.WAIVED;
  const signed = counts.EXPLAINED + counts.WAIVED;
  const signedOff =
    stmt.status === "FINALIZED" && signed === material;

  return {
    statementId: stmt.id,
    status: stmt.status,
    finalizedAt: stmt.finalizedAt,
    finalizedBy: stmt.finalizer?.displayName ?? null,
    total,
    immaterial: counts.IMMATERIAL,
    needsComment: counts.NEEDS_COMMENT,
    explained: counts.EXPLAINED,
    waived: counts.WAIVED,
    material,
    signed,
    signedOff,
  };
}

/** Natural-language one-liner used by the page header + CSV. */
export function fluxRollupLine(r: FluxRollup | null): string {
  if (!r) return "No flux statement for this period";
  if (r.total === 0) return "No flux lines";
  const parts: string[] = [];
  parts.push(
    `${r.signed} of ${r.material} material line${r.material === 1 ? "" : "s"} signed`
  );
  if (r.needsComment > 0) {
    parts.push(`${r.needsComment} pending`);
  }
  parts.push(`${r.total} total`);
  parts.push(r.status === "FINALIZED" ? "FINALIZED" : "DRAFT");
  return parts.join(" · ");
}
