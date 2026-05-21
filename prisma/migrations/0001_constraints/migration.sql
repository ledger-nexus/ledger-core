-- Database-level invariants for the ledger.
--
-- Prisma's schema language can't express CHECK constraints, so we add them here.
-- These run AFTER the initial schema migration.
--
-- "Make invalid states unrepresentable" — applied to schemas, not just types.
-- If a future engineer (or a mis-prompted Claude Code session) bypasses the
-- posting function and writes directly to the table, the DB will still reject
-- an unbalanced or invalid line.

-- Every gl_entry_line must be exactly one of: a debit OR a credit.
-- Never both. Never neither. This is the Layer 1 XOR invariant.
ALTER TABLE "gl_entry_line"
  ADD CONSTRAINT line_xor_check
  CHECK ((debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0));

-- No negative amounts in the canonical debit/credit pair. Negatives in
-- accounting are expressed by which column the value lives in, not by sign.
ALTER TABLE "gl_entry_line"
  ADD CONSTRAINT line_nonneg_check
  CHECK (debit >= 0 AND credit >= 0);

-- Transaction-currency and reporting-currency amounts are SIGNED (debit > 0,
-- credit < 0). The sign must agree with the debit/credit pair.
ALTER TABLE "gl_entry_line"
  ADD CONSTRAINT line_txn_sign_check
  CHECK (
    (debit > 0 AND "transactionAmount" >= 0) OR
    (credit > 0 AND "transactionAmount" <= 0) OR
    "transactionAmount" = 0
  );

ALTER TABLE "gl_entry_line"
  ADD CONSTRAINT line_reporting_sign_check
  CHECK (
    (debit > 0 AND "reportingAmount" >= 0) OR
    (credit > 0 AND "reportingAmount" <= 0) OR
    "reportingAmount" = 0
  );

-- The debits = credits invariant per (entry, book) requires aggregation across
-- lines. Enforced inside postJournalEntry's transaction. A deferrable CHECK
-- via trigger arrives with the next batch.

-- The (entity, book, period) close lock is enforced at the application layer
-- in postJournalEntry. A trigger that reads period_close at INSERT time is
-- planned; out of scope for the first commit.

-- Useful GIN indexes for the `extensions` JSONB columns. Prisma can't define
-- GIN indexes via the schema language, so they live here.
CREATE INDEX IF NOT EXISTS gl_entry_header_extensions_gin
  ON "gl_entry_header" USING GIN ("extensions");

CREATE INDEX IF NOT EXISTS gl_entry_line_extensions_gin
  ON "gl_entry_line" USING GIN ("extensions");

CREATE INDEX IF NOT EXISTS party_extensions_gin
  ON "party" USING GIN ("extensions");

CREATE INDEX IF NOT EXISTS account_extensions_gin
  ON "account" USING GIN ("extensions");
