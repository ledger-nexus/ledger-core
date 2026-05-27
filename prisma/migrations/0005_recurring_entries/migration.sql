-- Recurring journal entries: templates + lines + cadence enum.
--
-- Templates produce JournalEntries on a schedule. The runner uses a
-- stable lineage triple (sourceSystem="SUBSTRATE", sourceRecordType=
-- "RecurringEntry", sourceRecordId="<templateId>:<docDateISO>") so
-- ledger-core's existing dedup index handles re-runs idempotently.

CREATE TYPE "Cadence" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUALLY');

CREATE TABLE "recurring_entry" (
  "id"             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"       UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE RESTRICT,
  "entityId"       UUID         NOT NULL REFERENCES "legal_entity"("id"),
  "bookId"         UUID         NOT NULL REFERENCES "book"("id"),
  "code"           TEXT         NOT NULL,
  "memo"           TEXT         NOT NULL,
  "currencyId"     TEXT         NOT NULL REFERENCES "currency"("code"),
  "cadence"        "Cadence"    NOT NULL,
  "startDate"      DATE         NOT NULL,
  "endDate"        DATE,
  "lastPostedDate" DATE,
  "isActive"       BOOLEAN      NOT NULL DEFAULT TRUE,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "recurring_entry_tenantId_code_key" ON "recurring_entry"("tenantId", "code");
CREATE INDEX        "recurring_entry_tenantId_idx"     ON "recurring_entry"("tenantId");
CREATE INDEX        "recurring_entry_entityId_bookId_idx" ON "recurring_entry"("entityId", "bookId");

CREATE TABLE "recurring_entry_line" (
  "id"          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "templateId"  UUID            NOT NULL REFERENCES "recurring_entry"("id") ON DELETE CASCADE,
  "lineNo"      INTEGER         NOT NULL,
  "accountCode" TEXT            NOT NULL,
  "debit"       DECIMAL(18, 4)  NOT NULL DEFAULT 0,
  "credit"      DECIMAL(18, 4)  NOT NULL DEFAULT 0,
  "description" TEXT,
  "partyCode"   TEXT,
  "itemCode"    TEXT
);

CREATE UNIQUE INDEX "recurring_entry_line_templateId_lineNo_key" ON "recurring_entry_line"("templateId", "lineNo");
