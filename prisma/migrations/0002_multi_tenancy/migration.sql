-- Multi-tenancy migration — Phase 1 (schema additions + backfill).
--
-- See docs/multi-tenancy.md for the full design.
--
-- This migration:
--   1. Creates the new tenant tables (tenant, tenant_membership, tenant_api_token)
--      and the TenantRole enum.
--   2. Adds a NULLABLE tenantId column to every tenant-scoped domain table.
--   3. Creates a default Tenant + default TenantMembership for every existing
--      User so the system still works post-migration in single-tenant mode.
--   4. Backfills tenantId on every existing row to the default tenant.
--
-- What this migration does NOT do (deferred to Phase 4):
--   - Apply NOT NULL constraint to tenantId columns.
--   - Update unique constraints to be composite (tenantId, ...).
--   - Update queries to filter by tenantId.
--
-- Idempotent: uses IF NOT EXISTS / DO blocks so re-running is safe.

-- ─── Enums ─────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ─── tenant ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tenant" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "slug"        TEXT         NOT NULL,
  "name"        TEXT         NOT NULL,
  "ownerUserId" UUID         NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "deletedAt"   TIMESTAMP(3),
  PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_slug_key" ON "tenant"("slug");
CREATE INDEX IF NOT EXISTS "tenant_ownerUserId_idx" ON "tenant"("ownerUserId");

-- ─── tenant_membership ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tenant_membership" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"  UUID         NOT NULL,
  "userId"    UUID         NOT NULL,
  "role"      "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "tenant_membership_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "tenant_membership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_membership_tenantId_userId_key"
  ON "tenant_membership"("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "tenant_membership_userId_idx"
  ON "tenant_membership"("userId");

-- ─── tenant_api_token ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tenant_api_token" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"   UUID         NOT NULL,
  "tokenHash"  TEXT         NOT NULL,
  "label"      TEXT         NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt"  TIMESTAMP(3),
  PRIMARY KEY ("id"),
  CONSTRAINT "tenant_api_token_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_api_token_tokenHash_key"
  ON "tenant_api_token"("tokenHash");
CREATE INDEX IF NOT EXISTS "tenant_api_token_tenantId_idx"
  ON "tenant_api_token"("tenantId");

-- ─── Add tenantId column to every tenant-scoped table ─────────────────────
-- Using IF NOT EXISTS so re-runs are safe. All columns are NULLABLE for now.

ALTER TABLE "legal_entity"            ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "fiscal_calendar"         ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "period"                  ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "period_close"            ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "party"                   ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "party_role"              ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "item"                    ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "account"                 ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "gl_entry_header"         ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "gl_entry_line"           ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "dimension"               ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "dimension_value"         ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "dimension_set"           ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "posting_rule"            ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "custom_field_definition" ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "ar_open_item"            ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "ar_application"          ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "ap_open_item"            ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "ap_application"          ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "fixed_asset"             ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "lease"                   ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "revenue_contract"        ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "queue"                   ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "record_event"            ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "audit_log"               ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "reassignment_rule"       ADD COLUMN IF NOT EXISTS "tenantId" UUID;
ALTER TABLE "notification"            ADD COLUMN IF NOT EXISTS "tenantId" UUID;

-- ─── Foreign-key constraints ───────────────────────────────────────────────

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT unnest(ARRAY[
      'legal_entity', 'fiscal_calendar', 'period', 'period_close',
      'party', 'party_role', 'item', 'account',
      'gl_entry_header', 'gl_entry_line',
      'dimension', 'dimension_value', 'dimension_set',
      'posting_rule', 'custom_field_definition',
      'ar_open_item', 'ar_application', 'ap_open_item', 'ap_application',
      'fixed_asset', 'lease', 'revenue_contract',
      'queue', 'record_event', 'audit_log', 'reassignment_rule', 'notification'
    ]) AS table_name
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE RESTRICT',
        rec.table_name,
        rec.table_name || '_tenantId_fkey'
      );
    EXCEPTION WHEN duplicate_object THEN
      -- FK already exists; safe to ignore (idempotent re-run).
      NULL;
    END;
  END LOOP;
END $$;

-- ─── Default-tenant indices (per @@index([tenantId])) ──────────────────────

CREATE INDEX IF NOT EXISTS "legal_entity_tenantId_idx"            ON "legal_entity"("tenantId");
CREATE INDEX IF NOT EXISTS "fiscal_calendar_tenantId_idx"         ON "fiscal_calendar"("tenantId");
CREATE INDEX IF NOT EXISTS "period_tenantId_idx"                  ON "period"("tenantId");
CREATE INDEX IF NOT EXISTS "period_close_tenantId_idx"            ON "period_close"("tenantId");
CREATE INDEX IF NOT EXISTS "party_tenantId_idx"                   ON "party"("tenantId");
CREATE INDEX IF NOT EXISTS "party_role_tenantId_idx"              ON "party_role"("tenantId");
CREATE INDEX IF NOT EXISTS "item_tenantId_idx"                    ON "item"("tenantId");
CREATE INDEX IF NOT EXISTS "account_tenantId_idx"                 ON "account"("tenantId");
CREATE INDEX IF NOT EXISTS "gl_entry_header_tenantId_postingDate_idx"
  ON "gl_entry_header"("tenantId", "postingDate");
CREATE INDEX IF NOT EXISTS "gl_entry_line_tenantId_idx"           ON "gl_entry_line"("tenantId");
CREATE INDEX IF NOT EXISTS "dimension_tenantId_idx"               ON "dimension"("tenantId");
CREATE INDEX IF NOT EXISTS "dimension_value_tenantId_idx"         ON "dimension_value"("tenantId");
CREATE INDEX IF NOT EXISTS "dimension_set_tenantId_idx"           ON "dimension_set"("tenantId");
CREATE INDEX IF NOT EXISTS "posting_rule_tenantId_idx"            ON "posting_rule"("tenantId");
CREATE INDEX IF NOT EXISTS "custom_field_definition_tenantId_idx" ON "custom_field_definition"("tenantId");
CREATE INDEX IF NOT EXISTS "ar_open_item_tenantId_idx"            ON "ar_open_item"("tenantId");
CREATE INDEX IF NOT EXISTS "ar_application_tenantId_idx"          ON "ar_application"("tenantId");
CREATE INDEX IF NOT EXISTS "ap_open_item_tenantId_idx"            ON "ap_open_item"("tenantId");
CREATE INDEX IF NOT EXISTS "ap_application_tenantId_idx"          ON "ap_application"("tenantId");
CREATE INDEX IF NOT EXISTS "fixed_asset_tenantId_idx"             ON "fixed_asset"("tenantId");
CREATE INDEX IF NOT EXISTS "lease_tenantId_idx"                   ON "lease"("tenantId");
CREATE INDEX IF NOT EXISTS "revenue_contract_tenantId_idx"        ON "revenue_contract"("tenantId");
CREATE INDEX IF NOT EXISTS "queue_tenantId_idx"                   ON "queue"("tenantId");
CREATE INDEX IF NOT EXISTS "record_event_tenantId_occurredAt_idx" ON "record_event"("tenantId", "occurredAt");
CREATE INDEX IF NOT EXISTS "audit_log_tenantId_occurredAt_idx"    ON "audit_log"("tenantId", "occurredAt");
CREATE INDEX IF NOT EXISTS "reassignment_rule_tenantId_idx"       ON "reassignment_rule"("tenantId");
CREATE INDEX IF NOT EXISTS "notification_tenantId_createdAt_idx"  ON "notification"("tenantId", "createdAt");

-- ─── Backfill: create default tenant + memberships ─────────────────────────
--
-- We need an owner user. If there are no users yet, the schema is fine —
-- new signups via Clerk will create users + onboard tenants. We only need
-- to create the default tenant when at least one User exists.

DO $$
DECLARE
  owner_user_id UUID;
  default_tenant_id UUID;
BEGIN
  -- Pick the first active user (deterministic by createdAt) as default owner.
  SELECT id INTO owner_user_id
  FROM "app_user"
  WHERE "isActive" = true
  ORDER BY "createdAt" ASC
  LIMIT 1;

  IF owner_user_id IS NULL THEN
    RAISE NOTICE 'No users found — skipping default tenant creation. New signups will create tenants.';
    RETURN;
  END IF;

  -- Create the default tenant if not already present.
  SELECT id INTO default_tenant_id
  FROM "tenant"
  WHERE slug = 'default';

  IF default_tenant_id IS NULL THEN
    INSERT INTO "tenant" ("slug", "name", "ownerUserId", "createdAt", "updatedAt")
    VALUES ('default', 'Default Tenant', owner_user_id, NOW(), NOW())
    RETURNING id INTO default_tenant_id;
    RAISE NOTICE 'Created default tenant: %', default_tenant_id;
  END IF;

  -- Give every existing User a membership in the default tenant.
  -- The first user becomes OWNER; everyone else becomes MEMBER (humans
  -- can promote later via the admin UI).
  INSERT INTO "tenant_membership" ("tenantId", "userId", "role", "createdAt")
  SELECT
    default_tenant_id,
    u.id,
    CASE WHEN u.id = owner_user_id THEN 'OWNER'::"TenantRole" ELSE 'MEMBER'::"TenantRole" END,
    NOW()
  FROM "app_user" u
  ON CONFLICT ("tenantId", "userId") DO NOTHING;

  -- Backfill tenantId on every tenant-scoped table.
  UPDATE "legal_entity"            SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "fiscal_calendar"         SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "period"                  SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "period_close"            SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "party"                   SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "party_role"              SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "item"                    SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "account"                 SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "gl_entry_header"         SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "gl_entry_line"           SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "dimension"               SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "dimension_value"         SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "dimension_set"           SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "posting_rule"            SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "custom_field_definition" SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "ar_open_item"            SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "ar_application"          SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "ap_open_item"            SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "ap_application"          SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "fixed_asset"             SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "lease"                   SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "revenue_contract"        SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "queue"                   SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "record_event"            SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "audit_log"               SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "reassignment_rule"       SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "notification"            SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;

  RAISE NOTICE 'Backfilled all tenant-scoped rows to default tenant: %', default_tenant_id;
END $$;
