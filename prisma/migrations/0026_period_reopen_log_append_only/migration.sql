-- period_reopen_log append-only enforcement (SOC 2 CC5/CC7.2).
--
-- period_reopen_log (migration 0025) records every period reopen as an
-- immutable fact — who / when / reason. App discipline is insert-only; these
-- RULEs are the AUDITABLE PROOF that the reopen history cannot be silently
-- edited, even by a privileged user running arbitrary SQL. Same RULE→NOTHING
-- mechanism as audit_log (0015): UPDATE and DELETE become silent no-ops;
-- INSERT stays unrestricted (appending is the whole point).
--
-- RULEs are not Prisma-expressible, so `db push` (CI / db:reset) never creates
-- them — the identical block also lives in prisma/sql/migration-mirror.sql
-- (section 7), which db:restore-ddl and CI apply. This numbered migration is
-- the migrate-deploy (prod) path. Keep the two in sync, plus the
-- withPeriodReopenLogMutable re-arm statements in
-- tests/_helpers/audit-log-cleanup.ts.
--
-- Idempotent: drops existing rules first so re-applying is safe.
-- Rollback:
--   DROP RULE IF EXISTS period_reopen_log_no_update ON "period_reopen_log";
--   DROP RULE IF EXISTS period_reopen_log_no_delete ON "period_reopen_log";

DROP RULE IF EXISTS period_reopen_log_no_update ON "period_reopen_log";
DROP RULE IF EXISTS period_reopen_log_no_delete ON "period_reopen_log";

CREATE RULE period_reopen_log_no_update AS
  ON UPDATE TO "period_reopen_log"
  DO INSTEAD NOTHING;

CREATE RULE period_reopen_log_no_delete AS
  ON DELETE TO "period_reopen_log"
  DO INSTEAD NOTHING;
