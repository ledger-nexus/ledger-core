-- Append-only period-reopen history.
--
-- PeriodClose is binary (row present = closed), so deleting it on reopen loses
-- the fact that a period was reopened and why. period_reopen_log records each
-- reopen as an immutable fact: tenant/entity/book/period + REQUIRED reason +
-- who + when. Columns are denormalized (codes, reopenedBy email) so a row
-- survives deletion of its parent period/entity — same survival rationale as
-- audit_log.actorEmail. Tamper-evident capture also lives in audit_log
-- (DB-RULE append-only); this table is the queryable domain projection.
--
-- Plain table, Prisma-expressible → CI/test create it from schema.prisma; this
-- file gives migrate-deploy (prod) the identical change. NOT migration-mirror
-- DDL. Insert-only by application convention (no update/delete code paths); a
-- future hardening could add audit_log-style no-UPDATE/no-DELETE RULEs, deferred
-- here to avoid the test-cleanup rule-suspension dance.
--
-- Rollback: DROP TABLE IF EXISTS "period_reopen_log";

CREATE TABLE IF NOT EXISTS "period_reopen_log" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"   UUID NOT NULL,
  "entityId"   UUID NOT NULL,
  "bookId"     UUID NOT NULL,
  "entityCode" TEXT NOT NULL,
  "bookCode"   TEXT NOT NULL,
  "periodCode" TEXT NOT NULL,
  "reason"     TEXT NOT NULL,
  "reopenedBy" TEXT,
  "reopenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "period_reopen_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "period_reopen_log_tenantId_idx"
  ON "period_reopen_log" ("tenantId");
CREATE INDEX IF NOT EXISTS "period_reopen_log_entityId_bookId_periodCode_idx"
  ON "period_reopen_log" ("entityId", "bookId", "periodCode");
