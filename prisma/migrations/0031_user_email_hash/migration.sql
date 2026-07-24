-- SOC 2 CC6 (Confidentiality TSC) — deterministic search hash for the
-- encrypted app_user.email column.
--
-- `email` is encrypted at rest with AES-256-GCM using a RANDOM IV, so the
-- same plaintext produces different ciphertext on every write. Two
-- consequences drive this migration:
--
--   1. Equality lookup by email is impossible against the ciphertext.
--      emailHash holds HMAC-SHA256(domain="User.email", lower(trim(email)))
--      so login and seed upserts can still find a row.
--
--   2. The existing UNIQUE on `email` silently STOPS ENFORCING the
--      one-row-per-email invariant, because two rows holding the same
--      plaintext hold different ciphertext. The UNIQUE below is what
--      carries that invariant now. `email`'s own UNIQUE is deliberately
--      left in place: harmless, and dropping it is a separate decision.
--
-- NULLable during rollout: pre-existing rows have no hash until
-- scripts/encrypt-user-emails.ts backfills them. Tightening to NOT NULL
-- is the Phase 3 cleanup, once every row is confirmed populated.
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "emailHash" BYTEA;

CREATE UNIQUE INDEX IF NOT EXISTS "app_user_emailHash_key"
  ON "app_user" ("emailHash");
