-- Inline review-comment table on journal entries.
--
-- Lightweight by design: no threading, no @mentions, no markdown. CPAs
-- write a sentence; another CPA reads it; one resolves it. The note row
-- stays in the DB after resolution (audit), just rendered de-emphasized.
--
-- ON DELETE CASCADE on entryId because notes have no meaning without the
-- entry — when a JE is deleted (rare, but the schema permits it via raw
-- SQL in cleanup paths), its notes should go too.

CREATE TABLE "journal_entry_note" (
  "id"           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"     UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE RESTRICT,
  "entryId"      UUID         NOT NULL REFERENCES "gl_entry_header"("id") ON DELETE CASCADE,
  "authorUserId" UUID                  REFERENCES "app_user"("id"),
  "authorEmail"  TEXT,
  "body"         TEXT         NOT NULL,
  "resolvedAt"   TIMESTAMP(3),
  "resolvedBy"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);

CREATE INDEX "journal_entry_note_entryId_idx"    ON "journal_entry_note"("entryId");
CREATE INDEX "journal_entry_note_tenantId_idx"   ON "journal_entry_note"("tenantId");
CREATE INDEX "journal_entry_note_resolvedAt_idx" ON "journal_entry_note"("resolvedAt");
