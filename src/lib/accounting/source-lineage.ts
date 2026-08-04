// The source-lineage triple — (sourceSystem, sourceRecordType,
// sourceRecordId). Distinct from `lineage.ts`, which is the
// correction/reversal graph between entries; this is the link from an
// entry back to the source event that produced it.
//
// It does two jobs at once. It is the audit trail, and it is the
// idempotency lock: the partial unique index
// `gl_entry_header_lineage_uniq` on (tenantId, bookId, sourceSystem,
// sourceRecordType, sourceRecordId) makes a second post of the same
// source event a structural impossibility rather than a best-effort
// check.
//
// The index is the backstop, not the mechanism. postJournalEntry does
// NOT dedupe — it inserts, and a repeat insert raises a unique
// violation. Producers that can legitimately re-run the same source
// event (the recurring runner re-enumerating a docDate after a crash,
// an importer re-reading a file) must therefore check BEFORE posting
// and treat a violation as "already done" rather than as failure.
// `findEntryBySourceLineage` and `isSourceLineageConflict` are that pair.
//
// Triples used to be assembled from string literals at each producer,
// which let the automation registry's intercompany count drift from the
// module it was counting. Build them here; match on them here.

import { Prisma } from "@prisma/client";
import type { DbClient } from "../db";

export interface SourceLineage {
  sourceSystem: string;
  sourceRecordType: string;
  sourceRecordId: string;
}

/** Entries the substrate itself produces from a stored template. */
export const RECURRING_SOURCE_SYSTEM = "SUBSTRATE";
export const RECURRING_RECORD_TYPE = "RecurringEntry";

/** The counterparty half of an intercompany entry (./intercompany.ts). */
export const IC_MIRROR_SOURCE_SYSTEM = "INTERCOMPANY";
export const IC_MIRROR_RECORD_TYPE = "gl_entry_mirror";

/**
 * UTC "YYYY-MM-DD". The period component of a recurring id, so a re-run
 * of the same cadence step reproduces the identical string and lands on
 * the lock instead of double-posting.
 */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const sourceLineage = {
  /** One (template, cadence step) pair. */
  recurring(templateId: string, docDate: Date): SourceLineage {
    return {
      sourceSystem: RECURRING_SOURCE_SYSTEM,
      sourceRecordType: RECURRING_RECORD_TYPE,
      sourceRecordId: `${templateId}:${isoDate(docDate)}`,
    };
  },

  /** The mirror of one source entry. */
  icMirror(sourceEntryId: string): SourceLineage {
    return {
      sourceSystem: IC_MIRROR_SOURCE_SYSTEM,
      sourceRecordType: IC_MIRROR_RECORD_TYPE,
      sourceRecordId: sourceEntryId,
    };
  },
};

/**
 * The entry already posted for this triple, if any. Scope matches the
 * index: tenant + book + triple. Omitting bookId asks "in any book",
 * which is what a caller looking for the mirror of an entry wants.
 */
export async function findEntryBySourceLineage(
  prisma: DbClient,
  args: { tenantId: string; bookId?: string; lineage: SourceLineage }
): Promise<{ id: string; entryNumber: string; status: string } | null> {
  return prisma.journalEntry.findFirst({
    where: {
      tenantId: args.tenantId,
      ...(args.bookId ? { bookId: args.bookId } : {}),
      ...args.lineage,
    },
    select: { id: true, entryNumber: true, status: true },
  });
}

/**
 * True when an error is the lineage index refusing a duplicate source
 * event — i.e. someone else posted this exact (tenant, book, triple)
 * between our check and our write.
 *
 * Deliberately narrow: a P2002 on `tenantId_entryNumber` is the
 * entry-number allocation race, a genuine failure the caller must
 * surface. Swallowing every P2002 here would hide it.
 */
export function isSourceLineageConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") {
    return false;
  }
  const target = e.meta?.target;
  const asText = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return asText.includes("lineage") || asText.includes("sourceRecordId");
}
