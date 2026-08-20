-- Saved views — a named, reusable filter state per surface.
--
-- The row stores the QUERY STRING, not a JSON config. See the model comment
-- in schema.prisma: once every surface round-trips its state through the URL
-- (src/lib/url-state.ts), a saved view is that string, and a string cannot
-- disagree with what the surface parses because the surface's own spec reads
-- it back.

CREATE TABLE IF NOT EXISTS "saved_view" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"  UUID         NOT NULL,
  "surface"   TEXT         NOT NULL,
  "name"      TEXT         NOT NULL,
  "ownerId"   UUID         NOT NULL,
  "shared"    BOOLEAN      NOT NULL DEFAULT false,
  "query"     TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saved_view_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "saved_view"
  DROP CONSTRAINT IF EXISTS "saved_view_tenantId_fkey";
ALTER TABLE "saved_view"
  ADD CONSTRAINT "saved_view_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Owner cascade: deleting a user removes their private views rather than
-- leaving rows whose owner cannot be resolved.
ALTER TABLE "saved_view"
  DROP CONSTRAINT IF EXISTS "saved_view_ownerId_fkey";
ALTER TABLE "saved_view"
  ADD CONSTRAINT "saved_view_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Re-saving a name REPLACES that view rather than creating a duplicate label.
-- Scoped per owner so two people may each keep a view called "My Q2".
CREATE UNIQUE INDEX IF NOT EXISTS "saved_view_tenantId_surface_ownerId_name_key"
  ON "saved_view" ("tenantId", "surface", "ownerId", "name");

CREATE INDEX IF NOT EXISTS "saved_view_tenantId_surface_idx"
  ON "saved_view" ("tenantId", "surface");

-- RLS Phase 1 parity: every tenant-scoped table carries a policy, even though
-- nothing is FORCED yet (deficiency #12). Six existing tables were found
-- missing this on 2026-08-08; tests/rls-policy-coverage.test.ts now fails if a
-- new one skips it, which is how this block got written before the table did.
ALTER TABLE "saved_view" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_view_tenant_isolation ON "saved_view";
CREATE POLICY saved_view_tenant_isolation ON "saved_view"
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());
