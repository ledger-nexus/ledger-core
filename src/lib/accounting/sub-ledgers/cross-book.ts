// v0.9 NS Books Phase 3.5.E — cross-book sub-ledger discovery helper.
//
// Under multi-book NS imports (Phase 3.5.B), the same NS Invoice
// produces N ArOpenItem rows — one per mapped book. An operator on
// the `(entity, US_GAAP)` scope sees only US_GAAP's open items in
// the AR page; they have no signal that `(entity, US_TAX)` exists
// with its own (potentially different) open items.
//
// This helper surfaces those "other" books on an entity. The
// UI uses it for a discreet banner: "This entity also has open
// items on: US_TAX." Clicking the book code switches scope.

import type { PrismaClient } from "@prisma/client";

export interface EntityBookSummary {
  bookCode: string;
  openArCount: number;
  openApCount: number;
}

/**
 * For the given entity, list every book that has at least one open
 * AR or AP item with status IN (OPEN, PARTIAL, REOPENED) — i.e.
 * actually-actionable balance. Returns the count per book so the UI
 * can show "{n} open AR, {m} open AP" alongside each book code.
 *
 * Sort order: alphabetical book code (deterministic for the UI).
 *
 * Performance: two grouped counts. Two indexes on (entityId, bookId,
 * status, ...) already exist (ar_open_item + ap_open_item), so the
 * query plans hit the index cleanly.
 */
export async function listEntityBooksWithOpenItems(
  prisma: PrismaClient,
  entityCode: string,
  // Tenant pin — entity codes are unique only per tenant, so a UI caller
  // MUST pass this or a colliding code could count another tenant's open
  // items. Optional for substrate scripts.
  tenantId?: string
): Promise<EntityBookSummary[]> {
  const arRows = await prisma.arOpenItem.groupBy({
    by: ["bookId"],
    where: {
      ...(tenantId ? { tenantId } : {}),
      entity: { code: entityCode },
      status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
    },
    _count: { _all: true },
  });
  const apRows = await prisma.apOpenItem.groupBy({
    by: ["bookId"],
    where: {
      ...(tenantId ? { tenantId } : {}),
      entity: { code: entityCode },
      status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
    },
    _count: { _all: true },
  });

  // Resolve the bookId → bookCode mapping in one round-trip. Set is
  // intentional so we don't double-fetch a book that has both AR and
  // AP open items.
  const allBookIds = Array.from(
    new Set([...arRows.map((r) => r.bookId), ...apRows.map((r) => r.bookId)])
  );
  if (allBookIds.length === 0) return [];
  const books = await prisma.book.findMany({
    where: { id: { in: allBookIds } },
    select: { id: true, code: true },
  });
  const codeById = new Map(books.map((b) => [b.id, b.code]));

  const arCountByBookId = new Map(
    arRows.map((r) => [r.bookId, r._count._all])
  );
  const apCountByBookId = new Map(
    apRows.map((r) => [r.bookId, r._count._all])
  );

  return allBookIds
    .map((id) => ({
      bookCode: codeById.get(id) ?? "(unknown)",
      openArCount: arCountByBookId.get(id) ?? 0,
      openApCount: apCountByBookId.get(id) ?? 0,
    }))
    .filter((s) => s.bookCode !== "(unknown)")
    .sort((a, b) => a.bookCode.localeCompare(b.bookCode));
}
