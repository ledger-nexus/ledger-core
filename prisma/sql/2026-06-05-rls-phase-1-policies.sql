-- RLS Phase 1 — define policies without FORCING.
--
-- See docs/architecture/rls-design.md for the full design.
--
-- This migration is SAFE to apply in production. It ENABLES RLS +
-- DEFINES per-table policies but does NOT `FORCE` them — the table
-- owner (Neon connection role) continues to bypass the policies, so
-- application behavior is unchanged.
--
-- Phase 2 (separate PR) adds Prisma SET LOCAL integration.
-- Phase 3 (separate PR) runs ALTER TABLE ... FORCE ROW LEVEL SECURITY
-- which is the real switch + ships the cross-tenant test suite.
--
-- Idempotency: every statement is wrapped in DO blocks + IF NOT EXISTS
-- guards. Safe to re-run.
--
-- Apply via:
--   npx prisma db execute --file prisma/sql/2026-06-05-rls-phase-1-policies.sql --schema prisma/schema.prisma

-- =============================================================================
-- Policy helper — extract current tenant from session GUC
-- =============================================================================
--
-- current_setting('app.current_tenant_id', true):
--   - missing_ok = true → returns NULL if GUC unset (vs ERROR)
--   - NULL cast to uuid → NULL; policy clause `tenantId = NULL` → FALSE
--   - Fails closed: unconfigured connection sees 0 rows
--
-- All policies below use this expression. Centralized as a SQL function
-- so a future change (e.g., audit-logging the access) lands in one place.

CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid $$;

COMMENT ON FUNCTION app_current_tenant_id() IS
  'Returns the current session tenant from app.current_tenant_id GUC, or NULL if unset. '
  'Used by RLS policies to scope visible rows. Phase 1 of RLS rollout — see docs/architecture/rls-design.md.';

-- =============================================================================
-- Direct-tenantId tables (NOT NULL tenantId column)
-- =============================================================================
--
-- Each table gets:
--   1. ENABLE RLS (allows policies to apply)
--   2. CREATE POLICY <name>_tenant_isolation (the actual rule)
--
-- Naming: <table>_tenant_isolation
-- Operation: FOR ALL (SELECT/INSERT/UPDATE/DELETE — same rule on all)
-- USING: read scope ("which rows can I see")
-- WITH CHECK: write scope ("which rows can I create/update to")
--
-- Phase 1 does NOT issue FORCE — table owner (Neon connection role)
-- bypasses these policies. Production behavior is unchanged. The
-- policies are auditable + ready for Phase 3 FORCE.

-- 1. tenant — self-referential
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_tenant_isolation ON tenant;
CREATE POLICY tenant_tenant_isolation ON tenant
  FOR ALL
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

-- 2. tenant_membership
ALTER TABLE tenant_membership ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_membership_tenant_isolation ON tenant_membership;
CREATE POLICY tenant_membership_tenant_isolation ON tenant_membership
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 3. tenant_api_token
ALTER TABLE tenant_api_token ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_api_token_tenant_isolation ON tenant_api_token;
CREATE POLICY tenant_api_token_tenant_isolation ON tenant_api_token
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 4. legal_entity
ALTER TABLE legal_entity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_entity_tenant_isolation ON legal_entity;
CREATE POLICY legal_entity_tenant_isolation ON legal_entity
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 5. fiscal_calendar
ALTER TABLE fiscal_calendar ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiscal_calendar_tenant_isolation ON fiscal_calendar;
CREATE POLICY fiscal_calendar_tenant_isolation ON fiscal_calendar
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 6. period
ALTER TABLE period ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS period_tenant_isolation ON period;
CREATE POLICY period_tenant_isolation ON period
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 7. period_close
ALTER TABLE period_close ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS period_close_tenant_isolation ON period_close;
CREATE POLICY period_close_tenant_isolation ON period_close
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 8. party
ALTER TABLE party ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS party_tenant_isolation ON party;
CREATE POLICY party_tenant_isolation ON party
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 9. party_role
ALTER TABLE party_role ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS party_role_tenant_isolation ON party_role;
CREATE POLICY party_role_tenant_isolation ON party_role
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 10. item
ALTER TABLE item ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS item_tenant_isolation ON item;
CREATE POLICY item_tenant_isolation ON item
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 11. account
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_tenant_isolation ON account;
CREATE POLICY account_tenant_isolation ON account
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 12. gl_entry_header
ALTER TABLE gl_entry_header ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gl_entry_header_tenant_isolation ON gl_entry_header;
CREATE POLICY gl_entry_header_tenant_isolation ON gl_entry_header
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 13. gl_entry_line (tenantId denormalized to line)
ALTER TABLE gl_entry_line ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gl_entry_line_tenant_isolation ON gl_entry_line;
CREATE POLICY gl_entry_line_tenant_isolation ON gl_entry_line
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 14. journal_entry_note
ALTER TABLE journal_entry_note ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS journal_entry_note_tenant_isolation ON journal_entry_note;
CREATE POLICY journal_entry_note_tenant_isolation ON journal_entry_note
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 15. recurring_entry
ALTER TABLE recurring_entry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recurring_entry_tenant_isolation ON recurring_entry;
CREATE POLICY recurring_entry_tenant_isolation ON recurring_entry
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 16. dimension
ALTER TABLE dimension ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dimension_tenant_isolation ON dimension;
CREATE POLICY dimension_tenant_isolation ON dimension
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 17. dimension_value
ALTER TABLE dimension_value ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dimension_value_tenant_isolation ON dimension_value;
CREATE POLICY dimension_value_tenant_isolation ON dimension_value
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 18. dimension_set
ALTER TABLE dimension_set ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dimension_set_tenant_isolation ON dimension_set;
CREATE POLICY dimension_set_tenant_isolation ON dimension_set
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 19. posting_rule
ALTER TABLE posting_rule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS posting_rule_tenant_isolation ON posting_rule;
CREATE POLICY posting_rule_tenant_isolation ON posting_rule
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 20. custom_field_definition
ALTER TABLE custom_field_definition ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_field_definition_tenant_isolation ON custom_field_definition;
CREATE POLICY custom_field_definition_tenant_isolation ON custom_field_definition
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 21. ar_open_item
ALTER TABLE ar_open_item ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ar_open_item_tenant_isolation ON ar_open_item;
CREATE POLICY ar_open_item_tenant_isolation ON ar_open_item
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 22. ar_application
ALTER TABLE ar_application ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ar_application_tenant_isolation ON ar_application;
CREATE POLICY ar_application_tenant_isolation ON ar_application
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 23. ap_open_item
ALTER TABLE ap_open_item ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ap_open_item_tenant_isolation ON ap_open_item;
CREATE POLICY ap_open_item_tenant_isolation ON ap_open_item
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 24. ap_application
ALTER TABLE ap_application ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ap_application_tenant_isolation ON ap_application;
CREATE POLICY ap_application_tenant_isolation ON ap_application
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 25. fixed_asset
ALTER TABLE fixed_asset ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fixed_asset_tenant_isolation ON fixed_asset;
CREATE POLICY fixed_asset_tenant_isolation ON fixed_asset
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 26. lease
ALTER TABLE lease ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_tenant_isolation ON lease;
CREATE POLICY lease_tenant_isolation ON lease
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 27. revenue_contract
ALTER TABLE revenue_contract ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS revenue_contract_tenant_isolation ON revenue_contract;
CREATE POLICY revenue_contract_tenant_isolation ON revenue_contract
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 28. queue
ALTER TABLE queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS queue_tenant_isolation ON queue;
CREATE POLICY queue_tenant_isolation ON queue
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 29. record_event
ALTER TABLE record_event ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS record_event_tenant_isolation ON record_event;
CREATE POLICY record_event_tenant_isolation ON record_event
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 30. reassignment_rule
ALTER TABLE reassignment_rule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reassignment_rule_tenant_isolation ON reassignment_rule;
CREATE POLICY reassignment_rule_tenant_isolation ON reassignment_rule
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 31. notification
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_tenant_isolation ON notification;
CREATE POLICY notification_tenant_isolation ON notification
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 32. audit_log — SPECIAL: tenantId is nullable for pre-identity events
--     (TOKEN_REJECTED before auth resolves the actor's tenant).
--     Policy allows access when tenantId IS NULL OR matches current tenant.
--     Justified: audit_log is append-only (Postgres RULE), so a cross-tenant
--     WRITE isn't possible. The cross-tenant READ is the only concern; this
--     row admits NULL-tenant events for everyone (treated as portfolio-wide
--     observability events).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  FOR ALL
  USING ("tenantId" IS NULL OR "tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" IS NULL OR "tenantId" = app_current_tenant_id());

-- =============================================================================
-- Child tables (RLS via parent's tenantId)
-- =============================================================================
--
-- These tables don't have a tenantId column directly; their tenancy comes
-- from a FK to a parent table. Policy uses an EXISTS subquery against the
-- parent.
--
-- Performance note: each child query incurs an extra index lookup on the
-- parent's tenantId. The parent's tenantId index is already there
-- (Phase 4b multi-tenancy work), so the overhead is minimal.

-- 33. fixed_asset_book_attributes — via fixed_asset
ALTER TABLE fixed_asset_book_attributes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fixed_asset_book_attributes_tenant_isolation ON fixed_asset_book_attributes;
CREATE POLICY fixed_asset_book_attributes_tenant_isolation ON fixed_asset_book_attributes
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM fixed_asset
    WHERE fixed_asset.id = fixed_asset_book_attributes."assetId"
      AND fixed_asset."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM fixed_asset
    WHERE fixed_asset.id = fixed_asset_book_attributes."assetId"
      AND fixed_asset."tenantId" = app_current_tenant_id()
  ));

-- 34. lease_book_attributes — via lease
ALTER TABLE lease_book_attributes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_book_attributes_tenant_isolation ON lease_book_attributes;
CREATE POLICY lease_book_attributes_tenant_isolation ON lease_book_attributes
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM lease
    WHERE lease.id = lease_book_attributes."leaseId"
      AND lease."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM lease
    WHERE lease.id = lease_book_attributes."leaseId"
      AND lease."tenantId" = app_current_tenant_id()
  ));

-- 35. revenue_contract_book_attributes — via revenue_contract
ALTER TABLE revenue_contract_book_attributes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS revenue_contract_book_attributes_tenant_isolation ON revenue_contract_book_attributes;
CREATE POLICY revenue_contract_book_attributes_tenant_isolation ON revenue_contract_book_attributes
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM revenue_contract
    WHERE revenue_contract.id = revenue_contract_book_attributes."contractId"
      AND revenue_contract."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM revenue_contract
    WHERE revenue_contract.id = revenue_contract_book_attributes."contractId"
      AND revenue_contract."tenantId" = app_current_tenant_id()
  ));

-- 36. performance_obligation — via revenue_contract
ALTER TABLE performance_obligation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS performance_obligation_tenant_isolation ON performance_obligation;
CREATE POLICY performance_obligation_tenant_isolation ON performance_obligation
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM revenue_contract
    WHERE revenue_contract.id = performance_obligation."contractId"
      AND revenue_contract."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM revenue_contract
    WHERE revenue_contract.id = performance_obligation."contractId"
      AND revenue_contract."tenantId" = app_current_tenant_id()
  ));

-- 37. recurring_entry_line — via recurring_entry
ALTER TABLE recurring_entry_line ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recurring_entry_line_tenant_isolation ON recurring_entry_line;
CREATE POLICY recurring_entry_line_tenant_isolation ON recurring_entry_line
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM recurring_entry
    WHERE recurring_entry.id = recurring_entry_line."templateId"
      AND recurring_entry."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM recurring_entry
    WHERE recurring_entry.id = recurring_entry_line."templateId"
      AND recurring_entry."tenantId" = app_current_tenant_id()
  ));

-- 38. dimension_set_value — via dimension_set
ALTER TABLE dimension_set_value ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dimension_set_value_tenant_isolation ON dimension_set_value;
CREATE POLICY dimension_set_value_tenant_isolation ON dimension_set_value
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM dimension_set
    WHERE dimension_set.id = dimension_set_value."dimensionSetId"
      AND dimension_set."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM dimension_set
    WHERE dimension_set.id = dimension_set_value."dimensionSetId"
      AND dimension_set."tenantId" = app_current_tenant_id()
  ));

-- 39. queue_member — via queue
ALTER TABLE queue_member ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS queue_member_tenant_isolation ON queue_member;
CREATE POLICY queue_member_tenant_isolation ON queue_member
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM queue
    WHERE queue.id = queue_member."queueId"
      AND queue."tenantId" = app_current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM queue
    WHERE queue.id = queue_member."queueId"
      AND queue."tenantId" = app_current_tenant_id()
  ));


-- =============================================================================
-- Tables added after the June 2026 chain (close management, flux,
-- reconciliations, notification channels) — appended at graft time
-- (2026-07-15) so Phase 1 covers the FULL current schema. All carry a
-- direct NOT NULL tenantId column; standard clause applies.
-- =============================================================================

-- 40. close_task
ALTER TABLE close_task ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS close_task_tenant_isolation ON close_task;
CREATE POLICY close_task_tenant_isolation ON close_task
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 41. close_task_template
ALTER TABLE close_task_template ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS close_task_template_tenant_isolation ON close_task_template;
CREATE POLICY close_task_template_tenant_isolation ON close_task_template
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 42. close_task_comment
ALTER TABLE close_task_comment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS close_task_comment_tenant_isolation ON close_task_comment;
CREATE POLICY close_task_comment_tenant_isolation ON close_task_comment
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 43. close_task_state_change
ALTER TABLE close_task_state_change ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS close_task_state_change_tenant_isolation ON close_task_state_change;
CREATE POLICY close_task_state_change_tenant_isolation ON close_task_state_change
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 44. flux_statement
ALTER TABLE flux_statement ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flux_statement_tenant_isolation ON flux_statement;
CREATE POLICY flux_statement_tenant_isolation ON flux_statement
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 45. flux_line
ALTER TABLE flux_line ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flux_line_tenant_isolation ON flux_line;
CREATE POLICY flux_line_tenant_isolation ON flux_line
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 46. reconciliation
ALTER TABLE reconciliation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconciliation_tenant_isolation ON reconciliation;
CREATE POLICY reconciliation_tenant_isolation ON reconciliation
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 47. reconciliation_attachment
ALTER TABLE reconciliation_attachment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconciliation_attachment_tenant_isolation ON reconciliation_attachment;
CREATE POLICY reconciliation_attachment_tenant_isolation ON reconciliation_attachment
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 48. reconciliation_config
ALTER TABLE reconciliation_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconciliation_config_tenant_isolation ON reconciliation_config;
CREATE POLICY reconciliation_config_tenant_isolation ON reconciliation_config
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 49. notification_channel
ALTER TABLE notification_channel ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_channel_tenant_isolation ON notification_channel;
CREATE POLICY notification_channel_tenant_isolation ON notification_channel
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- 50. notification_dispatch
ALTER TABLE notification_dispatch ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_dispatch_tenant_isolation ON notification_dispatch;
CREATE POLICY notification_dispatch_tenant_isolation ON notification_dispatch
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());

-- =============================================================================
-- Verification
-- =============================================================================
--
-- After applying, verify with:
--
--   SELECT schemaname, tablename, rowsecurity, forcerowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public'
--     AND rowsecurity = true
--   ORDER BY tablename;
--
-- Expected: 50 rows, all with rowsecurity=t + forcerowsecurity=f (Phase 1
-- defines but does not FORCE).
--
-- Policy listing:
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public'
--   ORDER BY tablename, policyname;
--
-- Expected: 50 rows, all named <table>_tenant_isolation.

-- End of Phase 1 migration.
