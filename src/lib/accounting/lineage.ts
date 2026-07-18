// Correction / reversal lineage of a journal entry — the "why did this balance
// change?" read path.
//
// Two relationships link entries in the substrate:
//   - REVERSAL (reversalOfId): a reversal negates its source — the source flips
//     to REVERSED and the reversal carries sign-flipped lines.
//   - CORRECTION (correctionOfId): a reclassification / correcting entry
//     supplements its source — the source stays POSTED and the correction is an
//     additional adjusting entry.
//
// This resolver returns BOTH relationships in BOTH directions for one entry, so
// a reader (JE detail page, the assistant, an API) can see the full immediate
// lineage: what this entry reverses/corrects, and what reverses/corrects it.
//
// Tenant-scoped: a forged / cross-tenant entryId resolves to null — the lineage
// of another firm's entry is never returned.

import type { DbClient } from "../db";

export interface LineageNode {
  id: string;
  entryNumber: string;
  status: string;
  documentDate: Date;
  memo: string;
}

export interface EntryLineage {
  entry: LineageNode;
  /** The entry this one reverses (reversalOf), or null. */
  reverses: LineageNode | null;
  /** Entries that reverse this one (reversedBy). */
  reversedBy: LineageNode[];
  /** The entry this one corrects (correctionOf), or null. */
  corrects: LineageNode | null;
  /** Entries that correct this one (corrections). */
  correctedBy: LineageNode[];
}

const NODE_SELECT = {
  id: true,
  entryNumber: true,
  status: true,
  documentDate: true,
  memo: true,
} as const;

export async function getEntryLineage(
  db: DbClient,
  { tenantId, entryId }: { tenantId: string; entryId: string }
): Promise<EntryLineage | null> {
  const entry = await db.journalEntry.findFirst({
    // Tenant scope is non-negotiable — a forged id from another tenant must
    // resolve to null, never leak another firm's lineage.
    where: { id: entryId, tenantId },
    select: {
      ...NODE_SELECT,
      reversalOf: { select: NODE_SELECT },
      reversedBy: { select: NODE_SELECT, orderBy: { documentDate: "asc" } },
      correctionOf: { select: NODE_SELECT },
      corrections: { select: NODE_SELECT, orderBy: { documentDate: "asc" } },
    },
  });
  if (!entry) return null;

  const { reversalOf, reversedBy, correctionOf, corrections, ...self } = entry;
  return {
    entry: self,
    reverses: reversalOf,
    reversedBy,
    corrects: correctionOf,
    correctedBy: corrections,
  };
}
