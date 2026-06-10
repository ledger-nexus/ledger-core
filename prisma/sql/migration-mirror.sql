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
-- 4. Append-only triggers on audit_log (SOC 2 CC7.2)
--    Strict refuse-all: audit_log's FK to tenant is ON DELETE RESTRICT,
--    so no cascade ever reaches it — no depth carve-out needed (that is
--    the deliberate difference from close_task_state_change; see the
--    0011 migration's commentary). No runtime code path UPDATEs or
--    DELETEs audit rows; anything that tries is a bug or an attacker.
--    NOTE: this trigger had no migration of its own — it predates the
--    practice. Reconstructed 2026-06-10 from the 0011 commentary after
--    the reset incident dropped it from production.
--    Rollback: DROP TRIGGER "audit_log_no_update" ON "audit_log";
--              DROP TRIGGER "audit_log_no_delete" ON "audit_log";
--              DROP FUNCTION "audit_log_block_mutation"();
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "audit_log_block_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — % blocked', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_log_no_update" ON "audit_log";
CREATE TRIGGER "audit_log_no_update"
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_block_mutation"();

DROP TRIGGER IF EXISTS "audit_log_no_delete" ON "audit_log";
CREATE TRIGGER "audit_log_no_delete"
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_block_mutation"();

-- ════════════════════════════════════════════════════════════════════
-- 5. Lineage partial unique index on gl_entry_header
--    DB-level idempotency backstop for source-lineage posts: the
--    recurring-entries runner (src/lib/accounting/recurring.ts) and the
--    ERP importers dedupe on the (sourceSystem, sourceRecordType,
--    sourceRecordId) triple. The app checks before insert; this index
--    is what makes a crashed run safe to re-run. Partial: manual /
--    seeded JEs carry NULL lineage and are exempt. NOTE: like the
--    audit_log trigger, this index had no migration of its own —
--    reconstructed 2026-06-10 from the recurring.ts commentary.
--    Rollback: DROP INDEX "gl_entry_header_lineage_unique";
-- ════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "gl_entry_header_lineage_unique"
  ON "gl_entry_header" ("sourceSystem", "sourceRecordType", "sourceRecordId")
  WHERE "sourceSystem" IS NOT NULL;
