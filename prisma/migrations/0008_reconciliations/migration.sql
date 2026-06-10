-- BlackLine arc — Phase 1 PR 1: Account Reconciliations.
--
-- Adds the workflow shell that lets a controller certify each BS account
-- ties out to supporting documentation each period. Preparer → reviewer
-- chain (configurable per-recon: single sign-off also supported). Sign-off
-- evidence persists for SOC 1 / SOX 404 audit purposes.
--
-- Tables:
--   * reconciliation              — one row per (entity, book, period, account)
--   * reconciliation_attachment   — supporting docs (encrypted bytes in DB)
--   * reconciliation_config       — per-tenant default sign-off shape + tolerance
--
-- Account model gains two nullable fields:
--   * requiresReconReview Boolean? — null = inherit tenant default
--   * reconTolerance      Decimal? — null = inherit tenant default
--
-- Idempotent: CREATE TYPE / CREATE TABLE all gated by IF NOT EXISTS where
-- Postgres permits it. The CREATE TYPE is wrapped in a DO block because
-- Postgres lacks `CREATE TYPE IF NOT EXISTS`.
--
-- Design doc: docs/blackline-arc-design.md
-- Rollback: DROP the three new tables + DROP TYPE "ReconStatus" + ALTER
-- TABLE account DROP the two new columns. Idempotent — safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReconStatus') THEN
    CREATE TYPE "ReconStatus" AS ENUM (
      'OPEN',
      'IN_PROGRESS',
      'PREPARED',
      'RECONCILED',
      'EXCEPTION',
      'WAIVED'
    );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Account additions: per-account sign-off + tolerance overrides
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "account"
  ADD COLUMN IF NOT EXISTS "requiresReconReview" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "reconTolerance"      DECIMAL(20, 4);

-- ─────────────────────────────────────────────────────────────────────────
-- reconciliation
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reconciliation" (
  "id"                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"          UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE RESTRICT,
  "entityId"          UUID         NOT NULL REFERENCES "legal_entity"("id"),
  "bookId"            UUID         NOT NULL REFERENCES "book"("id"),
  "periodId"          UUID         NOT NULL REFERENCES "period"("id"),
  "accountId"         UUID         NOT NULL REFERENCES "account"("id"),

  -- Frozen snapshot at sign-off time.
  "glBalance"         DECIMAL(20, 4) NOT NULL,
  "supportingBalance" DECIMAL(20, 4),
  "reconciledDiff"    DECIMAL(20, 4),
  "tolerance"         DECIMAL(20, 4) NOT NULL DEFAULT 0,

  "status"            "ReconStatus"  NOT NULL DEFAULT 'OPEN',
  "requiresReview"    BOOLEAN        NOT NULL DEFAULT TRUE,

  "preparedBy"        UUID REFERENCES "app_user"("id"),
  "preparedAt"        TIMESTAMP(3),
  "reviewedBy"        UUID REFERENCES "app_user"("id"),
  "reviewedAt"        TIMESTAMP(3),

  "notes"             TEXT,

  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL
);

-- Idempotent auto-instantiation per (entity, book, period, account).
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_scope_key"
  ON "reconciliation" ("entityId", "bookId", "periodId", "accountId");

-- Tenant-scoped query plans (the list page filters here first).
CREATE INDEX IF NOT EXISTS "reconciliation_tenantId_periodId_status_idx"
  ON "reconciliation" ("tenantId", "periodId", "status");

-- Dashboard query (cross-entity rollup of completion percentage).
CREATE INDEX IF NOT EXISTS "reconciliation_periodId_status_idx"
  ON "reconciliation" ("periodId", "status");

-- ─────────────────────────────────────────────────────────────────────────
-- reconciliation_attachment
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reconciliation_attachment" (
  "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"         UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE RESTRICT,
  "reconciliationId" UUID         NOT NULL REFERENCES "reconciliation"("id") ON DELETE CASCADE,
  "filename"         TEXT         NOT NULL,
  "contentType"      TEXT         NOT NULL,
  -- Encrypted bytes via PrismaExtension confidential-column path (wired
  -- when the detail-page upload form ships in PR 4).
  "payload"          BYTEA        NOT NULL,
  "sizeBytes"        INTEGER      NOT NULL,
  "uploadedById"     UUID         NOT NULL REFERENCES "app_user"("id"),
  "uploadedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "reconciliation_attachment_reconciliationId_idx"
  ON "reconciliation_attachment" ("reconciliationId");

CREATE INDEX IF NOT EXISTS "reconciliation_attachment_tenantId_idx"
  ON "reconciliation_attachment" ("tenantId");

-- ─────────────────────────────────────────────────────────────────────────
-- reconciliation_config
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reconciliation_config" (
  "id"                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"              UUID         NOT NULL UNIQUE REFERENCES "tenant"("id") ON DELETE CASCADE,
  "defaultRequiresReview" BOOLEAN      NOT NULL DEFAULT TRUE,
  "defaultTolerance"      DECIMAL(20, 4) NOT NULL DEFAULT 0,
  "updatedAt"             TIMESTAMP(3) NOT NULL
);
