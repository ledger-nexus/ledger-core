// One correct FK-ordered ledger teardown, instead of eleven hand-rolled ones.
//
// WHY THIS EXISTS. `clearLedger` in the two property suites deleted in this
// order:
//
//     arApplication (by openItem.entityId) -> arOpenItem (by entityId)
//     -> journalLine (by entry.entityId)   -> journalEntry (by entityId)
//
// which looks complete and is not. `ArOpenItem` carries a SECOND foreign key
// to `JournalEntry` — `openedByEntryId`, NON-NULL, relation "ArOpenedBy"
// (schema.prisma:1507) — and `ApOpenItem` has the symmetric "ApOpenedBy".
// Neither is covered by scoping on the open item's OWN `entityId`. An open
// item belonging to a different entity but OPENED BY an entry in this one
// survives the open-item delete and then blocks the entry delete with:
//
//     Foreign key constraint violated: ar_open_item_openedByEntryId_fkey
//
// `Lot.openedByEntryId` is a third such edge (nullable, so it restricts too).
//
// The pattern generalises past these tests: any teardown that reaches
// JournalEntry has to clear every referencing row first, and "referencing"
// is not the same set as "belongs to the same entity".
//
// DELETE BY ID, NOT BY MARKER. The obvious alternative — delete by
// `sourceRecordType` — is unsafe here and was rejected: the RLS suites stamp
// generic domain types (`VendorBill`, `CustomerInvoice`, `Payment`,
// `RecurringEntry`) that the Northwind seed also uses, so a marker-based
// sweep would delete legitimate seed rows and leave the next suite asserting
// against a dataset it did not expect. Two of those suites stamp nothing at
// all. Capturing the ids a test actually created is the only precise option.

import type { PrismaClient } from "@prisma/client";

/**
 * Delete the given journal entries and everything that references them.
 *
 * Safe to call with an empty list, and safe to call twice — every step is a
 * deleteMany over an id set, so a partially-cleaned state converges rather
 * than throwing.
 */
export async function deleteEntries(
  prisma: PrismaClient,
  entryIds: string[]
): Promise<void> {
  if (entryIds.length === 0) return;

  // Sub-ledger parcels opened BY these entries — the edge the entity-scoped
  // teardown misses. Their applications go first.
  await prisma.arApplication.deleteMany({
    where: { openItem: { openedByEntryId: { in: entryIds } } },
  });
  await prisma.apApplication.deleteMany({
    where: { openItem: { openedByEntryId: { in: entryIds } } },
  });
  await prisma.arOpenItem.deleteMany({
    where: { openedByEntryId: { in: entryIds } },
  });
  await prisma.apOpenItem.deleteMany({
    where: { openedByEntryId: { in: entryIds } },
  });

  // Lots point at the opening purchase entry. Nullable FK, still restricts.
  await prisma.lot.updateMany({
    where: { openedByEntryId: { in: entryIds } },
    data: { openedByEntryId: null },
  });

  await prisma.journalLine.deleteMany({
    where: { entryId: { in: entryIds } },
  });
  await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
}

/**
 * Every journal entry belonging to an entity, plus everything referencing
 * those entries — including rows owned by OTHER entities.
 *
 * This is the entity-scoped teardown the property suites want. It resolves
 * the entry ids first precisely so the reference sweep above can be keyed on
 * them rather than on entity, which is what made the original version wrong.
 */
export async function clearEntityLedger(
  prisma: PrismaClient,
  entityId: string
): Promise<void> {
  const entries = await prisma.journalEntry.findMany({
    where: { entityId },
    select: { id: true },
  });
  // The entity's own sub-ledger rows may have been opened by entries that
  // belong elsewhere, so clear them by entity as well as by reference.
  await prisma.arApplication.deleteMany({ where: { openItem: { entityId } } });
  await prisma.apApplication.deleteMany({ where: { openItem: { entityId } } });
  await prisma.arOpenItem.deleteMany({ where: { entityId } });
  await prisma.apOpenItem.deleteMany({ where: { entityId } });

  await deleteEntries(prisma, entries.map((e) => e.id));
}
