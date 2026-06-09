-- (Ported as 0019; the chain numbered it 0012 — main was at 0018.)
-- NS SuiteAnalytics Saved-Search amount filter prerequisite.
--
-- Adds denormalized totalDebit + totalCredit columns to JournalEntry
-- so the saved-search endpoint can filter by amount with an O(1)
-- index lookup instead of a per-row JOIN + aggregate.
--
-- INVARIANT: postJournalEntry enforces debits == credits, so on every
-- well-formed entry totalDebit == totalCredit. We carry both columns
-- anyway so callers querying "show me entries with debit > 1000"
-- don't need to know about the invariant.
--
-- Idempotent: uses IF NOT EXISTS for the column adds + uses a
-- WHERE clause on backfill so re-running only touches rows still at
-- default 0. The default(0) on the column keeps writes safe even
-- before the backfill completes — the constraint is "no nulls", not
-- "no zeroes".

ALTER TABLE "gl_entry_header"
  ADD COLUMN IF NOT EXISTS "totalDebit"  NUMERIC(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalCredit" NUMERIC(18, 4) NOT NULL DEFAULT 0;

-- Backfill from existing line sums. The aggregate over gl_entry_line
-- groups by entry id, summing per side. The UPDATE matches by id +
-- only touches rows still at the default 0 (so re-runs no-op).
WITH line_sums AS (
  SELECT
    "entryId" AS entry_id,
    SUM("debit")  AS total_debit,
    SUM("credit") AS total_credit
  FROM "gl_entry_line"
  GROUP BY "entryId"
)
UPDATE "gl_entry_header" h
SET
  "totalDebit"  = ls.total_debit,
  "totalCredit" = ls.total_credit
FROM line_sums ls
WHERE h.id = ls.entry_id
  AND h."totalDebit"  = 0
  AND h."totalCredit" = 0;

-- Index for the saved-search amount filter. The compound index covers
-- the common case "filter by tenant + amount range" + the lineage-uniq
-- case "find an entry by its NS internalid".
CREATE INDEX IF NOT EXISTS "gl_entry_header_total_debit_idx"
  ON "gl_entry_header" ("tenantId", "totalDebit");
