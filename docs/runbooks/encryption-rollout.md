# Production rollout runbook — field-level encryption

**Audience:** the operator merging the SOC 2 hardening PRs to production.
**Scope:** all 4 DB-having repos (ledger-core, recon, fa-amort, revenue-rec). `integrations` has no DB and is out of scope.
**Time budget:** ~60-90 min including backups, env-var rotation, and per-script backfill.

⚠️ **Read this entire document before merging any PR.** The order of operations matters — deploying code before setting `FIELD_ENCRYPTION_KEY` will write plaintext to disk for the rollout window.

---

## Pre-flight (do this BEFORE merging anything)

### 1. Generate the encryption key

A single 64-hex-character value, shared across all 4 repos (the same row is encrypted on disk regardless of which repo wrote it):

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
```

Save the output in 1Password (or your secret store) **before** pasting it into Vercel — this key is unrecoverable. Losing it means every encrypted column becomes opaque forever.

### 2. Vercel: set `FIELD_ENCRYPTION_KEY` on each project

Apply to the 4 DB-having Vercel projects:

| Project | Environments |
|---|---|
| ledger-core | Production, Preview, Development |
| recon | Production, Preview, Development |
| fa-amort | Production, Preview, Development |
| revenue-rec | Production, Preview, Development |

Same 64-hex value across all 12 environment slots. **Use the value generated in step 1 — do not regenerate per project.**

`FIELD_DETERMINISTIC_KEY` is a SEPARATE key that ships in the same rollout for Phase 1 of the deterministic-encryption workstream (`docs/design/deterministic-encryption.md`). No column uses it yet, so setting it is **optional in this rollout window**. When you do set it, generate a SECOND independent 64-hex value (do NOT reuse `FIELD_ENCRYPTION_KEY`'s value — they should not share entropy) and apply across the same 12 slots.

Verification (per project, after a deploy):

```bash
curl -s https://<project>.vercel.app/api/health | jq '.encryption, .deterministicEncryption'
# Should return:
#   { "configured": true, "columnCount": <repo-specific> }
#   { "configured": <true if you set FIELD_DETERMINISTIC_KEY, else false> }
```

### 3. Production schema migrations

These ALTER TABLE statements need to run against production **before** the corresponding PR merges. Run them via `prisma db execute` from a local checkout pointing at the production `DATABASE_URL`, OR hand-execute against Neon's SQL console.

⚠️ **Take a Neon backup branch first** (`neon branches create --parent main pre-soc2-rollout`).

**revenue-rec** (4 columns):

```sql
ALTER TABLE "revenue_contract"
  ADD COLUMN IF NOT EXISTS "originalBaseAmount" DECIMAL(18, 4);

ALTER TABLE "ai_extraction_suggestion"
  ADD COLUMN IF NOT EXISTS "tenantId" UUID,
  ADD COLUMN IF NOT EXISTS "cacheReadTokens" INTEGER,
  ADD COLUMN IF NOT EXISTS "cacheCreationTokens" INTEGER;

-- Optional: add the FK if the Tenant table is shared on the same DB.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_extraction_suggestion_tenantId_fkey'
  ) THEN
    ALTER TABLE "ai_extraction_suggestion"
      ADD CONSTRAINT "ai_extraction_suggestion_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenant"("id");
  END IF;
END $$;
```

**fa-amort** (1 column):

```sql
ALTER TABLE "ai_asset_suggestion"
  ADD COLUMN IF NOT EXISTS "tenantId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_asset_suggestion_tenantId_fkey'
  ) THEN
    ALTER TABLE "ai_asset_suggestion"
      ADD CONSTRAINT "ai_asset_suggestion_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenant"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ai_asset_suggestion_tenantId_kind_createdAt_idx"
  ON "ai_asset_suggestion" ("tenantId", "kind", "createdAt");
```

**ledger-core**, **recon**: no production schema migrations required. The encrypted-fields changes only add columns to the Prisma client's view of existing columns.

---

## Merge order

After pre-flight (1, 2, 3) is complete:

1. **ledger-core PR** ([#10](https://github.com/ledger-nexus/ledger-core/pull/10)) — merges first because it contains the master encryption helper that the others mirror.
2. **recon PR** ([#8](https://github.com/ledger-nexus/recon/pull/8))
3. **fa-amort PR** ([#9](https://github.com/ledger-nexus/fa-amort/pull/9))
4. **revenue-rec PR** ([#9](https://github.com/ledger-nexus/revenue-rec/pull/9))
5. **integrations PR** ([#9](https://github.com/ledger-nexus/integrations/pull/9)) — order-independent; no DB.

Within each PR: `gh pr merge --squash --delete-branch`. Wait for Vercel to deploy before moving on.

---

## Post-merge: run the backfill scripts

Each backfill is idempotent (skips already-encrypted rows via `looksEncrypted`) and resumable (paginated by id ASC). All scripts:

- Use a RAW `PrismaClient` to bypass the extension on writes (so they store ciphertext directly).
- Read `FIELD_ENCRYPTION_KEY` from the environment.
- Log per-batch progress + a final summary.

**Run them from a workstation with production `DATABASE_URL` + `FIELD_ENCRYPTION_KEY` set, NOT inside a Vercel function.** They iterate the entire row set and can take minutes (or hours for big tables like `audit_log`).

Order doesn't matter across scripts — they touch independent columns. Group them by repo for clarity:

### ledger-core

```bash
cd /path/to/ledger-core
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-journal-entry-memos.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-email-delivery-bodies.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-party-display-names.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-journal-entry-note-bodies.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-tenant-names.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-notification-text.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-legal-entity-and-user-names.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-journal-entry-source-payloads.ts
# AuditLog.metadata — see caveat below
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-audit-log-metadata.ts
```

### recon

```bash
cd /path/to/recon
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-bank-statement-line-descriptions.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-bank-account-fields.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-bank-statement-fields.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-ai-suggestion-candidates.ts
```

### fa-amort

```bash
cd /path/to/fa-amort
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-ai-asset-suggestion-input-text.ts
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-ai-asset-suggestion-output-json.ts
```

### revenue-rec

```bash
cd /path/to/revenue-rec
FIELD_ENCRYPTION_KEY=<key> DATABASE_URL=<prod> \
  npx tsx scripts/encrypt-ai-extraction-suggestions.ts
```

---

## The `AuditLog.metadata` caveat

The script `ledger-core/scripts/encrypt-audit-log-metadata.ts` is **safe to run in production but won't migrate legacy rows** — the append-only `audit_log_no_update` RULE silently no-ops the `UPDATE` statements. New `audit_log` writes from the merge date forward encrypt automatically via the extension's create hook.

Legacy plaintext rows stay plaintext for the 7-year retention window. This is a documented limitation, **not a code bug**.

If you ever need to migrate legacy rows (e.g., a SOC 2 auditor specifically asks), the operational procedure is:

1. Schedule a maintenance window.
2. Open a transaction.
3. `DROP RULE audit_log_no_update ON audit_log;` `DROP RULE audit_log_no_delete ON audit_log;`
4. Run the script to encrypt the legacy rows.
5. Re-create the rules from `prisma/sql/audit-log-append-only.sql`.
6. Commit.

Do **not** do this casually — the append-only invariant is a CC6 control and breaking it must be a deliberate, documented, witnessed event.

---

## Verification (per repo, after backfill)

Run these against production from a workstation with the production `DATABASE_URL` to confirm the rollout took effect.

### ledger-core

```sql
-- Should return 0 (every JE.memo is either NULL or ciphertext)
SELECT count(*) FROM gl_entry_header
WHERE memo IS NOT NULL
  AND (length(memo) % 4 <> 0
       OR memo !~ '^[A-Za-z0-9+/]+={0,2}$'
       OR get_byte(decode(memo, 'base64'), 0) <> 1);

-- Spot-check a recent row: should look like base64 starting with "AQ..."
SELECT id, left(memo, 40) FROM gl_entry_header
WHERE memo IS NOT NULL
ORDER BY "createdAt" DESC LIMIT 3;
```

Adapt the same shape for `email_delivery.subject`, `party.display_name`, `journal_entry_note.body`, `tenant.name`, `notification.title`, `legal_entity.name`, `user.display_name`. For Json columns (`sourcePayload`, `metadata`), the on-disk value is a quoted JSON string holding the ciphertext envelope.

### recon

```sql
-- bank_statement_line.description, bank_account.{displayName, bankName, accountNumberLast4},
-- bank_statement.{filename, rawPayload}, ai_suggestion.candidatesJson — same shape.
```

### fa-amort

```sql
SELECT id, left("inputText", 40) FROM ai_asset_suggestion
WHERE "inputText" IS NOT NULL
ORDER BY "createdAt" DESC LIMIT 3;
```

### revenue-rec

```sql
SELECT id, left(description, 40) FROM revenue_contract
ORDER BY "createdAt" DESC LIMIT 3;

-- Json-mode: the column value is a quoted-string JsonValue
SELECT id, "obligationsJson"::text FROM ai_extraction_suggestion
ORDER BY "createdAt" DESC LIMIT 3;
```

Each spot-check should show ciphertext starting with `AQ` (the base64-encoded version byte). If you see plaintext, **stop** — investigate before continuing.

---

## Rollback

If the rollout produces unrecoverable errors, the rollback path is:

1. Revert the Vercel deployment to the pre-merge commit (Vercel dashboard → Deployments → Promote).
2. Encrypted rows on disk stay readable as long as `FIELD_ENCRYPTION_KEY` is set in Vercel env — the old code just won't auto-decrypt them, so display surfaces will show base64 strings.
3. For a true rollback (re-plaintext the rows), there is **no automated path** — you'd need to write a one-off decrypt-then-write script. Don't do this casually.

A backup branch (Neon `pre-soc2-rollout`) created in pre-flight step 3 is your insurance.

---

## Sign-off

After all backfills complete and verification passes, append a row to `docs/SOC2_READINESS.md` with:

- Date of rollout
- Operator name
- Verification command outputs (counts of encrypted rows per column)
- Key fingerprint (first 8 hex chars of `FIELD_ENCRYPTION_KEY` for record — the full key stays in 1Password)

This row is the SOC 2 audit-evidence record for CC6 Confidentiality TSC.

---

## See also

- `docs/policies/data-classification.md` — what's classified CONFIDENTIAL and why
- `docs/policies/change-management.md` — the CC8 PR-based merge policy
- `src/lib/db/encrypted-fields-extension.ts` — the column registry (single source of truth)
- `src/lib/soc2/field-encryption.ts` — the AES-256-GCM helper
