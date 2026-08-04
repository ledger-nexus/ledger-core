// Stripe webhook signature verification.
//
// This is the security boundary for /api/billing/webhook. Without it,
// anyone who can POST to that URL could set their own subscription to
// "active" — the endpoint's whole job is to write entitlement state
// from an unauthenticated request, so the signature IS the auth.
//
// Stripe signs each webhook with HMAC-SHA256 over `${timestamp}.${rawBody}`
// and sends it as `stripe-signature: t=<unix>,v1=<hex>[,v1=<hex>]`
// (multiple v1 values appear during secret rotation). Verification:
//
//   1. Parse the header into { t, v1[] }
//   2. Compute HMAC-SHA256(secret, `${t}.${rawBody}`) as hex
//   3. Constant-time compare against every v1
//   4. Reject if t is outside the 5-minute tolerance window
//
// Step 4 is what stops a replay: a captured-and-resent webhook stays
// perfectly signed forever, so freshness has to come from the timestamp.

import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60; // Stripe's recommended default

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

interface ParsedSignature {
  timestamp: number;
  v1Signatures: string[];
}

function parseSignatureHeader(header: string): ParsedSignature {
  const parts = header.split(",").map((s) => s.trim());
  let timestamp: number | null = null;
  const v1Signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key === "v1") {
      v1Signatures.push(value);
    }
  }
  if (timestamp == null) {
    throw new WebhookVerificationError(
      "stripe-signature header missing timestamp"
    );
  }
  if (v1Signatures.length === 0) {
    throw new WebhookVerificationError(
      "stripe-signature header missing v1 signature"
    );
  }
  return { timestamp, v1Signatures };
}

function computeExpectedSig(
  secret: string,
  timestamp: number,
  rawBody: string
): string {
  const h = createHmac("sha256", secret);
  h.update(`${timestamp}.${rawBody}`, "utf8");
  return h.digest("hex");
}

/**
 * Constant-time compare of two hex strings.
 *
 * Three guards before the timing-safe compare, each load-bearing:
 *
 *   - length equality: timingSafeEqual THROWS on unequal buffer lengths.
 *     Comparing lengths first leaks only the length of a SHA-256 hex
 *     digest, which is a public constant.
 *   - even, non-zero length: an odd or empty string can't be a digest.
 *   - full decode: Buffer.from(s, "hex") does NOT throw on invalid
 *     input — it silently truncates at the first non-hex character. Two
 *     equally-malformed strings would both decode to an empty buffer
 *     and timingSafeEqual would call them EQUAL. Requiring the decoded
 *     length to be exactly half the input closes that.
 */
function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0 || a.length % 2 !== 0) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== a.length / 2 || bb.length !== b.length / 2) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Verify a Stripe webhook signature and return the parsed event body.
 * Throws WebhookVerificationError on any failure.
 *
 * `rawBody` MUST be the verbatim request body. Parse it to JSON and
 * re-serialize and the MAC will not match — key order and whitespace
 * are part of what was signed. Route handlers call this on `req.text()`
 * BEFORE `req.json()`.
 */
export function verifyAndParseWebhook<T = unknown>(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): T {
  if (!signatureHeader) {
    throw new WebhookVerificationError("missing stripe-signature header");
  }
  if (!secret) {
    throw new WebhookVerificationError("STRIPE_WEBHOOK_SECRET env var unset");
  }

  const parsed = parseSignatureHeader(signatureHeader);

  if (Math.abs(nowSeconds - parsed.timestamp) > TOLERANCE_SECONDS) {
    throw new WebhookVerificationError(
      `webhook timestamp outside tolerance (now=${nowSeconds}, ts=${parsed.timestamp})`
    );
  }

  const expected = computeExpectedSig(secret, parsed.timestamp, rawBody);
  const match = parsed.v1Signatures.some((sig) =>
    constantTimeHexEquals(expected, sig)
  );
  if (!match) {
    throw new WebhookVerificationError("webhook signature mismatch");
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new WebhookVerificationError("webhook body is not valid JSON");
  }
}

// Exposed for unit tests only.
export const _internal = {
  parseSignatureHeader,
  computeExpectedSig,
  constantTimeHexEquals,
  TOLERANCE_SECONDS,
};
