-- Bank-feed TOCTOU guard: at most one bank line may claim a given posted
-- entry. postedEntryId is nullable, and Postgres treats NULLs as distinct,
-- so unclaimed FOR_REVIEW / EXCLUDED lines are unconstrained; only a real
-- (non-null) posted-entry link is made unique. A second concurrent
-- match/categorize onto the same entry now fails with a unique violation
-- (P2002) instead of silently double-linking.
--
-- Rollback: DROP INDEX "bank_transaction_postedEntryId_key";
CREATE UNIQUE INDEX "bank_transaction_postedEntryId_key" ON "bank_transaction"("postedEntryId");
