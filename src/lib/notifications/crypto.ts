// Webhook-URL encryption (AES-256-GCM, application-layer).
//
// Channel webhook URLs are sensitive — anyone with the URL can post
// to that Slack channel. We never want them sitting in plaintext in
// the DB or in any audit-log payload that gets exported.
//
// We rely on Node's `crypto` module rather than a third-party
// library — minimal surface area + audited primitives. GCM gives
// authenticated encryption (integrity + confidentiality) in one
// pass; the auth tag detects tampering.
//
// Key management: WEBHOOK_ENCRYPTION_KEY env var, 32 bytes base64-
// encoded. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Rotation: re-encrypt the channel rows under the new key + drop the
// old one. Not implemented in v1 — sized for portfolio scale (~10
// channels per tenant) where one-shot manual rotation is acceptable.
// Larger deployments would want a versioned KMS scheme.
//
// SOC 2:
//   CC6.7  no plaintext webhook URLs at rest
//   CC6.7  WEBHOOK_ENCRYPTION_KEY required at boot — sourceUrl helper
//          throws if it's missing; the calling code surfaces a clear
//          error rather than silently writing plaintext.
//   CC7.2  decryption failures are logged (via thrown error), not
//          silently swallowed.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";

const ALGO = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32; // 256-bit key
const IV_LENGTH_BYTES = 12; // GCM-standard 96-bit IV
const TAG_LENGTH_BYTES = 16; // GCM auth tag

/**
 * Loads the encryption key from the `WEBHOOK_ENCRYPTION_KEY` env var.
 * Throws if the env var is missing or doesn't decode to a 32-byte buffer.
 *
 * Module-level memoization would be unsafe — tests reset env between
 * runs. Read per-call; the cost is negligible (a single base64 decode).
 */
function getKey(): Buffer {
  const raw = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY is not set — refusing to encrypt or decrypt webhook URLs"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `WEBHOOK_ENCRYPTION_KEY must decode to ${KEY_LENGTH_BYTES} bytes (got ${key.length})`
    );
  }
  return key;
}

/**
 * Encrypts a webhook URL (or any short string < 4 KiB) and returns a
 * base64-encoded `iv:tag:ciphertext` triple as a single string. The
 * IV is generated fresh per call — never reuse with the same key.
 */
export function encryptWebhookUrl(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Packed format: iv || tag || ciphertext, base64'd. Single field
  // avoids juggling three columns in the schema.
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypts a previously-encrypted webhook URL. Throws on:
 *   - Missing / wrong-length key (env config error)
 *   - Truncated ciphertext (DB corruption)
 *   - Failed auth tag (wrong key OR tampering)
 * The thrown error is the SOC 2 CC7.2 signal — caller decides whether
 * to surface, log-and-skip, or alert.
 */
export function decryptWebhookUrl(encoded: string): string {
  const key = getKey();
  const buf = Buffer.from(encoded, "base64");
  const minLength = IV_LENGTH_BYTES + TAG_LENGTH_BYTES + 1;
  if (buf.length < minLength) {
    throw new Error(
      `Ciphertext too short — expected ≥${minLength} bytes, got ${buf.length}`
    );
  }
  const iv = buf.subarray(0, IV_LENGTH_BYTES);
  const tag = buf.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
  const ct = buf.subarray(IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Returns a masked representation safe to display in audit logs and
 * UI. Shows the URL host and a short hash of the path so the operator
 * can tell two channels apart without leaking the secret.
 *
 * For `https://hooks.slack.com/services/T123/B456/abcDEF...` returns
 * `https://hooks.slack.com/services/T123/B456/***` with the last
 * segment redacted.
 */
export function maskWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return `${u.protocol}//${u.host}/***`;
    const lastIdx = parts.length - 1;
    parts[lastIdx] = "***";
    return `${u.protocol}//${u.host}/${parts.join("/")}`;
  } catch {
    return "***invalid-url***";
  }
}

/**
 * Constant-time equality check for ciphertext / signature comparison.
 * Re-exported so callers don't have to import from `crypto` directly.
 */
export function timingSafeEqualB64(a: string, b: string): boolean {
  const ab = Buffer.from(a, "base64");
  const bb = Buffer.from(b, "base64");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
