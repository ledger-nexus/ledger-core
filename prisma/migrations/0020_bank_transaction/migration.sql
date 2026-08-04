-- CreateEnum
CREATE TYPE "BankTxnStatus" AS ENUM ('FOR_REVIEW', 'CATEGORIZED', 'EXCLUDED');

-- CreateTable
CREATE TABLE "bank_transaction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "bookId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "postedDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "externalRef" TEXT,
    "dedupeHash" TEXT NOT NULL,
    "status" "BankTxnStatus" NOT NULL DEFAULT 'FOR_REVIEW',
    "categoryAccountId" UUID,
    "postedEntryId" UUID,
    "excludedBy" TEXT,
    "excludeReason" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "bank_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_transaction_tenantId_entityId_bookId_bankAccountId_sta_idx" ON "bank_transaction"("tenantId", "entityId", "bookId", "bankAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transaction_tenantId_dedupeHash_key" ON "bank_transaction"("tenantId", "dedupeHash");

-- AddForeignKey
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "legal_entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_categoryAccountId_fkey" FOREIGN KEY ("categoryAccountId") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_postedEntryId_fkey" FOREIGN KEY ("postedEntryId") REFERENCES "gl_entry_header"("id") ON DELETE SET NULL ON UPDATE CASCADE;

