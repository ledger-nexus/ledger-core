// Deterministic search-hash helper — Phase 1 of the deterministic
// encryption workstream described in
// `docs/design/deterministic-encryption.md`.
//
// What this does:
//   Same plaintext + same key → same hash, every time. Enables equality
//   lookups on encrypted columns. Login flow becomes
//   `findUnique({ where: { emailHash: searchHash(...) } })`.
//
// What this does NOT do:
//   Encryption. The hash is one-way (HMAC-SHA256) — you can't recover
//   the original plaintext from it. The actual ciphertext column is
//   still AES-GCM via `field-encryption.ts`. Use this hash in WHERE
//   clauses; use the encrypted column for display.
//
// Wire format:
//   - Algorithm:   HMAC-SHA256
//   - Key:         32 bytes (loaded from FIELD_DETERMINISTIC_KEY env)
//   - Output:      32 raw bytes (no encoding, no prefix). Store as
//                  `Bytes` (PostgreSQL `BYTEA`) in Prisma.
//   - Pre-image:   `domain || NUL || normalize(plaintext, mode)`
//                  where `domain` is the qualified column name
//                  ("User.email", "TenantInvite.email", etc.) — see
//                  "Why a domain" below.
//
// Why a separate key from FIELD_ENCRYPTION_KEY:
//   Defense in depth. If only the HMAC key leaks, an attacker can
//   hash candidate plaintexts and check for matches in the hash column
//   (offline dictionary attack) — but can't decrypt the ciphertext. If
//   only the encryption key leaks, they can decrypt existing rows but
//   can't search by plaintext. Splitting forces an attacker to
//   compromise BOTH keys for full damage.
//
// Why a domain (column-qualified prefix):
//   Without it, the hash of "alice@acme.test" under User.email would
//   equal the hash under TenantInvite.email. An attacker dumping the
//   DB could correlate rows across tables that mention the same email.
//   The domain prevents that — User.email and TenantInvite.email hash
//   the same plaintext to different values.
//
//   The NUL separator between domain and plaintext is so the attacker
//   can't construct a `domain'` and `plaintext'` that concatenate to
//   the same pre-image as a legitimate `domain` and `plaintext`
//   (canonicalization attack). Email/slug/etc. plaintexts can't
//   contain NUL.
//
// Normalization:
//   Each column declares its normalizer. Common pre-image canonicalization
//   policies:
//     - emailLowercase: .trim().toLowerCase()  (matches the existing
//       login behavior; RFC 5321 §2.4 technically makes local-part
//       case-sensitive but no one operates that way)
//     - exact:          no transformation     (for slugs and other
//       case-sensitive identifiers)
//
//   NEVER silently change a normalizer for an existing column — that
//   invalidates every hash on disk and requires the rotation procedure.

import { createHmac, timingSafeEqual } from "node:crypto";
import { FieldEncryptionError } from "./field-encryption";

const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/**
 * Reads `FIELD_DETERMINISTIC_KEY` from the environment and validates
 * its shape (64 hex chars). Cached after the first read.
 *
 * Throws `KeyNotConfiguredError` if the env var is missing — distinct
 * from `FieldEncryptionError` so callers can decide whether to error
 * out (production) or pass through (dev rollout window).
 */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.FIELD_DETERMINISTIC_KEY;
  if (!hex) {
    // KeyNotConfiguredError's message is hard-coded for the encryption
    // key — fall back to a plain FieldEncryptionError with the right
    // env-var name so the operator knows which key to set.
    throw new FieldEncryptionError(
      "FIELD_DETERMINISTIC_KEY env var is not set. Confidential " +
        "columns cannot be deterministically hashed. Generate with " +
        `node -e 'console.log(require("crypto").randomBytes(${KEY_BYTES}).toString("hex"))' ` +
        "and set in Vercel."
    );
  }
  if (hex.length !== KEY_BYTES * 2) {
    throw new FieldEncryptionError(
      `FIELD_DETERMINISTIC_KEY must be ${KEY_BYTES * 2} hex chars ` +
        `(${KEY_BYTES}-byte key); got ${hex.length} chars.`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new FieldEncryptionError(
      "FIELD_DETERMINISTIC_KEY must be hex-encoded (0-9, a-f)."
    );
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

/**
 * The set of normalizers supported by `searchHash`. Add new entries
 * here AND register them in the column registry as a tuple of
 * `{ field, normalize }`. Never mutate an existing normalizer's
 * behavior — that breaks every hash on disk for columns using it.
 */
export type Normalizer = "emailLowercase" | "exact";

/**
 * Apply the per-column canonicalization policy to a plaintext value
 * before hashing. Exported so call sites that need to verify a value
 * matches an on-disk hash (e.g., for a "is this email the one we
 * sent the invite to" check) can use the same rule.
 */
export function normalize(value: string, mode: Normalizer): string {
  switch (mode) {
    case "emailLowercase":
      return value.trim().toLowerCase();
    case "exact":
      return value;
    default: {
      // Exhaustiveness check — TypeScript will error if a new
      // Normalizer is added without a case.
      const _exhaustive: never = mode;
      throw new FieldEncryptionError(`Unknown normalizer: ${_exhaustive}`);
    }
  }
}

/**
 * Compute the HMAC-SHA256 search hash of a plaintext value, suitable
 * for use as a WHERE-clause key (`findUnique({ where: { emailHash:
 * searchHash(...) } })`) and as the value written to the
 * corresponding `*Hash` column.
 *
 * @param domain  The qualified column name (e.g., "User.email") to
 *                separate hashes across columns. Two columns hashing
 *                the same plaintext produce different hashes.
 * @param plaintext  The value to hash. Will be passed through
 *                   `normalize` before HMAC.
 * @param mode    The normalizer policy for this column.
 * @returns Raw 32-byte HMAC-SHA256 digest. Store as `BYTEA`; compare
 *          via Prisma's `Bytes` filters.
 *
 * @throws KeyNotConfiguredError if FIELD_DETERMINISTIC_KEY is unset.
 * @throws FieldEncryptionError if the key is malformed.
 */
export function searchHash(
  domain: string,
  plaintext: string,
  mode: Normalizer
): Buffer {
  if (!domain) {
    throw new FieldEncryptionError("searchHash: `domain` is required.");
  }
  if (domain.includes("\0")) {
    throw new FieldEncryptionError(
      "searchHash: `domain` must not contain NUL (it's the separator)."
    );
  }
  const key = loadKey();
  const h = createHmac("sha256", key);
  h.update(domain, "utf8");
  h.update("\x00", "utf8"); // canonical pre-image separator
  h.update(normalize(plaintext, mode), "utf8");
  return h.digest();
}

/**
 * Compare two search-hash buffers in constant time. Use when verifying
 * a freshly computed hash against an on-disk one in application code
 * (e.g., a webhook signature path). Prisma's `findUnique` does its own
 * equality at the SQL layer; this is only for in-process comparison.
 */
export function searchHashEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────
// Test helpers — only callable from tests / scripts. Never from
// production code paths.
// ─────────────────────────────────────────────────────────────────────

/**
 * Reset the cached key. Tests that inject a key via `process.env`
 * after import must call this so the next `searchHash` call re-reads.
 */
export function _setKeyForTesting(key: Buffer | null): void {
  cachedKey = key;
}
