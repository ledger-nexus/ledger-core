-- v0.9 NS Books Phase 3.5.A — sub-ledger lineage uniq scoped to (tenantId, bookId).
--
-- Mirrors migration 0009 (which did the same thing for gl_entry_header /
-- JournalEntry). Today, ar_open_item + ap_open_item have NO unique
-- constraint on the lineage triple at all. The importer's application-
-- layer `alreadyImported` check (in src/lib/mappers/netsuite/import.ts)
-- guards against re-imports today, but:
--
--   1. There's no DB-level invariant — a bug bypassing the application
--      check (or a parallel race) silently creates duplicate AR/AP
--      open-item rows on the same NS Invoice / VendorBill.
--
--   2. The Phase 3.5.B "per-book sub-ledger loop" landing next will
--      write N AR open-item rows per NS Invoice (one per mapped book).
--      Those rows share the lineage triple but differ on bookId. A
--      global lineage uniq would block the multi-book write; the
--      (tenantId, bookId, ...) scope lets them coexist.
--
--   3. Cross-tenant: tenant A importing NS Invoice 10001 must not
--      block tenant B from importing THEIR NS Invoice 10001. Same
--      pre-existing multi-tenant bug 0009 fixed for GL.
--
-- Idempotent — uses IF NOT EXISTS / DROP IF EXISTS so re-runs are safe.
-- No data backfill needed: the column shape stays; we just add the
-- constraint. (The schema columns `bookId`, `sourceSystem`,
-- `sourceRecordType`, `sourceRecordId` have existed on these tables
-- since v0.4.)
--
-- The non-unique helper index on (sourceSystem, sourceRecordType,
-- sourceRecordId) — if any — would still help query plans on
-- per-source-id lookups. None exists today; the new partial unique
-- index doubles as a useful query plan for the per-import "have we
-- imported this NS Invoice" check that Phase 3.5.B will need.

-- AR side ---------------------------------------------------------------

DROP INDEX IF EXISTS "ar_open_item_lineage_uniq";

CREATE UNIQUE INDEX "ar_open_item_lineage_uniq"
  ON "ar_open_item"
  USING btree (
    "tenantId",
    "bookId",
    "sourceSystem",
    "sourceRecordType",
    "sourceRecordId"
  )
  WHERE (
    "sourceSystem"     IS NOT NULL AND
    "sourceRecordType" IS NOT NULL AND
    "sourceRecordId"   IS NOT NULL
  );

-- AP side ---------------------------------------------------------------

DROP INDEX IF EXISTS "ap_open_item_lineage_uniq";

CREATE UNIQUE INDEX "ap_open_item_lineage_uniq"
  ON "ap_open_item"
  USING btree (
    "tenantId",
    "bookId",
    "sourceSystem",
    "sourceRecordType",
    "sourceRecordId"
  )
  WHERE (
    "sourceSystem"     IS NOT NULL AND
    "sourceRecordType" IS NOT NULL AND
    "sourceRecordId"   IS NOT NULL
  );
