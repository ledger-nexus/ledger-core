// Generic outbound webhooks — payload contract and signing.
//
// The signature is the security-bearing part: it is what lets a
// receiver tell a genuine delivery from anything else that can reach
// the URL. So the tests assert what a receiver actually needs —
// tampering with the body fails, replaying an old capture fails, and a
// wrong secret fails — rather than merely that a header is present.
//
// The payload contract matters for a different reason: once someone
// parses `alerts[].severity` in their own system, changing the shape
// breaks them silently. The version field exists to make a break
// explicit, and these cases pin the shape it promises.
//
// DB-free.

import { describe, expect, it } from "vitest";

import {
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_PAYLOAD_VERSION,
  computeSignature,
  formatGenericPayload,
  sendGenericWebhook,
  verifyWebhookSignature,
} from "@/lib/notifications/generic-webhook";
import type { CloseAlert } from "@/lib/close/alerts";

const SECRET = "a-shared-secret-of-decent-length";
const NOW = 1_800_000_000;

const alert = {
  id: "recon:exception:1000",
  pillar: "reconciliation",
  severity: "high",
  title: "Cash — Operating is in exception",
  description: "Difference of 840.00 outside tolerance",
  ageDays: 3,
  href: "/close/reconciliations/abc",
} as unknown as CloseAlert;

function payload() {
  return formatGenericPayload([alert], {
    event: "close.alert",
    sentAt: new Date("2026-08-05T09:00:00Z"),
    appBaseUrl: "https://app.example.com",
    entity: "NORTHWIND",
    book: "US_GAAP",
    period: "2026-06",
  });
}

describe("payload contract", () => {
  it("carries a version, the scope, and flattened alert fields", () => {
    const p = payload();
    expect(p.version).toBe(WEBHOOK_PAYLOAD_VERSION);
    expect(p.event).toBe("close.alert");
    expect(p.sentAt).toBe("2026-08-05T09:00:00.000Z");
    expect(p.scope).toEqual({
      entity: "NORTHWIND",
      book: "US_GAAP",
      period: "2026-06",
    });
    expect(p.alerts).toEqual([
      {
        id: "recon:exception:1000",
        pillar: "reconciliation",
        severity: "high",
        title: "Cash — Operating is in exception",
        description: "Difference of 840.00 outside tolerance",
        ageDays: 3,
        href: "https://app.example.com/close/reconciliations/abc",
      },
    ]);
  });

  it("makes hrefs absolute so a receiver can link back", () => {
    expect(payload().alerts[0].href).toMatch(/^https:\/\/app\.example\.com\//);
  });
});

describe("signing", () => {
  it("verifies a genuine delivery", () => {
    const body = JSON.stringify(payload());
    const sig = computeSignature(SECRET, NOW, body);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: NOW,
        body,
        signature: sig,
        nowSeconds: NOW,
      })
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify(payload());
    const sig = computeSignature(SECRET, NOW, body);
    const tampered = body.replace("high", "low");
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: NOW,
        body: tampered,
        signature: sig,
        nowSeconds: NOW,
      })
    ).toBe(false);
  });

  it("rejects a replay once the timestamp ages out", () => {
    const body = JSON.stringify(payload());
    const sig = computeSignature(SECRET, NOW, body);
    // Same bytes, same signature, captured and re-sent an hour later.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: NOW,
        body,
        signature: sig,
        nowSeconds: NOW + 3600,
      })
    ).toBe(false);
    // And the attacker cannot refresh the timestamp — it is signed.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: NOW + 3600,
        body,
        signature: sig,
        nowSeconds: NOW + 3600,
      })
    ).toBe(false);
  });

  it("rejects the wrong secret, and a malformed signature", () => {
    const body = JSON.stringify(payload());
    const sig = computeSignature(SECRET, NOW, body);
    expect(
      verifyWebhookSignature({
        secret: "not-the-secret-but-same-len!!!!!!",
        timestamp: NOW,
        body,
        signature: sig,
        nowSeconds: NOW,
      })
    ).toBe(false);
    // Length mismatch must answer false, not throw out of timingSafeEqual.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: NOW,
        body,
        signature: "sha256=short",
        nowSeconds: NOW,
      })
    ).toBe(false);
  });
});

describe("delivery", () => {
  it("sends signed headers a receiver can verify end to end", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null =
      null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      };
      return { ok: true, status: 204, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    try {
      const res = await sendGenericWebhook(
        "https://example.com/hooks/lc",
        payload(),
        { signingSecret: SECRET, nowSeconds: NOW }
      );
      expect(res).toEqual({ ok: true, status: 204 });
    } finally {
      globalThis.fetch = original;
    }

    expect(seen!.headers[EVENT_HEADER]).toBe("close.alert");
    expect(seen!.headers[TIMESTAMP_HEADER]).toBe(String(NOW));
    // The receiver's check, run for real against what we actually sent.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: Number(seen!.headers[TIMESTAMP_HEADER]),
        body: seen!.body,
        signature: seen!.headers[SIGNATURE_HEADER],
        nowSeconds: NOW,
      })
    ).toBe(true);
  });

  it("omits the signature header entirely when no secret is set", async () => {
    let headers: Record<string, string> = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    try {
      await sendGenericWebhook("https://example.com/hooks/lc", payload(), {
        signingSecret: null,
      });
    } finally {
      globalThis.fetch = original;
    }
    // Absent, not empty — an empty signature reads like a failed
    // signing attempt and invites a receiver to "handle" it.
    expect(SIGNATURE_HEADER in headers).toBe(false);
  });

  it("never echoes the response body into the error", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 403,
        // A hostile or careless endpoint reflecting the URL back.
        text: async () => "denied for https://example.com/hooks/SECRET-PATH",
      }) as Response) as unknown as typeof fetch;
    try {
      const res = await sendGenericWebhook(
        "https://example.com/hooks/SECRET-PATH",
        payload()
      );
      expect(res.ok).toBe(false);
      // The status is the signal; the body is not persisted anywhere.
      expect(res).toEqual({
        ok: false,
        status: 403,
        error: "Webhook returned HTTP 403",
      });
      expect(JSON.stringify(res)).not.toContain("SECRET-PATH");
    } finally {
      globalThis.fetch = original;
    }
  });
});
