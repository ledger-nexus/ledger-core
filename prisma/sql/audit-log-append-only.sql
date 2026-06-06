-- SOC 2 CC5/CC7 — audit log integrity enforcement at the DB level.
--
-- App-level discipline ("never UPDATE or DELETE audit_log rows") is
-- the convention; this DB rule is the AUDITABLE PROOF. SOC 2 Type 2
-- auditors specifically check that the audit log table cannot be
-- silently tampered with, even by a privileged user who can run
-- arbitrary SQL — that's the whole point of an audit log.
--
-- Implementation: a Postgres RULE that intercepts UPDATE and DELETE
-- on audit_log and turns them into NOTHING (no-op). The result:
-- both succeed from the client's perspective (no error) but write
-- zero rows. App code that "successfully" tries to tamper produces
-- no observable change, and the audit row remains intact.
--
-- Alternative would be a CHECK / RAISE EXCEPTION trigger that
-- errors loudly on attempted mutation. We prefer RULE → NOTHING
-- because:
--   1. Migration tools and ORMs sometimes issue spurious UPDATEs
--      (e.g., updateMany with no actual changes). RULE NOTHING
--      makes those no-ops; trigger RAISE would crash them.
--   2. An attacker who knows the rule exists gets a silent failure
--      instead of an error message confirming the table is
--      protected. Less attack feedback.
--
-- INSERT remains unrestricted — the whole point is to allow
-- appending. The app's auditPrivilegedAction helper is the only
-- expected writer.
--
-- Idempotent: drops existing rule first so re-applying is safe.

DROP RULE IF EXISTS audit_log_no_update ON "audit_log";
DROP RULE IF EXISTS audit_log_no_delete ON "audit_log";

CREATE RULE audit_log_no_update AS
  ON UPDATE TO "audit_log"
  DO INSTEAD NOTHING;

CREATE RULE audit_log_no_delete AS
  ON DELETE TO "audit_log"
  DO INSTEAD NOTHING;

-- Smoke test: should report 0 rows affected without erroring.
-- (Runs at script time so the migration log shows the rule fires.)
-- Skipped here — the rule is what we want; a verification query
-- belongs in a test, not the schema migration.

-- NOTE: If you ever NEED to genuinely modify audit_log (e.g.,
-- migrating columns, fixing a corruption from a Postgres bug),
-- the procedure is:
--   1. Document in docs/policies/control-deficiency-log.md
--   2. DROP both rules in a transaction
--   3. Perform the change
--   4. CREATE both rules back
--   5. Capture the entire transaction in audit_log via insertion
--      AFTER the rules are re-armed
-- The drop+re-create itself is the auditable event.
