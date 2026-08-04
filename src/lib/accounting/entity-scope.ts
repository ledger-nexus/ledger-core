// Chart objects — accounts, parties, items — are either ENTITY-SCOPED
// (entityId set) or SHARED across the tenant (entityId null). When both
// exist under the same code, the entity-scoped one shadows the shared
// one: a subsidiary that defines its own 6100 means ITS 6100 whenever
// that subsidiary is posting.
//
// This is chart-of-accounts semantics, not a query detail, and it was
// re-derived at every resolver — three variants inside postJournalEntry
// alone, each subtly different about ties. One definition lives here.
//
// Ambiguity (two rows at the same specificity tier) is left to the
// caller: `entityScopedPool` hands back the whole tier so a caller that
// must refuse can, and `pickEntityScoped` takes the first for callers
// where an arbitrary choice among equals is acceptable. Nothing here
// guesses across tiers.

export interface EntityScoped {
  entityId: string | null;
}

/**
 * The rows at the winning specificity tier: the entity's own rows when
 * it has any, otherwise the shared ones. Never mixes the two.
 */
export function entityScopedPool<T extends EntityScoped>(
  rows: readonly T[],
  entityId: string
): T[] {
  const own = rows.filter((r) => r.entityId === entityId);
  return own.length > 0 ? own : rows.filter((r) => r.entityId === null);
}

/**
 * The winning row, or undefined when there is none. Ties inside a tier
 * resolve to the first — callers that must refuse on ambiguity should
 * inspect `entityScopedPool(...).length` instead.
 */
export function pickEntityScoped<T extends EntityScoped>(
  rows: readonly T[],
  entityId: string
): T | undefined {
  return entityScopedPool(rows, entityId)[0];
}

/**
 * code → winning row, for the bulk lookups (post a JE's lines, translate
 * a trial balance). Rows for other entities are dropped, not shadowed:
 * an account scoped to a sibling entity is not in scope here at all.
 */
export function indexEntityScopedByCode<T extends EntityScoped & { code: string }>(
  rows: readonly T[],
  entityId: string
): Map<string, T> {
  const byCode = new Map<string, T[]>();
  for (const row of rows) {
    if (row.entityId !== null && row.entityId !== entityId) continue;
    const bucket = byCode.get(row.code);
    if (bucket) bucket.push(row);
    else byCode.set(row.code, [row]);
  }
  const winners = new Map<string, T>();
  for (const [code, bucket] of byCode) {
    const winner = pickEntityScoped(bucket, entityId);
    if (winner) winners.set(code, winner);
  }
  return winners;
}
