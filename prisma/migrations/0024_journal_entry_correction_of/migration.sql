-- Correction lineage on gl_entry_header.
--
-- A reclassification / correcting entry links to the POSTED entry it corrects
-- via correctionOfId. Unlike a reversal, the source is NOT negated — it stays
-- POSTED; this column only records the relationship so the audit trail and the
-- balance-change lineage view can follow it. Mirrors reversalOfId exactly
-- (a nullable self-FK on gl_entry_header).
--
-- Additive + nullable, no backfill → safe on a populated table. The schema is
-- `db push`-managed, so CI/test create this column straight from schema.prisma;
-- this file gives migrate-deploy (prod) the identical change. It is NOT
-- migration-mirror DDL: a nullable FK is fully Prisma-expressible, so it does
-- not belong in prisma/sql/migration-mirror.sql.
--
-- Rollback:
--   ALTER TABLE "gl_entry_header" DROP CONSTRAINT IF EXISTS "gl_entry_header_correctionOfId_fkey";
--   ALTER TABLE "gl_entry_header" DROP COLUMN IF EXISTS "correctionOfId";

ALTER TABLE "gl_entry_header"
  ADD COLUMN IF NOT EXISTS "correctionOfId" UUID;

-- FK mirrors Prisma's optional-relation default (ON DELETE SET NULL / ON UPDATE
-- CASCADE) so migrate-deploy and `db push` converge on the same constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gl_entry_header_correctionOfId_fkey'
  ) THEN
    ALTER TABLE "gl_entry_header"
      ADD CONSTRAINT "gl_entry_header_correctionOfId_fkey"
      FOREIGN KEY ("correctionOfId")
      REFERENCES "gl_entry_header"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
