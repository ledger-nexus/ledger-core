-- Lot — cost-basis parcels for the inventory engine (Beancount adoption, item 4
-- part 2). A parcel of a commodity acquired at a per-unit cost on a date, held
-- in an account, per book. A purchase augments (creates) a lot; a sale reduces
-- remainingUnits by booking method until exhausted (status -> CLOSED). Cost
-- basis is preserved parcel by parcel.
--
-- Book-aware (canon "inventory layers" pattern); modeled on ar_open_item.
-- openedByEntryId is nullable so a lot can be seeded/imported before its GL
-- posting is wired (posting integration is a later part of the arc).
--
-- Additive: one new table + one enum, no backfill. The schema is `db push`-
-- managed so CI/test create these from schema.prisma; this file is the
-- migrate-deploy (prod) path. NOT migration-mirror DDL.
--
-- Rollback:
--   DROP TABLE IF EXISTS "lot";
--   DROP TYPE IF EXISTS "LotStatus";

DO $$ BEGIN
  CREATE TYPE "LotStatus" AS ENUM ('OPEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "lot" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID NOT NULL,
  "entityId"         UUID NOT NULL,
  "bookId"           UUID NOT NULL,
  "accountId"        UUID NOT NULL,
  "commodityId"      UUID NOT NULL,
  "openedByEntryId"  UUID,
  "label"            TEXT,
  "acquisitionDate"  DATE NOT NULL,
  "originalUnits"    DECIMAL(28,10) NOT NULL,
  "remainingUnits"   DECIMAL(28,10) NOT NULL,
  "unitCost"         DECIMAL(28,10) NOT NULL,
  "costCurrencyId"   TEXT NOT NULL,
  "status"           "LotStatus" NOT NULL DEFAULT 'OPEN',
  "sourceSystem"     TEXT,
  "sourceRecordType" TEXT,
  "sourceRecordId"   TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "lot_tenantId_idx" ON "lot" ("tenantId");
CREATE INDEX IF NOT EXISTS "lot_entityId_bookId_accountId_commodityId_status_idx"
  ON "lot" ("entityId", "bookId", "accountId", "commodityId", "status");
CREATE INDEX IF NOT EXISTS "lot_entityId_bookId_commodityId_status_acquisitionDate_idx"
  ON "lot" ("entityId", "bookId", "commodityId", "status", "acquisitionDate");

-- FKs mirror the Prisma relations (tenant Restrict; entity/book/account/
-- commodity NoAction like their siblings; openedByEntry SET NULL since it's
-- nullable/optional).
DO $$ BEGIN
  ALTER TABLE "lot" ADD CONSTRAINT "lot_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lot" ADD CONSTRAINT "lot_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "legal_entity"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lot" ADD CONSTRAINT "lot_bookId_fkey"
    FOREIGN KEY ("bookId") REFERENCES "book"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lot" ADD CONSTRAINT "lot_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "account"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lot" ADD CONSTRAINT "lot_commodityId_fkey"
    FOREIGN KEY ("commodityId") REFERENCES "commodity"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lot" ADD CONSTRAINT "lot_openedByEntryId_fkey"
    FOREIGN KEY ("openedByEntryId") REFERENCES "gl_entry_header"("id") ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
