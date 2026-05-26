-- Phase 4b: drop the last five GLOBAL @unique constraints on code-like
-- columns and replace them with composite [tenantId, X] uniques. Each
-- tenant now owns its own code namespace — two tenants can both have
-- entity "ACME", queue "AR_COLLECTIONS", dimension "CLASS", journal
-- entry "ACME-US_GAAP-00001", or an identical dimension-set hash
-- without colliding.
--
-- This is the constraint that the Phase 4a migration explicitly
-- deferred (see 0003_tenant_not_null/migration.sql header). We land it
-- now because the call sites are still a manageable set; deferring
-- past customer #2 onboarding would multiply the surface area.
--
-- Safety: in a single-tenant world (default tenant only), [tenantId, X]
-- and X global uniqueness are equivalent — no existing row violates
-- the new constraint. The migration is reversible by reapplying the
-- old global unique (no data loss).
--
-- What each block does:
--   DROP CONSTRAINT  ...  -- removes the old single-column unique index
--   CREATE UNIQUE INDEX ... -- adds the composite

-- ─── LegalEntity.code ────────────────────────────────────────────────
ALTER TABLE "legal_entity" DROP CONSTRAINT IF EXISTS "legal_entity_code_key";
CREATE UNIQUE INDEX "legal_entity_tenantId_code_key" ON "legal_entity"("tenantId", "code");

-- ─── JournalEntry.entryNumber ────────────────────────────────────────
ALTER TABLE "gl_entry_header" DROP CONSTRAINT IF EXISTS "gl_entry_header_entryNumber_key";
CREATE UNIQUE INDEX "gl_entry_header_tenantId_entryNumber_key" ON "gl_entry_header"("tenantId", "entryNumber");

-- ─── Dimension.code ──────────────────────────────────────────────────
ALTER TABLE "dimension" DROP CONSTRAINT IF EXISTS "dimension_code_key";
CREATE UNIQUE INDEX "dimension_tenantId_code_key" ON "dimension"("tenantId", "code");

-- ─── DimensionSet.hash ───────────────────────────────────────────────
ALTER TABLE "dimension_set" DROP CONSTRAINT IF EXISTS "dimension_set_hash_key";
CREATE UNIQUE INDEX "dimension_set_tenantId_hash_key" ON "dimension_set"("tenantId", "hash");

-- ─── Queue.code ──────────────────────────────────────────────────────
ALTER TABLE "queue" DROP CONSTRAINT IF EXISTS "queue_code_key";
CREATE UNIQUE INDEX "queue_tenantId_code_key" ON "queue"("tenantId", "code");
