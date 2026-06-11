-- BlackLine arc — Phase 2 PR 1: Close Task Calendar.
--
-- Models the controller's monthly close checklist as data.
--
-- Tables:
--   * close_task           — one row per (tenant, [entity], [book], period,
--                            template). Status NOT_STARTED → IN_PROGRESS →
--                            DONE / WAIVED. entityId / bookId nullable so a
--                            tenant-wide task ("send close-complete email")
--                            doesn't need N rows per (entity, book) tuple.
--   * close_task_template  — per-tenant catalog of recurring tasks. Seeded
--                            once via seedCloseTaskTemplates with ~50
--                            BlackLine-standard rows. Unique on (tenantId, key)
--                            so re-seeding is idempotent.
--   * close_task_comment   — comment thread on a task. Body plain Text in
--                            v1; encrypted via PrismaExtension when wired
--                            (design doc → Confidentiality wire-up).
--
-- Enums:
--   * CloseTaskStatus — NOT_STARTED | IN_PROGRESS | BLOCKED | DONE | WAIVED
--   * CloseTaskCategory — 9-bucket taxonomy (ACCRUAL, RECON, DEPRECIATION,
--     FX, REVENUE, INVENTORY, TAX, REPORTING, ADMIN). Drives the filter
--     pills on /close/tasks.
--
-- Dependencies: encoded as close_task.depends_on_ids UUID[]. Cycle
-- prevention enforced at Server Action write-time. Period-close gate
-- refuses if any close_task with required_for_close=true isn't terminal.
--
-- Idempotent: CREATE TYPE wrapped in DO blocks (Postgres lacks
-- CREATE TYPE IF NOT EXISTS); CREATE TABLE uses IF NOT EXISTS.
--
-- Design doc: docs/blackline-arc-design.md → Phase 2.
-- Rollback: DROP the three new tables + DROP TYPE both enums.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CloseTaskStatus') THEN
    CREATE TYPE "CloseTaskStatus" AS ENUM (
      'NOT_STARTED',
      'IN_PROGRESS',
      'BLOCKED',
      'DONE',
      'WAIVED'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CloseTaskCategory') THEN
    CREATE TYPE "CloseTaskCategory" AS ENUM (
      'ACCRUAL',
      'RECON',
      'DEPRECIATION',
      'FX',
      'REVENUE',
      'INVENTORY',
      'TAX',
      'REPORTING',
      'ADMIN'
    );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- close_task
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "close_task" (
  "id"               UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"         UUID                  NOT NULL REFERENCES "tenant"("id") ON DELETE RESTRICT,

  "entityId"         UUID                  REFERENCES "legal_entity"("id"),
  "bookId"           UUID                  REFERENCES "book"("id"),
  "periodId"         UUID                  NOT NULL REFERENCES "period"("id"),

  "templateKey"      TEXT,
  "name"             TEXT                  NOT NULL,
  "description"      TEXT,
  "category"         "CloseTaskCategory"   NOT NULL,

  "status"           "CloseTaskStatus"     NOT NULL DEFAULT 'NOT_STARTED',
  "requiredForClose" BOOLEAN               NOT NULL DEFAULT TRUE,

  "ownerId"          UUID,
  "ownerType"        "OwnerType",

  "dueOffsetDays"    INTEGER,
  "dueAt"            TIMESTAMP(3),

  -- Postgres array of UUIDs for the dependency graph. The Server Action
  -- enforces no-cycles at write time. Empty {} = no predecessors.
  "dependsOnIds"     UUID[]                NOT NULL DEFAULT '{}',

  "blockedReason"    TEXT,
  "completedById"    UUID                  REFERENCES "app_user"("id"),
  "completedAt"      TIMESTAMP(3),
  "evidenceUrl"      TEXT,
  "evidenceNote"     TEXT,

  "createdAt"        TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3)          NOT NULL
);

-- List-page query path: status × period × tenant.
CREATE INDEX IF NOT EXISTS "close_task_tenantId_periodId_status_idx"
  ON "close_task" ("tenantId", "periodId", "status");

-- "What's on my plate" query path.
CREATE INDEX IF NOT EXISTS "close_task_ownerId_idx"
  ON "close_task" ("ownerId");

-- Overdue query path — "show me everything due before today that isn't done."
CREATE INDEX IF NOT EXISTS "close_task_dueAt_idx"
  ON "close_task" ("dueAt");

-- ─────────────────────────────────────────────────────────────────────────
-- close_task_template
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "close_task_template" (
  "id"                   UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"             UUID                  NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,

  "key"                  TEXT                  NOT NULL,
  "name"                 TEXT                  NOT NULL,
  "description"          TEXT,
  "category"             "CloseTaskCategory"   NOT NULL,

  "defaultOwnerId"       UUID,
  "defaultOwnerType"     "OwnerType",
  "defaultDueOffsetDays" INTEGER,
  "requiredForClose"     BOOLEAN               NOT NULL DEFAULT TRUE,

  -- Dependency wiring by stable KEY, not id. Lets the seed be portable.
  "defaultDependsOnKeys" TEXT[]                NOT NULL DEFAULT '{}',

  "active"               BOOLEAN               NOT NULL DEFAULT TRUE,

  "createdAt"            TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)          NOT NULL
);

-- Idempotent re-seed: ON CONFLICT (tenantId, key) DO UPDATE.
CREATE UNIQUE INDEX IF NOT EXISTS "close_task_template_tenantId_key_key"
  ON "close_task_template" ("tenantId", "key");

CREATE INDEX IF NOT EXISTS "close_task_template_tenantId_active_idx"
  ON "close_task_template" ("tenantId", "active");

-- ─────────────────────────────────────────────────────────────────────────
-- close_task_comment
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "close_task_comment" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"    UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE RESTRICT,
  "closeTaskId" UUID         NOT NULL REFERENCES "close_task"("id") ON DELETE CASCADE,

  "body"        TEXT         NOT NULL,
  "authorId"    UUID         NOT NULL REFERENCES "app_user"("id"),

  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "close_task_comment_closeTaskId_idx"
  ON "close_task_comment" ("closeTaskId");

CREATE INDEX IF NOT EXISTS "close_task_comment_tenantId_idx"
  ON "close_task_comment" ("tenantId");
