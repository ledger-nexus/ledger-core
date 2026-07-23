-- Commodity + commodity-price database (Beancount adoption, item 3).
--
-- A commodity is a tradeable instrument that is NOT a currency (stock, ETF,
-- fund, crypto). FxRate is currency->currency and cannot express a security
-- price; Currency is ISO-4217-keyed and must stay that way. So securities get
-- their own tenant-scoped master-data table plus a price DB that mirrors
-- FxRate. Additive Layer-2 extension — Currency, FxRate and the posting path
-- are untouched.
--
-- Prices resolve on-or-before (see getCommodityPrice), matching resolveFxRate.
-- Last write per (commodity, currency, date) wins.
--
-- Additive: two new tables, no backfill. The schema is `db push`-managed so
-- CI/test create these from schema.prisma; this file is the migrate-deploy
-- (prod) path. NOT migration-mirror DDL — plain tables + FKs are
-- Prisma-expressible.
--
-- Rollback:
--   DROP TABLE IF EXISTS "commodity_price";
--   DROP TABLE IF EXISTS "commodity";

CREATE TABLE IF NOT EXISTS "commodity" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"   UUID NOT NULL,
  "symbol"     TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "assetClass" TEXT,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "commodity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "commodity_tenantId_symbol_key"
  ON "commodity" ("tenantId", "symbol");
CREATE INDEX IF NOT EXISTS "commodity_tenantId_idx"
  ON "commodity" ("tenantId");

CREATE TABLE IF NOT EXISTS "commodity_price" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID NOT NULL,
  "commodityId" UUID NOT NULL,
  "currencyId"  TEXT NOT NULL,
  "asOf"        DATE NOT NULL,
  "price"       NUMERIC(20, 10) NOT NULL,
  "source"      TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commodity_price_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "commodity_price_commodityId_currencyId_asOf_key"
  ON "commodity_price" ("commodityId", "currencyId", "asOf");
CREATE INDEX IF NOT EXISTS "commodity_price_tenantId_idx"
  ON "commodity_price" ("tenantId");
CREATE INDEX IF NOT EXISTS "commodity_price_commodityId_currencyId_asOf_idx"
  ON "commodity_price" ("commodityId", "currencyId", "asOf");

-- FKs mirror the Prisma relations (tenant Restrict; commodity Cascade so a
-- deleted commodity takes its prices with it).
DO $$ BEGIN
  ALTER TABLE "commodity"
    ADD CONSTRAINT "commodity_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "commodity_price"
    ADD CONSTRAINT "commodity_price_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "commodity_price"
    ADD CONSTRAINT "commodity_price_commodityId_fkey"
    FOREIGN KEY ("commodityId") REFERENCES "commodity"("id")
    ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
