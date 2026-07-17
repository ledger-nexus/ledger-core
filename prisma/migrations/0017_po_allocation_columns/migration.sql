-- 0017 — performance_obligation ASC 606 allocation columns (upstreamed)
--
-- Upstreams four columns + two enums that revenue-rec added via its
-- PR #17 (prisma/sql/2026-06-04-po-schema-additions.sql in that repo)
-- and applied to the shared database on 2026-06-04. The DDL below is
-- byte-equivalent to what revenue-rec ran; on the shared dev DB every
-- statement is a no-op (IF NOT EXISTS / DO-block guarded). The
-- migration exists so ledger-core's schema is the complete record of
-- the table it owns and fresh databases provision identically.
--
--   - allocatedAmount  DECIMAL(18,4) NULL — allocated transaction price;
--     NULL means "fall back to SSP" (proportional allocation default)
--   - allocationMethod "AllocationMethod" NULL — ASC 606 ¶78
--     (PROPORTIONAL / RESIDUAL / MANUAL); NULL = unspecified
--   - fairValueMethod  "FairValueMethod" NULL — ASC 606 ¶77 evidence
--     hierarchy (ESP / VSOE / TPE / RESIDUAL); NULL = unspecified
--   - quantity         DECIMAL(18,4) NOT NULL DEFAULT 1 — back-compat:
--     SSP carries the per-line total, not per-unit
--
-- All additions are NULL-tolerant (or DEFAULT 1 for quantity), so
-- pre-migration rows and callers continue to work unchanged.
--
-- No migration-mirror.sql entry needed: these are plain Prisma-visible
-- columns/enums, fully covered by `prisma db push` from schema.prisma.
--
-- Rollback:
--   ALTER TABLE performance_obligation
--     DROP COLUMN IF EXISTS "allocatedAmount",
--     DROP COLUMN IF EXISTS "allocationMethod",
--     DROP COLUMN IF EXISTS "fairValueMethod",
--     DROP COLUMN IF EXISTS "quantity";
--   DROP TYPE IF EXISTS "AllocationMethod";
--   DROP TYPE IF EXISTS "FairValueMethod";
-- (Rolling back on the shared DB would break revenue-rec's
-- allocator/scheduler/NS mappers, which are live on these columns —
-- coordinate with revenue-rec before ever running it.)

-- 1. AllocationMethod enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AllocationMethod') THEN
    CREATE TYPE "AllocationMethod" AS ENUM ('PROPORTIONAL', 'RESIDUAL', 'MANUAL');
  END IF;
END $$;

-- 2. FairValueMethod enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FairValueMethod') THEN
    CREATE TYPE "FairValueMethod" AS ENUM ('ESP', 'VSOE', 'TPE', 'RESIDUAL');
  END IF;
END $$;

-- 3. allocatedAmount column (NULL means "use SSP" — back-compat)
ALTER TABLE performance_obligation
  ADD COLUMN IF NOT EXISTS "allocatedAmount" DECIMAL(18,4);

-- 4. allocationMethod column (NULL = unspecified)
ALTER TABLE performance_obligation
  ADD COLUMN IF NOT EXISTS "allocationMethod" "AllocationMethod";

-- 5. fairValueMethod column (NULL = unspecified)
ALTER TABLE performance_obligation
  ADD COLUMN IF NOT EXISTS "fairValueMethod" "FairValueMethod";

-- 6. quantity column (DEFAULT 1 means "back-compat with SSP-as-line-total")
ALTER TABLE performance_obligation
  ADD COLUMN IF NOT EXISTS "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1;
