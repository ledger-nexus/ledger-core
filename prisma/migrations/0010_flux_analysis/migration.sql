-- BlackLine arc — Phase 3 PR 1: Flux / Variance Analysis.
--
-- Models the controller's period-over-period delta scan: for each
-- account, freeze the prior-period + current-period balances at
-- generation time, compute delta + %, flag material lines, force
-- commentary on those before the period close packet ships.
--
-- Tables:
--   * flux_statement — one per (entity, book, fromPeriod, toPeriod).
--                      Carries the threshold config + status. Lines
--                      are regenerated on demand by getFluxAnalysis
--                      (Phase 3 PR 2); commentary lives on the lines.
--                      @@unique([entityId, bookId, fromPeriodId,
--                                toPeriodId]) so re-running is
--                      idempotent.
--   * flux_line      — one per Account in the statement. Frozen
--                      priorAmount, currentAmount, deltaAmount,
--                      deltaPercent. Cascade-delete from statement.
--
-- Enums:
--   * FluxStatementStatus — DRAFT | FINALIZED
--   * FluxLineStatus      — IMMATERIAL | NEEDS_COMMENT | EXPLAINED |
--                           WAIVED
--
-- Idempotent: DO blocks for the enums, IF NOT EXISTS on tables +
-- indexes. Rollback = DROP TABLE flux_line + flux_statement +
-- DROP TYPE both enums.
--
-- Design doc: docs/blackline-arc-design.md → Phase 3.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FluxStatementStatus') THEN
    CREATE TYPE "FluxStatementStatus" AS ENUM ('DRAFT', 'FINALIZED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FluxLineStatus') THEN
    CREATE TYPE "FluxLineStatus" AS ENUM (
      'IMMATERIAL',
      'NEEDS_COMMENT',
      'EXPLAINED',
      'WAIVED'
    );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- flux_statement
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "flux_statement" (
  "id"                UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"          UUID                  NOT NULL REFERENCES "tenant"("id") ON DELETE RESTRICT,

  "entityId"          UUID                  NOT NULL REFERENCES "legal_entity"("id"),
  "bookId"            UUID                  NOT NULL REFERENCES "book"("id"),

  "fromPeriodId"      UUID                  NOT NULL REFERENCES "period"("id"),
  "toPeriodId"        UUID                  NOT NULL REFERENCES "period"("id"),

  -- Threshold config — frozen at create. Re-running the analysis
  -- updates lines but NOT the threshold; a different threshold
  -- requires a new statement.
  "absoluteThreshold" DECIMAL(20, 4)        NOT NULL DEFAULT 0,
  -- Stored as a number: 10.00 = 10%. NOT a fraction.
  "percentThreshold"  DECIMAL(8, 4)         NOT NULL DEFAULT 0,

  "status"            "FluxStatementStatus" NOT NULL DEFAULT 'DRAFT',

  "finalizedBy"       UUID                  REFERENCES "app_user"("id"),
  "finalizedAt"       TIMESTAMP(3),

  "createdAt"         TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)          NOT NULL
);

-- Idempotent regeneration: re-running on the same (entity, book,
-- from, to) tuple reuses the existing statement.
CREATE UNIQUE INDEX IF NOT EXISTS "flux_statement_scope_key"
  ON "flux_statement" ("entityId", "bookId", "fromPeriodId", "toPeriodId");

-- List-page query path: status × period × tenant.
CREATE INDEX IF NOT EXISTS "flux_statement_tenantId_toPeriodId_status_idx"
  ON "flux_statement" ("tenantId", "toPeriodId", "status");

-- ─────────────────────────────────────────────────────────────────────────
-- flux_line
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "flux_line" (
  "id"            UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      UUID              NOT NULL REFERENCES "tenant"("id") ON DELETE RESTRICT,
  "statementId"   UUID              NOT NULL REFERENCES "flux_statement"("id") ON DELETE CASCADE,

  "accountId"     UUID              NOT NULL REFERENCES "account"("id"),

  -- FROZEN snapshots — what the auditor sees here is exactly what
  -- the controller signed against. Backdated posts don't flip
  -- already-recorded flux numbers.
  "priorAmount"   DECIMAL(20, 4)    NOT NULL,
  "currentAmount" DECIMAL(20, 4)    NOT NULL,
  "deltaAmount"   DECIMAL(20, 4)    NOT NULL,
  -- Nullable because |priorAmount| = 0 → division-by-zero. UI renders
  -- as "n/a" or "new account".
  "deltaPercent"  DECIMAL(12, 4),

  "status"        "FluxLineStatus"  NOT NULL DEFAULT 'IMMATERIAL',

  "commentary"    TEXT,
  "commentaryBy"  UUID              REFERENCES "app_user"("id"),
  "commentaryAt"  TIMESTAMP(3),

  "createdAt"     TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)      NOT NULL
);

-- One row per (statement, account) — regeneration upserts on this
-- composite key.
CREATE UNIQUE INDEX IF NOT EXISTS "flux_line_statementId_accountId_key"
  ON "flux_line" ("statementId", "accountId");

-- "What needs commentary in this statement" query.
CREATE INDEX IF NOT EXISTS "flux_line_statementId_status_idx"
  ON "flux_line" ("statementId", "status");

CREATE INDEX IF NOT EXISTS "flux_line_tenantId_idx"
  ON "flux_line" ("tenantId");
