-- Report Builder — Phase 1 schema (deficiency-free; PR 1 of arc).
--
-- Adds report_template, the persistence shape for user-saved + system-
-- default report templates. System templates (the 4 GAAP financial
-- statements) seed lazily per tenant via seedSystemTemplates helper.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, indexes IF NOT EXISTS.
-- Re-runs are no-op.
--
-- See docs/report-builder-design.md for the full design.

CREATE TABLE IF NOT EXISTS "report_template" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"   UUID         NOT NULL,
  "code"       TEXT         NOT NULL,
  "name"       TEXT         NOT NULL,
  "isSystem"   BOOLEAN      NOT NULL DEFAULT FALSE,
  "definition" JSONB        NOT NULL,
  "version"    INTEGER      NOT NULL DEFAULT 1,
  "createdBy"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "report_template_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE
);

-- Composite unique: a template code is unique per tenant (different
-- tenants can each have their own "IS" / "BS" / etc.). The same tenant
-- cannot have two templates at the same code — clones must use a new
-- code (e.g. "IS-MY-CUSTOM").
CREATE UNIQUE INDEX IF NOT EXISTS "report_template_tenantId_code_key"
  ON "report_template" ("tenantId", "code");

-- Tenant scan support — every query filters by tenantId.
CREATE INDEX IF NOT EXISTS "report_template_tenantId_idx"
  ON "report_template" ("tenantId");
