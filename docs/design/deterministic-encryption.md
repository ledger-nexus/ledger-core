# Design: deterministic encryption for filter-keyed columns

**Status:** Proposed (2026-05-31). Not yet implemented.
**Depends on:** The standard field-encryption helper and Prisma extension shipped in the SOC 2 hardening rollout (commits `a7ebfe8` + `664d6c3`). Read those first.
**Unblocks:** Encryption of `User.email`, `TenantInvite.email`, `Tenant.slug`, `JournalEntryNote.authorEmail`, and any future column that needs equality lookups.

---

## Problem

The standard AES-256-GCM extension uses a random IV per encryption, so the same plaintext encrypts to a different ciphertext every time. This is the right default for confidentiality — but it makes equality lookups impossible:

```ts
// Doesn't work — `email` on disk is random ciphertext, never equals the searched value.
await prisma.user.findUnique({ where: { email: "alice@acme.test" } });
```

Login, invite acceptance, slug-routed page loads, and audit-log author lookup all need this. The current rollout leaves 4 known columns plaintext for this reason:

- `User.email` — auth-keyed; login flow uses `findUnique({ where: { email } })`.
- `TenantInvite.email` — the accept flow + duplicate-invite refusal both filter by email.
- `Tenant.slug` — URL routing reads `findUnique({ where: { slug } })` on every page load.
- `JournalEntryNote.authorEmail` — snapshotted at write so authorship survives User deletion; UI filters by it on the per-user activity panel.

These are PII (CC6 / Confidentiality TSC) and should be encrypted at rest. We need a scheme that supports equality search.

---

## Non-goals

- **Range queries** (`email LIKE 'alice%'`). Only equality. If anyone needs to type-ahead search by partial email, we'd need a different design (encrypted full-text index or a separate hash-of-substrings table).
- **Case-insensitive search beyond a normalized form.** We will normalize before hashing (`.trim().toLowerCase()` for emails, exact-match for slugs). The DB sees only the normalized hash; the original casing is preserved inside the AES-GCM ciphertext.
- **Rotation without downtime.** Rotation procedure documented below requires a maintenance window. Not a continuous-rekeying scheme.
- **Per-tenant keys.** A single portfolio-wide HMAC key. Per-tenant would require key derivation + a key-id column on every row and complicate lookup. Future workstream if needed for compliance (e.g., BYOK).

---

## Design

### Storage shape: two columns per searchable encrypted field

For each `<field>` that needs both encryption and equality search:

| Column | Type | Purpose |
|---|---|---|
| `<field>` | `String` (existing) | AES-256-GCM ciphertext of the original plaintext. Random IV per encryption. Stores the original casing and any trailing whitespace. Same wire format as today's helper. |
| `<field>Hash` | `Bytes` (new — `@db.ByteA`) | HMAC-SHA256 of the **normalized** plaintext, keyed by a separate `FIELD_DETERMINISTIC_KEY`. 32 bytes. Indexed (`@@index([<field>Hash])` or `@unique` if applicable). |

Lookup flow:

```ts
// At the call site (login, invite accept, slug routing):
const hash = deterministicSearchHash("email", "Alice@Acme.test");
const user = await prisma.user.findUnique({ where: { emailHash: hash } });
// → user.email is auto-decrypted by the extension to "Alice@Acme.test"
```

Write flow (extension auto-handles):

```ts
// At the call site:
await prisma.user.create({ data: { email: "Alice@Acme.test", ... } });

// Extension does:
//   data.email     = AES-GCM-encrypt("Alice@Acme.test")           // random IV
//   data.emailHash = HMAC-SHA256(normalize("Alice@Acme.test"))    // deterministic
```

### Why two columns instead of AES-SIV?

We considered four options:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. AES-SIV (synthetic IV)** | Single column. Deterministic AEAD. Well-studied. | Not in Node's stdlib `crypto` (needs `@noble/ciphers` or similar). Leaks duplicates on the encrypted column directly. | Skipped — extra dep + same leakage as two-column. |
| **B. HMAC search hash + AES-GCM ciphertext (two columns)** ✅ | Uses Node stdlib only. Search column is small (32 bytes), indexes cleanly. Encrypted column stays in the standard rollout's format (helps future column unification). Duplicates leak from the search column, not the ciphertext. | Two columns per field. Slightly more storage. Schema migration per column. | **Chosen.** Aligns with the existing extension. |
| **C. Hash-only (no encryption)** | Simplest. One column. | **Unrecoverable.** Can't display email back to the user, can't satisfy GDPR data-export, can't recover for legal compliance. | Disqualified — destroys the data. |
| **D. Probabilistic encryption + blind-index table** | Main table doesn't leak duplicates via the hash. | Extra join on every lookup. Two-table sync risk. | Skipped — the duplicate leak is already constrained (see "What this leaks" below) and the join cost is real. |

### Normalization rules

Each `<field>` declares its normalization in the registry:

```ts
{ model: "User", field: "email", searchHash: "deterministic", normalize: "emailLowercase" }
{ model: "TenantInvite", field: "email", searchHash: "deterministic", normalize: "emailLowercase" }
{ model: "Tenant", field: "slug", searchHash: "deterministic", normalize: "exact" }
{ model: "JournalEntryNote", field: "authorEmail", searchHash: "deterministic", normalize: "emailLowercase" }
```

Normalizers:

- `emailLowercase` — `.trim().toLowerCase()`. RFC 5321 §2.4 says the local-part is technically case-sensitive but no one operates that way; this matches the existing login behavior.
- `exact` — no transformation. For slugs and other case-sensitive identifiers.

Add new normalizers as the registry expands. **Never** silently change a normalizer for an existing column — that invalidates every hash on disk for that column and requires the rotation procedure.

### Key separation

Two separate environment-variable keys:

- `FIELD_ENCRYPTION_KEY` — 64 hex chars. Already deployed. Drives AES-256-GCM.
- `FIELD_DETERMINISTIC_KEY` — 64 hex chars. New. Drives HMAC-SHA256 for the search hash.

Why separate? Defense in depth. The HMAC key needs much less protection than the encryption key — if HMAC leaks, an attacker can hash candidate emails and check for matches in the search-hash column (offline dictionary attack), but they still can't decrypt the ciphertext. If the encryption key leaks, they can decrypt the existing rows but still can't search (unless they also have the HMAC key). Splitting forces an attacker to compromise both keys for full damage.

Both keys live in Vercel env (RESTRICTED per `docs/policies/data-classification.md`). Same 1Password storage discipline.

### Helper API

New file `src/lib/soc2/deterministic-encryption.ts`:

```ts
import { createHmac } from "node:crypto";

const KEY_BYTES = 32;
const HASH_BYTES = 32; // SHA-256 output

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.FIELD_DETERMINISTIC_KEY;
  if (!hex) throw new KeyNotConfiguredError("FIELD_DETERMINISTIC_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new FieldEncryptionError("FIELD_DETERMINISTIC_KEY must be 64 hex chars.");
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

export type Normalizer = "emailLowercase" | "exact";

export function normalize(value: string, mode: Normalizer): string {
  switch (mode) {
    case "emailLowercase":
      return value.trim().toLowerCase();
    case "exact":
      return value;
  }
}

/**
 * Returns the 32-byte HMAC-SHA256 of the normalized plaintext. Deterministic:
 * same input → same output. Use as a search-key value when writing the *Hash
 * column and when filtering in WHERE clauses.
 *
 * `domain` separates hashes across columns so a hash from User.email can't
 * collide with the same plaintext hashed for TenantInvite.email — defense
 * against cross-column lookup attacks.
 */
export function searchHash(
  domain: string,
  plaintext: string,
  mode: Normalizer
): Buffer {
  const key = loadKey();
  const h = createHmac("sha256", key);
  h.update(domain, "utf8");
  h.update("\x00", "utf8"); // domain separator — null byte never legal in input
  h.update(normalize(plaintext, mode), "utf8");
  return h.digest();
}

/** Test helper. */
export function _setKeyForTesting(key: Buffer | null): void {
  cachedKey = key;
}
```

`domain` is the qualified column name (`"User.email"`, `"TenantInvite.email"`, etc.). The hash of `"alice@acme.test"` under `"User.email"` is different from the hash of the same plaintext under `"TenantInvite.email"` — so if an attacker dumps the search-hash columns and tries to correlate, the hashes don't line up across tables.

### Extension integration

Two changes to `src/lib/db/encrypted-fields-extension.ts`:

1. **Registry schema grows** an optional `searchHash` + `normalize` per entry:

   ```ts
   export const ENCRYPTED_COLUMNS: ReadonlyArray<{
     model: string;
     field: string;
     type?: EncryptedColumnType;
     /** Only set for columns that need equality search. */
     searchHash?: { hashColumn: string; domain: string; normalize: Normalizer };
   }> = [
     // existing rows unchanged
     {
       model: "User",
       field: "email",
       searchHash: {
         hashColumn: "emailHash",
         domain: "User.email",
         normalize: "emailLowercase",
       },
     },
     // ...
   ];
   ```

2. **Write hooks compute the hash alongside encrypting:**

   ```ts
   // Pseudo-code in encryptDataObject:
   for (const col of fieldsForModel(model)) {
     if (!(col.field in data)) continue;
     const plaintext = data[col.field];
     if (plaintext == null) continue;
     data[col.field] = encryptField(plaintext); // existing path
     if (col.searchHash) {
       data[col.searchHash.hashColumn] = searchHash(
         col.searchHash.domain,
         plaintext,
         col.searchHash.normalize
       );
     }
   }
   ```

3. **Read hooks don't change** — decryption is the same. The search-hash column is just a `Bytes` field that flows through unchanged.

4. **Lookup-helper exports** (new, lives in `src/lib/soc2/index.ts` re-exports):

   ```ts
   /** Computes the search-hash value to use in a WHERE clause for User.email. */
   export function searchHashForUserEmail(email: string): Buffer {
     return searchHash("User.email", email, "emailLowercase");
   }
   // ...one helper per searchable column. Hides the domain string from callers.
   ```

   Call sites update from:

   ```ts
   await prisma.user.findUnique({ where: { email } });
   ```

   To:

   ```ts
   await prisma.user.findUnique({ where: { emailHash: searchHashForUserEmail(email) } });
   ```

### Schema migrations

Per column:

```sql
-- Example: User.email
ALTER TABLE "user" ADD COLUMN "emailHash" BYTEA;
CREATE UNIQUE INDEX "user_emailHash_key" ON "user"("emailHash");

-- For tenant-scoped uniqueness (TenantInvite.email):
ALTER TABLE "tenant_invite" ADD COLUMN "emailHash" BYTEA;
CREATE UNIQUE INDEX "tenant_invite_tenantId_emailHash_key"
  ON "tenant_invite"("tenantId", "emailHash");
```

The original `@unique` on `email` should be **dropped** after the rollout completes — once the hash column is populated and queries route through it, the email column itself is just ciphertext and a unique constraint on ciphertext is meaningless (random IV ensures uniqueness automatically). Dropping it is part of the cleanup step in the rollout procedure below.

---

## Rollout procedure (per column)

Documented as a runbook section to add to `docs/runbooks/encryption-rollout.md` once implemented.

1. **Deploy the helper.** Land `deterministic-encryption.ts` + the extension registry expansion. `FIELD_DETERMINISTIC_KEY` must be set in Vercel env BEFORE this deploys; otherwise new writes will throw.
2. **Add the `*Hash` column.** Schema migration adds the nullable BYTEA column. Existing rows have NULL hash; new writes start populating it.
3. **Backfill.** A script reads existing rows, computes the hash from the (still plaintext on disk) original value, and writes both the hash and the AES-GCM ciphertext. Idempotent via `looksEncrypted`.
4. **Update call sites to use the hash.** Switch every `findUnique({ where: { email } })` and `findFirst({ where: { email } })` to use the hash-based helper. Tests must update too.
5. **Add `NOT NULL` constraint to the hash column.** Once the backfill is complete and every write writes the hash, the column can be required.
6. **Drop the old `@unique` on the encrypted column.** Random-IV ciphertext is already unique by construction.
7. **Verify.** SQL probe confirms every row has a non-null hash; no call sites remain that use the plaintext column in a WHERE clause.

---

## What this leaks (CC6 honest disclosure)

Equality between two rows in the SAME column is observable:

- If `users[1].emailHash === users[2].emailHash`, an attacker reading the DB knows those two rows have the same email.
- For email specifically, this should never happen (the column was previously `@unique`), so it's a no-op leak.
- For columns where duplicates are legal (e.g., `JournalEntryNote.authorEmail` — many notes can be written by the same author), the search-hash column DOES reveal "these notes were written by the same person" without revealing who.

This is the standard tradeoff for any deterministic encryption / searchable encryption scheme. We accept it because:

- A leaked dump shows equivalence classes, not the plaintext email itself.
- Without the HMAC key, an attacker can't translate the hashes back to plaintext (no offline dictionary attack without the key).
- With BOTH the HMAC key AND the dump, the attacker can hash candidate emails and look for matches — but they still can't decrypt the AES-GCM ciphertext to reveal the original casing or trailing whitespace, which matters for some uses.

For columns where even the equivalence-class leak is unacceptable, we'd fall back to a blind-index table (Option D in the design tradeoff matrix above) — not in scope here.

The full leak posture is documented in `docs/policies/data-classification.md` once this lands, with each column annotated `searchable-encrypted` vs `encrypted` vs `plaintext`.

---

## Rotation

Hard. Either key rotation invalidates a different surface of the on-disk data:

- **Rotate `FIELD_ENCRYPTION_KEY`** — every AES-GCM ciphertext column becomes undecryptable. Requires re-encrypting every row. The existing rollout already needs this procedure documented.
- **Rotate `FIELD_DETERMINISTIC_KEY`** — every search-hash column becomes meaningless. Login + slug-routing + invite-accept all break instantly.

The deterministic-key rotation procedure is uglier than encryption-key rotation because the search hash is in a WHERE clause:

1. Add a new column `<field>HashV2` alongside `<field>Hash`.
2. Update the extension to write both columns on new writes.
3. Backfill V2 from existing rows (decrypt with current encryption key, recompute hash with new deterministic key, write).
4. Update every call site to use the V2 column in WHERE clauses.
5. Drop the V1 column.

Per column, requires a maintenance window unless you tolerate temporarily having BOTH columns indexed (extra storage + write cost). Don't rotate casually.

A separate runbook for rotation lands when the first rotation event happens. For now: pick a strong key, store it well, don't rotate.

---

## Implementation phasing

I'd split the implementation across at least three PRs, in order:

### Phase 1 — Helper + extension support (no column rollouts yet)

- New `src/lib/soc2/deterministic-encryption.ts` with `searchHash`, normalizers, key loader, error types.
- Registry schema in the extension grows the optional `searchHash` field (no rows use it yet).
- Tests for the helper: roundtrip, key-missing, key-malformed, normalizer correctness, domain-separation (User.email vs TenantInvite.email of same plaintext produce different hashes).
- `/api/health` adds `deterministicEncryption: { configured: boolean }` mirroring the existing encryption check.
- Runbook section for setting `FIELD_DETERMINISTIC_KEY` in Vercel env.

### Phase 2 — `User.email` (the bellwether)

- Schema migration: add `User.emailHash` BYTEA + `@unique`.
- Registry entry for `User.email` with `searchHash`.
- Backfill script.
- Update every `findUnique({ where: { email } })` call site (auth + admin + GDPR export). Probably a dozen sites.
- Tests for the auth flow with encryption on.
- Document the auth-flow timing impact (HMAC adds ~10µs per login — negligible).

### Phase 3 — `TenantInvite.email` + `Tenant.slug` + `JournalEntryNote.authorEmail`

Same pattern, one PR per column. Or batch the remaining three if confidence is high after Phase 2 lands.

Total estimated effort: ~3-5 sessions across the three phases.

---

## Open questions

- **Should `Tenant.slug` use this scheme or stay plaintext?** Slugs are URL components and customers may want to recognize them; encrypting them complicates customer support ("what's my slug?"). Possible compromise: keep `slug` plaintext but encrypt `name`, accept that the URL leaks "this customer's slug." Need a product call.
- **Should we add `searchHash` to existing String columns retroactively?** E.g., adding a search hash to `Party.code` would let recon's CSV importer match by party code without exposing the code in a query log. Probably yes, but not urgent.
- **Does the BYTEA search-hash column show up in GDPR exports?** Yes — it's still customer-derived data. Mention this in `src/lib/privacy/user-data.ts` when implementing.

---

## See also

- `src/lib/soc2/field-encryption.ts` — the AES-256-GCM helper that ships today.
- `src/lib/db/encrypted-fields-extension.ts` — the Prisma extension that will grow `searchHash` support.
- `docs/runbooks/encryption-rollout.md` — the runbook this will extend.
- `docs/policies/data-classification.md` — where the per-column posture (`plaintext` / `encrypted` / `searchable-encrypted`) gets documented.
