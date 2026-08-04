-- Two-step tenant ownership transfer (PR #46 harvest, slice ⑤).
-- Offer (OWNER) → accept (target member) swaps Tenant.ownerUserId +
-- flips the two membership roles atomically; either side can cancel.
-- Both columns nullable → additive; no backfill; no RLS change.

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "pendingOwnerTransferInitiatedAt" TIMESTAMP(3),
ADD COLUMN     "pendingOwnerTransferToUserId" UUID;

