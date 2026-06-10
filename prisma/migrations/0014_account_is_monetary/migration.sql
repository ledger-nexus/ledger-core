-- Add the ASC 830 / IAS 21 monetary classification to account.
--
-- Monetary accounts (cash, trade receivables, trade payables, intercompany
-- due-from/due-to, debt) hold a fixed number of currency units. A foreign-
-- currency balance in a monetary account is re-measured to the entity's
-- functional currency at the period-end CLOSE rate, and the movement hits
-- FX gain/loss. Non-monetary accounts (inventory, fixed assets, prepaids,
-- equity) carry at historical rate and are never revalued.
--
-- Default FALSE: existing accounts are non-monetary until explicitly flagged.
-- The seed (chart-of-accounts.ts) marks the monetary accounts; this backfill
-- statement classifies the standard subtypes so an already-seeded DB picks up
-- the flag without a reseed.

ALTER TABLE "account"
  ADD COLUMN "isMonetary" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the standard monetary subtypes for any chart already seeded.
-- Mirrors the isMonetary assignments in src/lib/db/chart-of-accounts.ts.
UPDATE "account"
SET "isMonetary" = true
WHERE "subtype" IN (
  'CASH',
  'AR_TRADE',
  'AP_TRADE',
  'DUE_FROM_AFFILIATE',
  'DUE_TO_AFFILIATE'
);
