-- v0.8 FX Phase 4a — Account.translationCategory column.
--
-- Adds the ASC 830 translation method per account. CURRENT_RATE for
-- balance sheet items, HISTORICAL for equity, WEIGHTED_AVG for the
-- income statement, EXCLUDED for accounts that are themselves the
-- translation result (e.g. realized FX gain/loss).
--
-- Phase 4a adds the column + enum only. Phase 4b implements the
-- translator and Phase 4c wires it into the consolidation report.
--
-- Backfill strategy:
--   * Account types ASSET, LIABILITY default to CURRENT_RATE
--   * Account type EQUITY defaults to HISTORICAL
--   * Account types REVENUE, EXPENSE default to WEIGHTED_AVG
--   * Account subtype FX_GAIN_LOSS overrides to EXCLUDED (the
--     translation-result-itself case)
-- Existing single-currency installations don't strictly need the
-- column populated — the consolidation translator (Phase 4b) defaults
-- to CURRENT_RATE when null — but we backfill so the chart is
-- intentional from migration time.

CREATE TYPE "TranslationCategory" AS ENUM (
  'CURRENT_RATE',
  'HISTORICAL',
  'WEIGHTED_AVG',
  'EXCLUDED'
);

ALTER TABLE "account"
  ADD COLUMN "translationCategory" "TranslationCategory";

-- Backfill default per account type. Order matters: the FX_GAIN_LOSS
-- subtype override (EXCLUDED) is set LAST so it wins over the
-- WEIGHTED_AVG default that the EXPENSE type would otherwise give.
UPDATE "account"
SET "translationCategory" = 'CURRENT_RATE'
WHERE "type" IN ('ASSET', 'LIABILITY')
  AND "translationCategory" IS NULL;

UPDATE "account"
SET "translationCategory" = 'HISTORICAL'
WHERE "type" = 'EQUITY'
  AND "translationCategory" IS NULL;

UPDATE "account"
SET "translationCategory" = 'WEIGHTED_AVG'
WHERE "type" IN ('REVENUE', 'EXPENSE')
  AND "translationCategory" IS NULL;

UPDATE "account"
SET "translationCategory" = 'EXCLUDED'
WHERE "subtype" IN ('FX_GAIN_LOSS_REALIZED', 'FX_GAIN_LOSS_UNREALIZED');
