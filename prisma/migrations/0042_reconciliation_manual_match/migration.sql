-- NOTE ON THE NAME: `reconciliation_match` is already taken in the
-- shared dev database by the `recon` companion repo (a different shape
-- entirely — bankLineId, confidence, appliedByEntryId). This table is
-- ours and is named apart from it. CI runs against a fresh database and
-- would never have surfaced the clash.
--
-- Manual reconciliation matches: an operator's decision that one GL
-- line and one statement line are the same transaction.
--
-- Auto-matching pairs on exact amount inside a date window. Everything
-- it cannot pair — a cheque split across two deposits, a fee posted
-- net, a transposition — needs a human to say so, and that judgement
-- belongs in the audit trail with a name against it, which is why
-- decidedById is NOT NULL.
--
-- The two uniques are load-bearing: a GL line and a statement line can
-- each be claimed once per reconciliation. Without them the same
-- payment could be matched twice and the difference would still look
-- explained.
--
-- Rollback: DROP TABLE. Nothing else references it; auto-matching is
-- unaffected because it derives on read.

CREATE TABLE IF NOT EXISTS "reconciliation_manual_match" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"          UUID NOT NULL,
  "reconciliationId"  UUID NOT NULL,
  "journalLineId"     UUID NOT NULL,
  "bankTransactionId" UUID NOT NULL,
  "decidedById"       UUID NOT NULL,
  "decidedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"              TEXT,
  CONSTRAINT "reconciliation_manual_match_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "reconciliation_manual_match"
  DROP CONSTRAINT IF EXISTS "reconciliation_manual_match_tenantId_fkey";
ALTER TABLE "reconciliation_manual_match"
  ADD CONSTRAINT "reconciliation_manual_match_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reconciliation_manual_match"
  DROP CONSTRAINT IF EXISTS "reconciliation_manual_match_reconciliationId_fkey";
ALTER TABLE "reconciliation_manual_match"
  ADD CONSTRAINT "reconciliation_manual_match_reconciliationId_fkey"
  FOREIGN KEY ("reconciliationId") REFERENCES "reconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reconciliation_manual_match"
  DROP CONSTRAINT IF EXISTS "reconciliation_manual_match_journalLineId_fkey";
ALTER TABLE "reconciliation_manual_match"
  ADD CONSTRAINT "reconciliation_manual_match_journalLineId_fkey"
  FOREIGN KEY ("journalLineId") REFERENCES "gl_entry_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reconciliation_manual_match"
  DROP CONSTRAINT IF EXISTS "reconciliation_manual_match_bankTransactionId_fkey";
ALTER TABLE "reconciliation_manual_match"
  ADD CONSTRAINT "reconciliation_manual_match_bankTransactionId_fkey"
  FOREIGN KEY ("bankTransactionId") REFERENCES "bank_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reconciliation_manual_match"
  DROP CONSTRAINT IF EXISTS "reconciliation_manual_match_decidedById_fkey";
ALTER TABLE "reconciliation_manual_match"
  ADD CONSTRAINT "reconciliation_manual_match_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_manual_match_reconciliationId_journalLineId_key"
  ON "reconciliation_manual_match" ("reconciliationId", "journalLineId");
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_manual_match_reconciliationId_bankTransactionId_key"
  ON "reconciliation_manual_match" ("reconciliationId", "bankTransactionId");
CREATE INDEX IF NOT EXISTS "reconciliation_manual_match_tenantId_reconciliationId_idx"
  ON "reconciliation_manual_match" ("tenantId", "reconciliationId");

-- RLS Phase 1 parity: every tenant-scoped table carries a policy, even
-- though nothing is FORCED yet (deficiency #12). A new table that
-- skipped this would be the one gap when Phase 3 flips the switch.
ALTER TABLE "reconciliation_manual_match" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconciliation_manual_match_tenant_isolation ON "reconciliation_manual_match";
CREATE POLICY reconciliation_manual_match_tenant_isolation ON "reconciliation_manual_match"
  FOR ALL
  USING ("tenantId" = app_current_tenant_id())
  WITH CHECK ("tenantId" = app_current_tenant_id());
