-- Team management: invites + the read-only VIEWER role (PR #46 harvest, slice ③).
--
-- VIEWER completes the role hierarchy (OWNER > ADMIN > MEMBER > VIEWER):
-- the auditor role — view reports and pages, refused by every mutation
-- floor in src/lib/auth/policy.ts. Additive enum value; no existing row
-- changes meaning.
--
-- tenant_invite carries the invite-by-email flow: a random single-use
-- token, the role granted on acceptance (OWNER deliberately not
-- invitable), and lazy expiry. Confidentiality baked in at creation
-- (same posture as email_delivery / migration 0032): email is encrypted
-- at rest from day one, equality lookups go through emailHash, and
-- there is no plaintext row to backfill — which is why there is no
-- index on the email column itself (ciphertext with a random IV is
-- unindexable by design).
--
-- RLS: tenant_invite is Phase 1 policy #54 in
-- prisma/sql/2026-06-05-rls-phase-1-policies.sql (standard NOT NULL
-- tenantId shape). Applied via db:restore-ddl, not here.

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "TenantRole" ADD VALUE 'VIEWER';

-- CreateTable
CREATE TABLE "tenant_invite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "emailHash" BYTEA,
    "role" "TenantRole" NOT NULL,
    "token" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "invitedById" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "tenant_invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invite_token_key" ON "tenant_invite"("token");

-- CreateIndex
CREATE INDEX "tenant_invite_tenantId_status_idx" ON "tenant_invite"("tenantId", "status");

-- CreateIndex
CREATE INDEX "tenant_invite_tenantId_emailHash_idx" ON "tenant_invite"("tenantId", "emailHash");

-- AddForeignKey
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
