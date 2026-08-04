-- Bank feed Car 2: learned categorization rules + a MATCHED status for
-- feed lines linked to an existing entry instead of posting a new one.

-- New status. Kept outside a transaction block per Postgres enum rules;
-- prisma migrate runs ALTER TYPE ... ADD VALUE on its own.
ALTER TYPE "BankTxnStatus" ADD VALUE IF NOT EXISTS 'MATCHED';

CREATE TABLE "bank_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "matchText" TEXT NOT NULL,
    "matchHash" TEXT NOT NULL,
    "bankAccountId" UUID,
    "categoryAccountId" UUID NOT NULL,
    "timesUsed" INTEGER NOT NULL DEFAULT 1,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_rule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bank_rule_tenantId_matchHash_key" ON "bank_rule"("tenantId", "matchHash");
CREATE INDEX "bank_rule_tenantId_idx" ON "bank_rule"("tenantId");

ALTER TABLE "bank_rule" ADD CONSTRAINT "bank_rule_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_rule" ADD CONSTRAINT "bank_rule_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_rule" ADD CONSTRAINT "bank_rule_categoryAccountId_fkey"
    FOREIGN KEY ("categoryAccountId") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
