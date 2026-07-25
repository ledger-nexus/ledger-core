-- Maker-checker approval for journal entries (PR #46 harvest, slice ④).
--
-- PENDING_APPROVAL entries are persisted WITH their lines (balance is
-- validated at submit) but have NO ledger effect: every aggregation
-- site filters to LEDGER_EFFECTIVE_STATUSES (POSTED, REVERSED) — see
-- src/lib/accounting/types.ts. Approval flips status to POSTED after
-- re-running the period-close check; rejection/withdrawal flips to
-- VOID with rejectionReason set.
--
-- Tenant policy: requireJeApproval (default OFF — solo books keep the
-- historical direct-post behavior) + optional jeApprovalMinAmount
-- threshold. ADMIN+ direct posts always bypass the queue.
--
-- All columns nullable/defaulted → additive; no backfill.

-- AlterEnum
ALTER TYPE "EntryStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "jeApprovalMinAmount" DECIMAL(18,4),
ADD COLUMN     "requireJeApproval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "gl_entry_header" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedById" UUID,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedById" UUID;

-- CreateIndex
CREATE INDEX "gl_entry_header_tenantId_status_createdAt_idx" ON "gl_entry_header"("tenantId", "status", "createdAt");

