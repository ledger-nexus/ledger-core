-- Database-level invariants for the ledger.
--
-- Prisma's schema language can't express CHECK constraints, so we add them here.
-- These run AFTER the initial schema migration.
--
-- Why duplicate these in the DB when we also enforce them in app code?
-- Because the DB is the last line of defense. If a future engineer (or a
-- mis-prompted Claude Code session) bypasses the posting function and writes
-- directly to the table, the DB will still reject an unbalanced or invalid line.
--
-- "Make invalid states unrepresentable" — the slogan applies to schemas too.

-- Every JournalLine must be exactly one of: a debit OR a credit.
-- Never both. Never neither.
ALTER TABLE "JournalLine"
  ADD CONSTRAINT line_xor_check
  CHECK ((debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0));

-- No negative amounts. Negatives in accounting are expressed by which column
-- the value lives in (debit vs credit), not by sign.
ALTER TABLE "JournalLine"
  ADD CONSTRAINT line_nonneg_check
  CHECK (debit >= 0 AND credit >= 0);

-- An entry that has been "posted" must have at least 2 lines.
-- (Single-line journal entries are nonsensical — there's nothing to balance against.)
-- We enforce the >=2 lines rule and the debits=credits rule in app code, inside a
-- transaction, because they require aggregation across lines.
