// Generic outbound webhook — a close alert delivered to any HTTPS
// endpoint, in a shape that is ours rather than Slack's.
//
// Slack's sender formats Block Kit, which is a presentation format for
// one vendor. A generic receiver wants data: stable field names it can
// parse, a version to branch on, and a way to know the request is
// genuinely from us. That last part is the whole reason this module is
// more than a fetch call.
//
// SIGNING follows the shape Stripe popularised, because receivers'
// engineers already know it:
//
//   X-LedgerCore-Timestamp: <unix seconds>
//   X-LedgerCore-Signature: sha256=<hex HMAC of "<timestamp>.<body>">
//
// The timestamp is INSIDE the signed material, so a captured request
// cannot be replayed later with a fresh timestamp — changing it
// invalidates the signature. Receivers should reject anything older
// than their tolerance (a few minutes) and compare the signature with
// a timing-safe function; `verifyWebhookSignature` here is exactly
// that, exported so our own tests and any receiver we write use the
// same code rather than a second implementation that drifts.
//
// Unsigned delivery is permitted — some endpoints sit behind their own
// network controls — but it is a per-channel decision the admin UI
// spells out, not a default that happens quietly.
//
// The payload deliberately carries NO money. Close alerts are about
// process state (a reconciliation in exception, a blocked task), and
// an outbound webhook crosses a trust boundary; balances are available
// to an authenticated caller through the API, not pushed into someone
// else's logs.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { CloseAlert } from "@/lib/close/alerts";

const WEBHOOK_TIMEOUT_MS = 5000;

/** Bump when the envelope's shape changes incompatibly. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

export const SIGNATURE_HEADER = "X-LedgerCore-Signature";
export const TIMESTAMP_HEADER = "X-LedgerCore-Timestamp";
export const EVENT_HEADER = "X-LedgerCore-Event";

export interface GenericWebhookPayload {
  version: number;
  event: "close.alert" | "close.alert.digest";
  sentAt: string;
  scope: { entity: string; book: string; period: string | null };
  alerts: Array<{
    id: string;
    pillar: string;
    severity: string;
    title: string;
    description: string;
    ageDays: number | null;
    href: string | null;
  }>;
}

export function formatGenericPayload(
  alerts: CloseAlert[],
  ctx: {
    event: GenericWebhookPayload["event"];
    sentAt: Date;
    appBaseUrl: string;
    entity: string;
    book: string;
    period: string | null;
  }
): GenericWebhookPayload {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    event: ctx.event,
    sentAt: ctx.sentAt.toISOString(),
    scope: { entity: ctx.entity, book: ctx.book, period: ctx.period },
    alerts: alerts.map((a) => ({
      id: a.id,
      pillar: a.pillar,
      severity: a.severity,
      title: a.title,
      description: a.description,
      ageDays: a.ageDays ?? null,
      // Absolute so the receiver can link straight back.
      href: a.href ? `${ctx.appBaseUrl}${a.href}` : null,
    })),
  };
}

/** The exact bytes that get signed: "<timestamp>.<body>". */
export function signedMaterial(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

export function computeSignature(
  secret: string,
  timestamp: number,
  body: string
): string {
  const mac = createHmac("sha256", secret)
    .update(signedMaterial(timestamp, body))
    .digest("hex");
  return `sha256=${mac}`;
}

/**
 * Verify a delivery. Timing-safe, and false rather than throwing on
 * malformed input so a receiver can treat every failure the same way.
 *
 * `toleranceSeconds` bounds replay: a captured request stops being
 * accepted once its timestamp ages out, and the timestamp cannot be
 * refreshed without breaking the signature.
 */
export function verifyWebhookSignature(args: {
  secret: string;
  timestamp: number;
  body: string;
  signature: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSeconds ?? 300;
  if (!Number.isFinite(args.timestamp)) return false;
  if (Math.abs(now - args.timestamp) > tolerance) return false;

  const expected = computeSignature(args.secret, args.timestamp, args.body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(args.signature, "utf8");
  // timingSafeEqual throws on length mismatch; a length difference is
  // already a mismatch, so answer it without leaking through an throw.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type GenericSendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

/**
 * POST the envelope. Returns a structured result rather than throwing,
 * matching the Slack sender so the dispatch loop treats both the same.
 *
 * The response body is drained but never echoed into the error string:
 * a third-party endpoint can put anything in there, including the URL
 * it was called on, and that string is persisted on the dispatch row.
 * The status code is the operational signal.
 */
export async function sendGenericWebhook(
  webhookUrl: string,
  payload: GenericWebhookPayload,
  opts?: { signingSecret?: string | null; nowSeconds?: number }
): Promise<GenericSendResult> {
  const body = JSON.stringify(payload);
  const timestamp = opts?.nowSeconds ?? Math.floor(Date.now() / 1000);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [EVENT_HEADER]: payload.event,
    [TIMESTAMP_HEADER]: String(timestamp),
  };
  if (opts?.signingSecret) {
    headers[SIGNATURE_HEADER] = computeSignature(
      opts.signingSecret,
      timestamp,
      body
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `Webhook returned HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, status: null, error: "Webhook timeout (5s)" };
    }
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "Unknown webhook fetch error",
    };
  } finally {
    clearTimeout(timer);
  }
}
