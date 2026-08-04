-- Account commodity constraint + dated lifecycle.
--
-- `active` is a boolean and therefore cannot answer "was this account valid on
-- the ENTRY's date" — the only question that matters for a backdated post.
-- openedOn/closedOn can. And nothing previously stopped a EUR posting landing
-- in a USD-only cash account; allowedCurrencies does.
--
-- postJournalEntry (the single write path) enforces both, so every caller —
-- UI, importers, cron, sub-ledgers — inherits them.
--
-- INERT BY DEFAULT, which is what makes this safe to add to a populated
-- ledger: allowedCurrencies defaults to the empty array (= unconstrained) and
-- both dates default to NULL (= unbounded). No existing account changes
-- behaviour until someone opts in.
--
-- Boundaries are INCLUSIVE: postable on [openedOn, closedOn].
--
-- Additive columns, no backfill. The schema is `db push`-managed so CI/test
-- create these from schema.prisma; this file is the migrate-deploy (prod)
-- path. NOT migration-mirror DDL — plain columns are Prisma-expressible.
--
-- Rollback:
--   ALTER TABLE "account" DROP COLUMN IF EXISTS "allowedCurrencies";
--   ALTER TABLE "account" DROP COLUMN IF EXISTS "openedOn";
--   ALTER TABLE "account" DROP COLUMN IF EXISTS "closedOn";

ALTER TABLE "account"
  ADD COLUMN IF NOT EXISTS "allowedCurrencies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "openedOn" DATE,
  ADD COLUMN IF NOT EXISTS "closedOn" DATE;
