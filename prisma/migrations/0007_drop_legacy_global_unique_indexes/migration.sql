-- Drop the legacy global unique indexes that Phase 4b SHOULD have
-- dropped but didn't.
--
-- The Phase 4b migration (0004) used `ALTER TABLE ... DROP CONSTRAINT
-- IF EXISTS` to drop the old global @unique on legal_entity.code,
-- journal_entry.entryNumber, etc. That works only if Prisma had
-- materialized those as named constraints (via ALTER TABLE ADD
-- CONSTRAINT). In practice, Prisma generates @unique as a UNIQUE
-- INDEX, not a constraint — so `DROP CONSTRAINT` was a silent no-op
-- and the legacy global indexes stayed in place alongside the new
-- composite [tenantId, X] indexes.
--
-- The functional consequence: even though the schema and ORM client
-- have said "code is unique per tenant" since the Phase 4b commit, the
-- database STILL refuses a second tenant's "ACME" entity. Two tenants
-- can't share a code, and a pen-test that tried to create both got
-- "Unique constraint failed on the fields: (code)". The Phase 4b
-- security model (each tenant owns its own code namespace) was
-- inoperative.
--
-- This migration drops the legacy indexes with the correct DDL.
-- `DROP INDEX IF EXISTS` is idempotent and safe; if the index never
-- existed (fresh deploy from current schema) the migration is a no-op.

DROP INDEX IF EXISTS "legal_entity_code_key";
DROP INDEX IF EXISTS "gl_entry_header_entryNumber_key";
DROP INDEX IF EXISTS "dimension_code_key";
DROP INDEX IF EXISTS "dimension_set_hash_key";
DROP INDEX IF EXISTS "queue_code_key";
