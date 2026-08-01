// Stripe webhook signature verification (#46 harvest slice ⑦).
//
// This module is the entire access control on /api/billing/webhook — an
// unauthenticated endpoint that writes subscription entitlement. If it
// accepts something it shouldn't, anyone who can reach the URL can mark
// their own workspace "active" on the Scale plan.
//
// So the tests are adversarial: forged MAC, wrong secret, tampered body,
// replayed timestamp, malformed header, non-hex garbage.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyAndParseWebhook,
  WebhookVerificationError,
  _internal,
} from "@/lib/billing/verify-webhook";

const SECRET = "whsec_test_secret_value_for_tests_only";
const BODY = JSON.stringify({
  id: "evt_test",
  type: "customer.subscription.created",
});

function sign(secret: string, ts: number, body: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
}

function header(ts: number, sig: string): string {
  return `t=${ts},v1=${sig}`;
}

const NOW = 1_800_000_000; // fixed clock; passed explicitly, never Date.now()

describe("accepts what Stripe actually sends", () => {
  it("a correctly-signed payload parses", () => {
    const h = header(NOW, sign(SECRET, NOW, BODY));
    const parsed = verifyAndParseWebhook<{ id: string; type: string }>(
      BODY,
      h,
      SECRET,
      NOW
    );
    expect(parsed.id).toBe("evt_test");
    expect(parsed.type).toBe("customer.subscription.created");
  });

  it("accepts when ANY v1 matches — the secret-rotation case", () => {
    // During a rotation Stripe signs with both the old and new secret
    // and sends two v1 values. Matching only the first would break
    // every webhook for the length of the rotation window.
    const good = sign(SECRET, NOW, BODY);
    const other = sign("whsec_some_other_secret_value_here", NOW, BODY);
    expect(
      verifyAndParseWebhook(BODY, `t=${NOW},v1=${other},v1=${good}`, SECRET, NOW)
    ).toBeTruthy();
  });

  it("tolerates a clock skew inside the window", () => {
    const ts = NOW - (_internal.TOLERANCE_SECONDS - 5);
    expect(
      verifyAndParseWebhook(BODY, header(ts, sign(SECRET, ts, BODY)), SECRET, NOW)
    ).toBeTruthy();
  });
});

describe("rejects everything else", () => {
  it("a forged signature", () => {
    expect(() =>
      verifyAndParseWebhook(BODY, header(NOW, "0".repeat(64)), SECRET, NOW)
    ).toThrow(WebhookVerificationError);
  });

  it("a payload signed with the wrong secret", () => {
    const h = header(NOW, sign("whsec_attacker_secret", NOW, BODY));
    expect(() => verifyAndParseWebhook(BODY, h, SECRET, NOW)).toThrow(
      /signature mismatch/
    );
  });

  it("a tampered body under a valid signature", () => {
    // The exact attack the MAC exists to stop: capture a real webhook,
    // swap the plan, resend.
    const h = header(NOW, sign(SECRET, NOW, BODY));
    const tampered = JSON.stringify({ id: "evt_test", type: "hacked" });
    expect(() => verifyAndParseWebhook(tampered, h, SECRET, NOW)).toThrow(
      /signature mismatch/
    );
  });

  it("a replay from outside the tolerance window", () => {
    // Still perfectly signed — an old webhook stays valid forever. Only
    // the timestamp check makes it stale.
    const old = NOW - (_internal.TOLERANCE_SECONDS + 1);
    expect(() =>
      verifyAndParseWebhook(BODY, header(old, sign(SECRET, old, BODY)), SECRET, NOW)
    ).toThrow(/outside tolerance/);
  });

  it("a timestamp from the future, past tolerance", () => {
    const future = NOW + (_internal.TOLERANCE_SECONDS + 1);
    expect(() =>
      verifyAndParseWebhook(
        BODY,
        header(future, sign(SECRET, future, BODY)),
        SECRET,
        NOW
      )
    ).toThrow(/outside tolerance/);
  });

  it("a missing header", () => {
    expect(() => verifyAndParseWebhook(BODY, null, SECRET, NOW)).toThrow(
      /missing stripe-signature/
    );
  });

  it("a header with no timestamp", () => {
    expect(() =>
      verifyAndParseWebhook(BODY, `v1=${sign(SECRET, NOW, BODY)}`, SECRET, NOW)
    ).toThrow(/missing timestamp/);
  });

  it("a header with no v1", () => {
    expect(() => verifyAndParseWebhook(BODY, `t=${NOW}`, SECRET, NOW)).toThrow(
      /missing v1 signature/
    );
  });

  it("an empty secret — fail closed rather than verify against nothing", () => {
    expect(() =>
      verifyAndParseWebhook(BODY, header(NOW, sign(SECRET, NOW, BODY)), "", NOW)
    ).toThrow(/unset/);
  });

  it("a valid signature over a body that is not JSON", () => {
    const junk = "not json at all";
    expect(() =>
      verifyAndParseWebhook(junk, header(NOW, sign(SECRET, NOW, junk)), SECRET, NOW)
    ).toThrow(/not valid JSON/);
  });
});

describe("constantTimeHexEquals", () => {
  const { constantTimeHexEquals } = _internal;

  it("true only for identical hex", () => {
    expect(constantTimeHexEquals("abcd", "abcd")).toBe(true);
    expect(constantTimeHexEquals("abcd", "abce")).toBe(false);
  });

  it("false on a length mismatch instead of throwing", () => {
    // timingSafeEqual throws on unequal buffer lengths — the guard has
    // to catch that before it reaches the crypto call.
    expect(constantTimeHexEquals("abcd", "abcdef")).toBe(false);
  });

  it("false on two IDENTICAL non-hex strings", () => {
    // The subtle one. Buffer.from(s, "hex") truncates at the first
    // invalid character instead of throwing, so both sides decode to an
    // empty buffer and a naive timingSafeEqual returns TRUE. The
    // full-decode guard is what makes this false.
    expect(constantTimeHexEquals("zzzz", "zzzz")).toBe(false);
  });

  it("false on an odd-length or empty string", () => {
    expect(constantTimeHexEquals("abc", "abc")).toBe(false);
    expect(constantTimeHexEquals("", "")).toBe(false);
  });

  it("false when only the trailing half is garbage", () => {
    // "ab" decodes, "zz" does not — decoded length 1 != 2.
    expect(constantTimeHexEquals("abzz", "abzz")).toBe(false);
  });
});
