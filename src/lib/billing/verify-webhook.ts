// Stripe webhook signature verification.
//
// Stripe signs every webhook with an HMAC-SHA256 over the raw request
// body + a timestamp. The signature is sent in the `stripe-signature`
// header as `t=<unix-ts>,v1=<hex-mac>,v0=<deprecated>`. To verify:
//
//   1. Parse the header into {t, v1}
//   2. Compute HMAC-SHA256(secret, `${t}.${rawBody}`) -> hex
//   3. Constant-time compare against v1
//   4. Reject if timestamp is older than the tolerance window (5 min)
//
// This is the security boundary for the billing webhook endpoint —
// without it, anyone who can POST to /api/billing/webhook could mark
// their subscription "active" by hand.

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
  // Format: "t=<unix>,v1=<hex>,v1=<hex>" (multiple v1s during key rotation).
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
    throw new WebhookVerificationError("stripe-signature header missing timestamp");
  }
  if (v1Signatures.length === 0) {
    throw new WebhookVerificationError("stripe-signature header missing v1 signature");
  }
  return { timestamp, v1Signatures };
}

function computeExpectedSig(secret: string, timestamp: number, rawBody: string): string {
  const h = createHmac("sha256", secret);
  h.update(`${timestamp}.${rawBody}`, "utf8");
  return h.digest("hex");
}

function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify a Stripe webhook signature. Returns the parsed event body
 * (JSON) on success. Throws WebhookVerificationError on any failure.
 *
 * The rawBody MUST be the verbatim request body — once it's parsed
 * to JSON and re-serialized, the MAC will not match. Route handlers
 * should call this BEFORE req.json().
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
  const match = parsed.v1Signatures.some((sig) => constantTimeHexEquals(expected, sig));
  if (!match) {
    throw new WebhookVerificationError("webhook signature mismatch");
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new WebhookVerificationError("webhook body is not valid JSON");
  }
}

// Exposed for unit tests.
export const _internal = {
  parseSignatureHeader,
  computeExpectedSig,
  constantTimeHexEquals,
  TOLERANCE_SECONDS,
};
