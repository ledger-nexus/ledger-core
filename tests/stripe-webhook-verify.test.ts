// Stripe webhook signature verification tests. Pure crypto + parsing —
// no DB, no HTTP. The security of the billing endpoint hangs on this
// module behaving correctly.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyAndParseWebhook,
  WebhookVerificationError,
  _internal,
} from "../src/lib/billing/verify-webhook";

const SECRET = "whsec_test_secret_value_for_tests_only";
const BODY = JSON.stringify({ id: "evt_test", type: "customer.subscription.created" });

function makeSig(secret: string, ts: number, body: string): string {
  const h = createHmac("sha256", secret);
  h.update(`${ts}.${body}`, "utf8");
  return h.digest("hex");
}

describe("verifyAndParseWebhook", () => {
  it("accepts a correctly-signed payload", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = makeSig(SECRET, now, BODY);
    const header = `t=${now},v1=${sig}`;
    const parsed = verifyAndParseWebhook<{ id: string; type: string }>(
      BODY,
      header,
      SECRET,
      now
    );
    expect(parsed.id).toBe("evt_test");
    expect(parsed.type).toBe("customer.subscription.created");
  });

  it("accepts when one of multiple v1 signatures matches (key rotation)", () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongSig = "0".repeat(64);
    const goodSig = makeSig(SECRET, now, BODY);
    const header = `t=${now},v1=${wrongSig},v1=${goodSig}`;
    expect(() =>
      verifyAndParseWebhook(BODY, header, SECRET, now)
    ).not.toThrow();
  });

  it("rejects when the signature is wrong", () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongSig = "0".repeat(64);
    const header = `t=${now},v1=${wrongSig}`;
    expect(() =>
      verifyAndParseWebhook(BODY, header, SECRET, now)
    ).toThrow(WebhookVerificationError);
  });

  it("rejects when the body has been tampered with", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = makeSig(SECRET, now, BODY);
    const tamperedBody = BODY.replace("evt_test", "evt_pwned");
    const header = `t=${now},v1=${sig}`;
    expect(() =>
      verifyAndParseWebhook(tamperedBody, header, SECRET, now)
    ).toThrow(WebhookVerificationError);
  });

  it("rejects when the timestamp is too old", () => {
    const longAgo = Math.floor(Date.now() / 1000) - _internal.TOLERANCE_SECONDS - 1;
    const sig = makeSig(SECRET, longAgo, BODY);
    const header = `t=${longAgo},v1=${sig}`;
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      verifyAndParseWebhook(BODY, header, SECRET, now)
    ).toThrow(/tolerance/);
  });

  it("rejects when the timestamp is in the future (replay attack)", () => {
    const future = Math.floor(Date.now() / 1000) + _internal.TOLERANCE_SECONDS + 1;
    const sig = makeSig(SECRET, future, BODY);
    const header = `t=${future},v1=${sig}`;
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      verifyAndParseWebhook(BODY, header, SECRET, now)
    ).toThrow(/tolerance/);
  });

  it("rejects when the header is missing", () => {
    expect(() =>
      verifyAndParseWebhook(BODY, null, SECRET)
    ).toThrow(/missing/);
  });

  it("rejects when the secret is unset", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = makeSig(SECRET, now, BODY);
    const header = `t=${now},v1=${sig}`;
    expect(() =>
      verifyAndParseWebhook(BODY, header, "", now)
    ).toThrow(/unset/);
  });

  it("rejects when the header has no v1 signature", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = `t=${now},v0=deadbeef`;
    expect(() =>
      verifyAndParseWebhook(BODY, header, SECRET, now)
    ).toThrow(/missing v1/);
  });

  it("rejects when the body is not valid JSON despite passing crypto check", () => {
    const now = Math.floor(Date.now() / 1000);
    const badBody = "{this is not json}";
    const sig = makeSig(SECRET, now, badBody);
    const header = `t=${now},v1=${sig}`;
    expect(() =>
      verifyAndParseWebhook(badBody, header, SECRET, now)
    ).toThrow(/not valid JSON/);
  });
});

describe("parseSignatureHeader (internal)", () => {
  it("handles multiple v1 entries", () => {
    const parsed = _internal.parseSignatureHeader(
      "t=1700000000,v1=aaa,v1=bbb,v0=ccc"
    );
    expect(parsed.timestamp).toBe(1700000000);
    expect(parsed.v1Signatures).toEqual(["aaa", "bbb"]);
  });

  it("throws on missing t=", () => {
    expect(() =>
      _internal.parseSignatureHeader("v1=aaa")
    ).toThrow(WebhookVerificationError);
  });
});
