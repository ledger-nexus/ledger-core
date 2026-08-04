-- Allocation templates (NetSuite dynamic-allocation parity) — additive,
-- idempotent. ALLOCATION-kind recurring templates clear a source
-- account's month-to-docDate activity into target lines by percentage.

DO $$ BEGIN
  CREATE TYPE "RecurringEntryKind" AS ENUM ('STANDARD', 'ALLOCATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "recurring_entry"
  ADD COLUMN IF NOT EXISTS "kind" "RecurringEntryKind" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS "allocationSourceAccountCode" TEXT;

ALTER TABLE "recurring_entry_line"
  ADD COLUMN IF NOT EXISTS "allocationPercent" DECIMAL(7,4);
