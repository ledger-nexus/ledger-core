-- 0015 — audit_log append-only RULEs + gl_entry_header lineage partial
-- unique index. The in-repo source for two pieces of production DDL
-- that previously had none (SOC 2 CC5/CC7.2; CC6.1).
--
-- PROVENANCE. Both objects were applied to production by hand (the
-- index on 2026-05-22 with v1.11, the rules on 2026-06-06 from the
-- never-merged extract-audit-log-rule branch) and were lost in the
-- 2026-06-10 db:reset incident — `db push --force-reset` restores only
-- what schema.prisma can express. The definitions below are byte-exact
-- captures from pre-incident production: a Neon point-in-time branch
-- taken at 2026-06-10T21:00:00Z (the wipe re-seeded at 21:14Z, inside
-- the 6-hour retention window), read from pg_rules / pg_indexes — not
-- reconstructed from docs or commentary.
--
-- 1. audit_log append-only enforcement is a RULE pair, NOT a trigger.
--    UPDATE and DELETE are both intercepted and silently no-op'd
--    (DO INSTEAD NOTHING): the statement "succeeds" with 0 rows
--    affected and the audit row survives. Silent-by-design, two
--    reasons (per the original author's notes):
--      a. ORMs occasionally issue spurious UPDATEs; NOTHING makes
--         them harmless where RAISE would crash them.
--      b. An attacker probing the table gets silence, not an error
--         message confirming the protection exists.
--    The silent no-op is also why the test suite "ran green" against
--    this for weeks — audit-row cleanup deletes returned count:0
--    without throwing. Tests that genuinely need to remove audit rows
--    use withAuditLogMutable (tests/_helpers/audit-log-cleanup.ts),
--    which disarms and re-arms the rules around the cleanup callback.
--
-- 2. The lineage partial unique index is the race-safety backstop for
--    idempotent JE posts (recurring runner, ERP importers, the
--    internal journal-entries endpoint). Its scope is
--    (tenantId, bookId) + the triple:
--      - tenantId: two tenants importing the same ERP record id must
--        not collide — QBO ids are small per-company integers, so
--        cross-tenant collisions are routine, and a bare-triple
--        unique would fail the second tenant's import (CC6.1).
--      - bookId: Pattern 2 multi-book posting writes the same source
--        event to N books with the same triple
--        (docs/universal-schema.md; postJournalEntry header notes).
--    Partial: manual / seeded JEs carry NULL lineage and are exempt.
--
-- CI note: `prisma db push` skips migration SQL. The applied form of
-- this DDL lives in prisma/sql/audit-log-append-only.sql (the rules)
-- and prisma/sql/migration-mirror.sql section 5 (the index); both are
-- applied by `npm run db:restore-ddl`, which CI ("Apply
-- migration-mirror DDL" step) and `npm run db:reset` both call. Keep
-- them in sync with this migration.
--
-- Rollback:
--   DROP RULE IF EXISTS audit_log_no_update ON "audit_log";
--   DROP RULE IF EXISTS audit_log_no_delete ON "audit_log";
--   DROP INDEX IF EXISTS "gl_entry_header_lineage_uniq";

-- ── Repair: remove the 2026-06-10 interim reconstructions ────────────
-- Before the pre-incident catalog was recovered, PR #232's first pass
-- reinstated this enforcement as an UPDATE-only trigger and a
-- tenant-less unique index. Both are superseded by the exact objects
-- below. (The tenant-less index was not merely different — it made the
-- second tenant to import a given ERP record id fail its import.)
DROP TRIGGER IF EXISTS "audit_log_no_update" ON "audit_log";
DROP TRIGGER IF EXISTS "audit_log_no_delete" ON "audit_log";
DROP FUNCTION IF EXISTS "audit_log_block_mutation"();
DROP INDEX IF EXISTS "gl_entry_header_lineage_unique";

-- ── 1. audit_log append-only RULE pair (SOC 2 CC5 / CC7.2) ───────────
DROP RULE IF EXISTS audit_log_no_update ON "audit_log";
CREATE RULE audit_log_no_update AS
  ON UPDATE TO "audit_log"
  DO INSTEAD NOTHING;

DROP RULE IF EXISTS audit_log_no_delete ON "audit_log";
CREATE RULE audit_log_no_delete AS
  ON DELETE TO "audit_log"
  DO INSTEAD NOTHING;

-- ── 2. Lineage partial unique index (tenant- and book-scoped) ────────
CREATE UNIQUE INDEX IF NOT EXISTS "gl_entry_header_lineage_uniq"
  ON "gl_entry_header" ("tenantId", "bookId", "sourceSystem", "sourceRecordType", "sourceRecordId")
  WHERE "sourceSystem" IS NOT NULL
    AND "sourceRecordType" IS NOT NULL
    AND "sourceRecordId" IS NOT NULL;
