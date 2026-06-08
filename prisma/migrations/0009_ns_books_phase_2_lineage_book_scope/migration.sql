-- v0.8 NS Accounting Books Phase 2 — scope lineage unique to (tenantId, bookId, ...).
--
-- The pre-existing partial unique index
--   gl_entry_header_lineage_uniq ON ("sourceSystem", "sourceRecordType", "sourceRecordId")
-- has two architectural issues:
--
--   1. Multi-tenant: tenant A importing NS Invoice 10001 prevents
--      tenant B from importing THEIR NS Invoice 10001. Cross-tenant
--      collision on source IDs is a real bug even pre-NS-books.
--
--   2. Multi-book: a single NS transaction posts to N ledger-core books
--      (Pattern 2 parallel posting). The existing index blocks the
--      second per-book post with a duplicate-key violation.
--
-- Both issues have the same fix: add (tenantId, bookId) to the scope so
-- the lineage triple is unique per (tenant, book).
--
-- This migration:
--   1. Drops the old global lineage unique
--   2. Re-creates it scoped to (tenantId, bookId, ...)
--
-- The non-unique helper index stays — it still helps query plans on
-- per-source-id lookups.

DROP INDEX IF EXISTS "gl_entry_header_lineage_uniq";

CREATE UNIQUE INDEX "gl_entry_header_lineage_uniq"
  ON "gl_entry_header"
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
