-- Stripe subscription state on the tenant (PR #46 harvest, slice ⑦).
--
-- Five nullable columns, no new table, no RLS change: `tenant` already
-- carries the Phase 1 policy set and these columns live on rows that
-- policy already covers.
--
-- All nullable and unbackfilled on purpose. Every existing tenant reads
-- as NULL/NULL/NULL/NULL/NULL, which getEffectivePlan() resolves to
-- FREE_TIER — the same entitlement they have today. Nothing changes for
-- anyone until a Stripe webhook writes here, and no webhook can arrive
-- until STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are configured.
--
-- Reversal: DROP the unique index, then DROP the five columns. No data
-- loss beyond the Stripe mirror itself, which Stripe can re-emit by
-- replaying the subscription events.

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "billingPlan" TEXT,
ADD COLUMN     "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT;

-- CreateIndex
-- One Stripe customer maps to exactly one workspace. Without this a
-- mis-set metadata.tenantId could point two tenants at one customer and
-- a single card would entitle both.
CREATE UNIQUE INDEX "tenant_stripeCustomerId_key" ON "tenant"("stripeCustomerId");
