-- RLS Phase 3 — flip ALL tenant-scoped tables to FORCE ROW LEVEL SECURITY.
--
-- Status: NOT YET APPLIED. This migration is the load-bearing flip. After
-- it runs, queries without `app.current_tenant_id` GUC set return 0 rows
-- from every tenant-scoped table (fail-closed).
--
-- Prerequisites (all must be merged + verified GREEN in CI before this
-- migration runs):
--   - PR #66: Phase 1 policies (39 per-table policies on tenant-scoped tables)
--   - PR #67: Phase 2a withTenantContext helper
--   - PRs #69-#83: Phase 2b call-site sweep (23 sites)
--   - PRs #85, #86: Phase 3 decisions A + B
--   - PR #88: deficiency #28 fix (createFixedAsset tenant scope)
--   - PR #87: deficiency log v2.4
--   - Operator ack on docs/runbooks/rls-phase-3-bypass-roles.md
--   - Cross-tenant test suite green in BOTH modes (advisory + FORCE)
--
-- Rollback: per-table `ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY;`
-- preserves the policies (they revert to advisory). NEVER drop the
-- policies as a rollback step — they're independent of the FORCE flag.
--
-- See: docs/architecture/rls-phase-3-design.md
--
-- ────────────────────────────────────────────────────────────────────
-- Direct-tenantId tables (have a `tenantId` column directly)
-- ────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE "legal_entity" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_membership" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_api_token" FORCE ROW LEVEL SECURITY;
ALTER TABLE "fiscal_calendar" FORCE ROW LEVEL SECURITY;
ALTER TABLE "period" FORCE ROW LEVEL SECURITY;
ALTER TABLE "period_close" FORCE ROW LEVEL SECURITY;
ALTER TABLE "party" FORCE ROW LEVEL SECURITY;
ALTER TABLE "party_role" FORCE ROW LEVEL SECURITY;
ALTER TABLE "item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "account" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gl_entry_header" FORCE ROW LEVEL SECURITY;  -- JournalEntry
ALTER TABLE "gl_entry_line" FORCE ROW LEVEL SECURITY;    -- JournalLine
ALTER TABLE "journal_entry_note" FORCE ROW LEVEL SECURITY;
ALTER TABLE "recurring_entry" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dimension" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dimension_value" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dimension_set" FORCE ROW LEVEL SECURITY;
ALTER TABLE "posting_rule" FORCE ROW LEVEL SECURITY;
ALTER TABLE "custom_field_definition" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ar_open_item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ar_application" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ap_open_item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ap_application" FORCE ROW LEVEL SECURITY;
ALTER TABLE "fixed_asset" FORCE ROW LEVEL SECURITY;
ALTER TABLE "lease" FORCE ROW LEVEL SECURITY;
ALTER TABLE "revenue_contract" FORCE ROW LEVEL SECURITY;
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;
ALTER TABLE "queue" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reassignment_rule" FORCE ROW LEVEL SECURITY;
ALTER TABLE "record_event" FORCE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────
-- Child tables (tenancy via parent FK; policy uses EXISTS in Phase 1)
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE "recurring_entry_line" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dimension_set_value" FORCE ROW LEVEL SECURITY;
ALTER TABLE "fixed_asset_book_attributes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "lease_book_attributes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "performance_obligation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "revenue_contract_book_attributes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "queue_member" FORCE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────
-- INTENTIONALLY EXCLUDED — DO NOT add to FORCE list
-- ────────────────────────────────────────────────────────────────────
--
-- "tenant"               — the tenants table itself; admin/operator surface
-- "book"                 — shared global (code-keyed; not per-tenant)
-- "currency"             — shared global
-- "fx_rate"              — shared global
-- "app_user"             — shared global (users span tenants)
-- "audit_log"            — intentionally excluded for pre-identity
--                          TOKEN_REJECTED audit events; per memory
--                          "audit_log has nullable tenantId by design"
--
-- ────────────────────────────────────────────────────────────────────
-- Verification queries (operator runs these manually post-migration)
-- ────────────────────────────────────────────────────────────────────
--
-- 1. Confirm every tenant-scoped table is now FORCED:
--      SELECT relname, relrowsecurity, relforcerowsecurity
--      FROM pg_class
--      WHERE relkind = 'r'
--        AND relnamespace = 'public'::regnamespace
--        AND relrowsecurity = true
--      ORDER BY relname;
--    Expected: every direct-tenantId + child table from this file shows
--    relrowsecurity=true AND relforcerowsecurity=true. The 6 excluded
--    tables show relrowsecurity=false (Phase 1 never enabled them).
--
-- 2. Confirm policies are present and unchanged:
--      SELECT schemaname, tablename, policyname
--      FROM pg_policies
--      WHERE schemaname = 'public'
--      ORDER BY tablename, policyname;
--    Expected: 39 Phase-1 policies still present. The FORCE flag is
--    separate from policy definitions.
--
-- 3. Smoke-test the audit-log isn't filtered:
--      SET app.current_tenant_id = NULL;
--      SELECT COUNT(*) FROM audit_log;
--    Expected: non-zero — audit_log is intentionally exempt from RLS.
--
-- 4. Smoke-test a tenant-scoped table IS filtered:
--      SET app.current_tenant_id = NULL;
--      SELECT COUNT(*) FROM legal_entity;
--    Expected: 0 — RLS blocks the read.

COMMIT;
