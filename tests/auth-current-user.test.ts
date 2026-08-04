// Auth stub tests — focused on the HMAC sign/verify + cookie parsing
// helpers. These are pure functions and need no DB / cookies surface.
//
// The full getCurrentUser path (cookie read → user lookup → returned shape)
// is exercised by the UI in dev; we don't unit test it here because it
// requires Next's cookies() to be wired (a real DB session helps too).
// What matters here is that the cryptographic boundary holds — no other
// component should be able to construct a valid cookie value.

import { describe, it, expect } from "vitest";
import { _internal } from "../src/lib/auth/current-user";

const VALID_UUID = "abcdef01-2345-6789-abcd-ef0123456789";
const OTHER_UUID = "11111111-2222-3333-4444-555555555555";

describe("auth stub: sign + verify", () => {
  it("sign produces a 16-char hex string", () => {
    const mac = _internal.sign(VALID_UUID);
    expect(mac).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(mac)).toBe(true);
  });

  it("sign is deterministic for the same input", () => {
    expect(_internal.sign(VALID_UUID)).toBe(_internal.sign(VALID_UUID));
  });

  it("sign differs for different inputs", () => {
    expect(_internal.sign(VALID_UUID)).not.toBe(_internal.sign(OTHER_UUID));
  });

  it("verify accepts a freshly-signed MAC", () => {
    const mac = _internal.sign(VALID_UUID);
    expect(_internal.verify(VALID_UUID, mac)).toBe(true);
  });

  it("verify rejects a MAC for a different userId", () => {
    const mac = _internal.sign(OTHER_UUID);
    expect(_internal.verify(VALID_UUID, mac)).toBe(false);
  });

  it("verify rejects a tampered MAC of the right length", () => {
    const mac = _internal.sign(VALID_UUID);
    const tampered = mac.split("").reverse().join("");
    expect(_internal.verify(VALID_UUID, tampered)).toBe(false);
  });

  it("verify rejects a MAC of the wrong length", () => {
    expect(_internal.verify(VALID_UUID, "abc")).toBe(false);
    expect(_internal.verify(VALID_UUID, "")).toBe(false);
  });
});

describe("auth stub: encode + parseCookie", () => {
  it("encode produces userId.mac", () => {
    const encoded = _internal.encode(VALID_UUID);
    expect(encoded).toMatch(new RegExp(`^${VALID_UUID}\\.[0-9a-f]{16}$`));
  });

  it("parseCookie round-trips an encoded cookie back to the userId", () => {
    const encoded = _internal.encode(VALID_UUID);
    expect(_internal.parseCookie(encoded)).toBe(VALID_UUID);
  });

  it("parseCookie returns null for undefined", () => {
    expect(_internal.parseCookie(undefined)).toBeNull();
  });

  it("parseCookie returns null for a cookie with no separator", () => {
    expect(_internal.parseCookie(VALID_UUID)).toBeNull();
  });

  it("parseCookie returns null for a cookie with bad MAC", () => {
    const encoded = `${VALID_UUID}.0000000000000000`;
    expect(_internal.parseCookie(encoded)).toBeNull();
  });

  it("parseCookie rejects a forged userId with a real-shaped MAC", () => {
    // Take a valid encoded cookie, swap the userId — MAC won't match.
    const real = _internal.encode(VALID_UUID);
    const macPart = real.slice(real.indexOf(".") + 1);
    const forged = `${OTHER_UUID}.${macPart}`;
    expect(_internal.parseCookie(forged)).toBeNull();
  });

  it("parseCookie returns null when the MAC half is empty", () => {
    expect(_internal.parseCookie(`${VALID_UUID}.`)).toBeNull();
  });

  it("parseCookie returns null when the userId half is empty", () => {
    expect(_internal.parseCookie(`.${_internal.sign(VALID_UUID)}`)).toBeNull();
  });
});

// The email-allowlist isAdmin() predicate this file used to test is
// retired — admin is now TenantMembership.role via the policy catalog.
// See tests/authz-policy.test.ts for the replacement coverage.
