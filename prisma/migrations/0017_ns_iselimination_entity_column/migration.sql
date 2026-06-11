-- v0.9 NS Books (ported as 0017; chain numbered it 0010) — promote isEliminationEntity from extensions JSON to a real column.
--
-- Pre-migration: v0.7 multi-sub setupSubsidiaries tagged elimination subs
-- via `extensions.nsIsElimination = true`. The JSON flag works for
-- display but doesn't index well, and downstream consolidation/elimination
-- logic that wants to filter on it can't use a typed predicate.
--
-- Post-migration:
--   - Real column `isEliminationEntity Boolean @default(false)`
--   - Backfill: every existing row where extensions.nsIsElimination is
--     literal-true gets the column set to true; everyone else stays false
--   - The JSON flag in `extensions` STAYS for now (v0.7 backward compat
--     + roundtrip preservation); subsequent setupSubsidiaries calls
--     populate BOTH for a phase, then a future migration drops the JSON
--     side after every caller migrates
--
-- Idempotent — re-applying is a no-op (column exists checks via IF NOT EXISTS).

ALTER TABLE "legal_entity"
  ADD COLUMN IF NOT EXISTS "isEliminationEntity" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the JSON flag set by v0.7 setupSubsidiaries. Uses
-- ->>'nsIsElimination' (text accessor) cast to bool so 'true'/'false'
-- strings both resolve correctly. NULL extensions just stay false.
UPDATE "legal_entity"
SET "isEliminationEntity" = true
WHERE
  "extensions" IS NOT NULL
  AND ("extensions"->>'nsIsElimination')::boolean IS TRUE
  AND "isEliminationEntity" = false;
