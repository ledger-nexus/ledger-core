-- Per-line functional-currency amounts — the schema gate for ASC 830
-- current-rate consolidation translation (the arc PR #151's postmortem
-- named: translating stored reporting-currency balances double-applies
-- rates; translation must start from FUNCTIONAL balances, which until
-- now were never stored).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the backfill only touches rows
-- still carrying the DEFAULT 0 with no functional currency stamped, so
-- re-runs are no-ops.

ALTER TABLE "gl_entry_line"
  ADD COLUMN IF NOT EXISTS "functionalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "functionalCurrencyId" TEXT;

-- Backfill. Measurement rules, in precedence order:
--
--   1. FX revaluation lines (sourceSystem FX_REVAL) → 0. A revaluation
--      trues the REPORTING view of monetary items; in the entity's own
--      functional currency nothing happened.
--   2. Line's transaction currency == entity functional → the
--      transaction amount IS the functional measurement.
--   3. Line's reporting currency == entity functional → the reporting
--      amount IS the functional measurement (the transaction-date
--      conversion landed in functional).
--   4. Legacy three-way rows (txn ≠ functional ≠ reporting): none exist
--      in practice (every caller posts single-currency at fxRate 1);
--      fall back to reportingAmount and stamp the functional currency
--      so the row is at least visibly measured.
--
-- functionalCurrencyId is always the ENTITY's functional currency.

UPDATE "gl_entry_line" l
SET
  "functionalCurrencyId" = e."functionalCurrencyId",
  "functionalAmount" = CASE
    WHEN h."sourceSystem" = 'FX_REVAL' THEN 0
    WHEN l."transactionCurrencyId" = e."functionalCurrencyId" THEN l."transactionAmount"
    WHEN l."reportingCurrencyId"  = e."functionalCurrencyId" THEN l."reportingAmount"
    ELSE l."reportingAmount"
  END
FROM "gl_entry_header" h
JOIN "legal_entity" e ON e."id" = h."entityId"
WHERE l."entryId" = h."id"
  AND l."functionalCurrencyId" IS NULL;
