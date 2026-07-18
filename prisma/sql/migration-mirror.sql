-- Migration-mirror DDL — everything `prisma db push` CANNOT create.
--
-- The schema is `db push`-managed (no baseline migration), and Prisma's
-- schema language cannot express triggers, CHECK constraints, GIN
-- indexes, or partial unique indexes. Those live only in migration SQL —
-- which `db push` never runs. So after any `db push --force-reset`
-- (including `npm run db:reset`) this file MUST be re-applied or the
-- database silently loses its SOC 2 append-only enforcement and ledger
-- invariants. That is not hypothetical: the 2026-06-10 reset incident
-- left production without these objects until they were re-applied.
--
-- This file is the single source of truth. It is applied by:
--   - `npm run db:restore-ddl` (and therefore by `npm run db:reset`)
--   - CI (.github/workflows/ci.yml, "Apply migration-mirror DDL" step)
--
-- Adding migration-only DDL in a future migration? Add it HERE too,
-- idempotently (CREATE OR REPLACE / IF NOT EXISTS / duplicate_object
-- guard), or fresh databases will not have it.
--
-- Rollback: each block notes its DROP statements.

-- ════════════════════════════════════════════════════════════════════
-- 1. Ledger CHECK constraints (from 0001_constraints)
--    "Make invalid states unrepresentable" — if anything bypasses
--    postJournalEntry and writes lines directly, the DB still refuses
--    an unbalanced or invalid line.
--    Rollback: ALTER TABLE "gl_entry_line" DROP CONSTRAINT <name>;
-- ════════════════════════════════════════════════════════════════════

-- Every gl_entry_line must be exactly one of: a debit OR a credit.
DO $$ BEGIN
  ALTER TABLE "gl_entry_line"
    ADD CONSTRAINT line_xor_check
    CHECK ((debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- No negative amounts in the canonical debit/credit pair.
DO $$ BEGIN
  ALTER TABLE "gl_entry_line"
    ADD CONSTRAINT line_nonneg_check
    CHECK (debit >= 0 AND credit >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Transaction-currency amount sign must agree with the debit/credit pair.
DO $$ BEGIN
  ALTER TABLE "gl_entry_line"
    ADD CONSTRAINT line_txn_sign_check
    CHECK (
      (debit > 0 AND "transactionAmount" >= 0) OR
      (credit > 0 AND "transactionAmount" <= 0) OR
      "transactionAmount" = 0
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "gl_entry_line"
    ADD CONSTRAINT line_reporting_sign_check
    CHECK (
      (debit > 0 AND "reportingAmount" >= 0) OR
      (credit > 0 AND "reportingAmount" <= 0) OR
      "reportingAmount" = 0
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ════════════════════════════════════════════════════════════════════
-- 2. GIN indexes on `extensions` JSONB columns (from 0001_constraints)
--    Rollback: DROP INDEX <name>;
-- ════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS gl_entry_header_extensions_gin
  ON "gl_entry_header" USING GIN ("extensions");

CREATE INDEX IF NOT EXISTS gl_entry_line_extensions_gin
  ON "gl_entry_line" USING GIN ("extensions");

CREATE INDEX IF NOT EXISTS party_extensions_gin
  ON "party" USING GIN ("extensions");

CREATE INDEX IF NOT EXISTS account_extensions_gin
  ON "account" USING GIN ("extensions");

-- ════════════════════════════════════════════════════════════════════
-- 3. Append-only triggers on close_task_state_change (from
--    0011_close_task_state_history, verbatim)
--    CC7.2: once recorded, a state transition cannot be silently
--    rewritten. Carve-out for FK cascade: when a CloseTask is deleted,
--    Postgres cascades the delete to its state-change rows; the trigger
--    fires at depth > 1 in that case and lets it through so tenant
--    teardown / right-to-erasure works. Direct DELETE is depth = 1 and
--    stays blocked.
--    Rollback: DROP TRIGGER ... ON "close_task_state_change";
--              DROP FUNCTION "close_task_state_change_block_mutation"();
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "close_task_state_change_block_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    -- Cascade from close_task DELETE. Permit.
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'close_task_state_change is append-only — % blocked',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "close_task_state_change_no_update"
  ON "close_task_state_change";
CREATE TRIGGER "close_task_state_change_no_update"
  BEFORE UPDATE ON "close_task_state_change"
  FOR EACH ROW EXECUTE FUNCTION "close_task_state_change_block_mutation"();

DROP TRIGGER IF EXISTS "close_task_state_change_no_delete"
  ON "close_task_state_change";
CREATE TRIGGER "close_task_state_change_no_delete"
  BEFORE DELETE ON "close_task_state_change"
  FOR EACH ROW EXECUTE FUNCTION "close_task_state_change_block_mutation"();

-- ════════════════════════════════════════════════════════════════════
-- 4. audit_log append-only enforcement (SOC 2 CC5/CC7.2)
--    Lives in its own file: prisma/sql/audit-log-append-only.sql —
--    silent Postgres RULEs that no-op UPDATE and DELETE (see that
--    file's header for why RULE-over-trigger was chosen, and
--    tests/_helpers/audit-log-cleanup.ts for the test-only escape
--    hatch that must stay in sync with the rule names).
--    `npm run db:restore-ddl` applies BOTH files; if you apply this
--    file by hand, apply that one too.
--
--    The block below only removes the loud-trigger variant that the
--    2026-06-10 first draft of this file installed, so re-running
--    db:restore-ddl converges any environment on the RULE mechanism.
-- ════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS "audit_log_no_update" ON "audit_log";
DROP TRIGGER IF EXISTS "audit_log_no_delete" ON "audit_log";
DROP FUNCTION IF EXISTS "audit_log_block_mutation"();

-- ════════════════════════════════════════════════════════════════════
-- 5. Lineage partial unique index on gl_entry_header
--    (from 0015_audit_log_rules_and_lineage_uniq, verbatim)
--    DB-level idempotency backstop for source-lineage posts: the
--    recurring-entries runner (src/lib/accounting/recurring.ts), the
--    ERP importers, and the internal journal-entries endpoint dedupe
--    on the (sourceSystem, sourceRecordType, sourceRecordId) triple.
--    The app checks before insert; this index is what makes a crashed
--    or racing run safe to re-run. Scope is (tenantId, bookId) + the
--    triple: tenantId so two tenants importing the same ERP record id
--    never collide (QBO ids are small per-company integers — CC6.1),
--    bookId because Pattern 2 multi-book posting writes the same
--    triple to N books. Partial: manual / seeded JEs carry NULL
--    lineage and are exempt. Byte-exact capture of pre-incident
--    production via a Neon point-in-time branch (2026-06-10T21:00:00Z)
--    — the earlier reconstruction from recurring.ts commentary was a
--    tenant-less bare triple, repaired below.
--    Rollback: DROP INDEX "gl_entry_header_lineage_uniq";
-- ════════════════════════════════════════════════════════════════════

-- Repair: drop the 2026-06-10 interim tenant-less reconstruction —
-- under it, the second tenant to import a given ERP record id fails
-- its import with a unique violation.
DROP INDEX IF EXISTS "gl_entry_header_lineage_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "gl_entry_header_lineage_uniq"
  ON "gl_entry_header" ("tenantId", "bookId", "sourceSystem", "sourceRecordType", "sourceRecordId")
  WHERE "sourceSystem" IS NOT NULL
    AND "sourceRecordType" IS NOT NULL
    AND "sourceRecordId" IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- 6. Sub-ledger lineage partial unique indexes (ar_open_item / ap_open_item)
--    (from 0018_ns_sub_ledger_lineage_book_scope, verbatim)
--    Mirrors the gl_entry_header lineage uniq (section 5) onto the
--    sub-ledger tables ahead of NS Books Phase 3.5.B's per-book
--    sub-ledger writes: same (tenantId, bookId, source-triple) scope,
--    same partial WHERE so manual entries (NULL lineage) are exempt.
--    Partial uniques cannot be expressed in schema.prisma, so db push
--    never creates them — this mirror entry is what CI and post-reset
--    restores rely on.
--    Rollback: DROP INDEX "ar_open_item_lineage_uniq";
--              DROP INDEX "ap_open_item_lineage_uniq";
-- ════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "ar_open_item_lineage_uniq"
  ON "ar_open_item" ("tenantId", "bookId", "sourceSystem", "sourceRecordType", "sourceRecordId")
  WHERE "sourceSystem" IS NOT NULL
    AND "sourceRecordType" IS NOT NULL
    AND "sourceRecordId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ap_open_item_lineage_uniq"
  ON "ap_open_item" ("tenantId", "bookId", "sourceSystem", "sourceRecordType", "sourceRecordId")
  WHERE "sourceSystem" IS NOT NULL
    AND "sourceRecordType" IS NOT NULL
    AND "sourceRecordId" IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- 7. period_reopen_log append-only enforcement (SOC 2 CC5/CC7.2)
--    period_reopen_log records every period reopen as an immutable fact
--    (who / when / reason). App discipline is insert-only; these RULEs are
--    the AUDITABLE PROOF that the reopen history cannot be silently edited,
--    even by a privileged user running arbitrary SQL. Same RULE→NOTHING
--    mechanism and rationale as audit_log (section 4 / audit-log-append-only.sql):
--    UPDATE and DELETE become silent no-ops; INSERT stays unrestricted.
--    Partial unique / triggers can't be expressed in schema.prisma, so
--    `db push` never creates these — this mirror entry is what CI and
--    post-reset restores rely on.
--    Numbered migration: prisma/migrations/0026_period_reopen_log_append_only/.
--    Keep this block, that migration, and the withPeriodReopenLogMutable
--    re-arm statements (tests/_helpers/audit-log-cleanup.ts) in sync.
--    Idempotent: drops existing rules first so re-applying is safe.
--    Rollback: DROP RULE IF EXISTS period_reopen_log_no_update ON "period_reopen_log";
--              DROP RULE IF EXISTS period_reopen_log_no_delete ON "period_reopen_log";
-- ════════════════════════════════════════════════════════════════════

DROP RULE IF EXISTS period_reopen_log_no_update ON "period_reopen_log";
DROP RULE IF EXISTS period_reopen_log_no_delete ON "period_reopen_log";

CREATE RULE period_reopen_log_no_update AS
  ON UPDATE TO "period_reopen_log"
  DO INSTEAD NOTHING;

CREATE RULE period_reopen_log_no_delete AS
  ON DELETE TO "period_reopen_log"
  DO INSTEAD NOTHING;
