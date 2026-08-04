-- Transactional email log (PR #46 harvest, slice ②).
--
-- One row per attempted send, whatever the outcome — the operator's
-- answer to "did this customer actually get their invite?". Templates
-- and senders arrive with their consuming slices (team-invites,
-- approvals, owner-transfer); this migration is the substrate only.
--
-- Confidentiality posture is baked in at creation rather than
-- retrofitted (the table starts empty, so there is nothing to
-- backfill):
--   - toEmail / subject / bodyText / bodyHtml are encrypted at rest by
--     the encrypted-fields extension (random-IV AES-256-GCM).
--   - toEmailHash carries HMAC-SHA256(domain="EmailDelivery.toEmail",
--     lower(trim(toEmail))) for equality lookups — the same pattern as
--     app_user.email / emailHash (migration 0031). NOT unique: many
--     deliveries per recipient is the normal case.
--   - tenantId is nullable (platform emails have no tenant context) and
--     SET NULL on tenant delete — the delivery record outlives the
--     tenant, same rationale as audit_log's denormalized columns.
--
-- RLS: email_delivery gets a Phase 1 tenant-isolation policy in
-- prisma/sql/2026-06-05-rls-phase-1-policies.sql (nullable-tenant
-- shape, mirroring audit_log). Applied via db:restore-ddl, not here.

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('DELIVERED', 'LOGGED_ONLY', 'FAILED');

-- CreateTable
CREATE TABLE "email_delivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID,
    "toEmail" TEXT NOT NULL,
    "toEmailHash" BYTEA,
    "template" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "status" "EmailDeliveryStatus" NOT NULL,
    "providerId" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_delivery_tenantId_sentAt_idx" ON "email_delivery"("tenantId", "sentAt");

-- CreateIndex
CREATE INDEX "email_delivery_toEmailHash_sentAt_idx" ON "email_delivery"("toEmailHash", "sentAt");

-- AddForeignKey
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
