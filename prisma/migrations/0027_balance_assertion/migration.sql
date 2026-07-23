-- Balance assertions — "this account held exactly this much on this date."
--
-- postJournalEntry enforces correctness at the moment of WRITE. An assertion
-- enforces correctness ACROSS TIME: it catches silent drift (a double-posted
-- import, a missed reversal, a mapper regression) on the date it first appears
-- rather than at period close. Complementary to Reconciliation, which is the
-- periodic human attested control — this is the cheap continuous tripwire.
--
-- asOf is END of day (observed balance includes documentDate <= asOf, matching
-- getTrialBalance). expectedAmount is on the account's NORMAL side. tolerance
-- NULL => derived from Currency.decimals at check time.
--
-- Additive: new table + new enum, no backfill, nothing else altered. The schema
-- is `db push`-managed so CI/test create these from schema.prisma; this file is
-- the migrate-deploy (prod) path. NOT migration-mirror DDL — a plain table,
-- enum and FKs are fully Prisma-expressible.
--
-- Rollback:
--   DROP TABLE IF EXISTS "balance_assertion";
--   DROP TYPE IF EXISTS "AssertionStatus";

DO $$ BEGIN
  CREATE TYPE "AssertionStatus" AS ENUM ('UNCHECKED', 'PASS', 'FAIL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "balance_assertion" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"           UUID NOT NULL,
  "entityId"           UUID NOT NULL,
  "bookId"             UUID NOT NULL,
  "accountId"          UUID NOT NULL,
  "currencyId"         TEXT NOT NULL,
  "asOf"               DATE NOT NULL,
  "expectedAmount"     NUMERIC(20, 4) NOT NULL,
  "tolerance"          NUMERIC(20, 4),
  "lastCheckedAt"      TIMESTAMP(3),
  "lastObservedAmount" NUMERIC(20, 4),
  "lastStatus"         "AssertionStatus" NOT NULL DEFAULT 'UNCHECKED',
  "createdBy"          TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "balance_assertion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "balance_assertion_entityId_bookId_accountId_currencyId_asOf_key"
  ON "balance_assertion" ("entityId", "bookId", "accountId", "currencyId", "asOf");
CREATE INDEX IF NOT EXISTS "balance_assertion_tenantId_idx"
  ON "balance_assertion" ("tenantId");
CREATE INDEX IF NOT EXISTS "balance_assertion_entityId_bookId_asOf_idx"
  ON "balance_assertion" ("entityId", "bookId", "asOf");

-- FKs mirror Prisma's defaults for these relations (tenant Restrict per the
-- tenant-scoping convention; entity/book/account NoAction like their siblings).
DO $$ BEGIN
  ALTER TABLE "balance_assertion"
    ADD CONSTRAINT "balance_assertion_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "balance_assertion"
    ADD CONSTRAINT "balance_assertion_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "legal_entity"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "balance_assertion"
    ADD CONSTRAINT "balance_assertion_bookId_fkey"
    FOREIGN KEY ("bookId") REFERENCES "book"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "balance_assertion"
    ADD CONSTRAINT "balance_assertion_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "account"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
