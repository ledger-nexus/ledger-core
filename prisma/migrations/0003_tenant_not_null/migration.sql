-- Multi-tenancy Phase 4b (reduced): NOT NULL on tenantId everywhere.
--
-- The Phase 1 migration added tenantId as NULLABLE so writes could
-- continue without immediate caller updates. Phase 4a wired the
-- substrate to populate tenantId on every new row. Now that all
-- existing data is backfilled (verified by scripts/check-null-tenants.ts),
-- we can apply NOT NULL.
--
-- What this migration does NOT do (deferred):
--   - Change LegalEntity.code @unique → @@unique([tenantId, code])
--   - Change JournalEntry.entryNumber @unique → @@unique([tenantId, ...])
--   - Change Dimension.code / DimensionSet.hash / Queue.code uniques
-- These cascade-force ~22 entity-by-code lookup sites to update.
-- We land them as a focused commit when customer #2 onboards.
-- Until then, codes are globally unique by transitive entity uniqueness;
-- a single-tenant world has the same constraint regardless.
--
-- Idempotency: ALTER COLUMN ... SET NOT NULL is idempotent — running
-- on an already-NOT-NULL column is a no-op (no error).
-- If any row still has NULL tenantId, this migration WILL FAIL with
-- "column ... contains null values". Run scripts/backfill-null-tenants.ts
-- first if so.

ALTER TABLE "legal_entity"            ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "fiscal_calendar"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "period"                  ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "period_close"            ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "party"                   ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "party_role"              ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "item"                    ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "account"                 ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "gl_entry_header"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "gl_entry_line"           ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "dimension"               ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "dimension_value"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "dimension_set"           ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "posting_rule"            ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "custom_field_definition" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ar_open_item"            ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ar_application"          ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ap_open_item"            ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ap_application"          ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "fixed_asset"             ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "lease"                   ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "revenue_contract"        ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "queue"                   ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "record_event"            ALTER COLUMN "tenantId" SET NOT NULL;
-- audit_log INTENTIONALLY stays nullable: pre-identity rejections
-- (TOKEN_REJECTED with garbage Bearer, missing Bearer) have no tenant
-- context at write time. The log row records WHY auth failed; a
-- platform-level event with no tenant attribution is the correct shape.
-- Tenant-scoped audit rows (PRIVILEGED_ACTION, JE posts, exports)
-- DO populate tenantId via the application layer.
-- ALTER TABLE "audit_log"               ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "reassignment_rule"       ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "notification"            ALTER COLUMN "tenantId" SET NOT NULL;
