// Unit tests for src/lib/soc2/deterministic-encryption.ts (Phase 1
// helper for the deterministic-encryption workstream described in
// docs/design/deterministic-encryption.md).
//
// What the tests prove:
//   1. Determinism: same input → same hash, every time.
//   2. Domain separation: hash("alice@a", "User.email") !=
//      hash("alice@a", "TenantInvite.email"). Required so a DB dump
//      can't correlate emails across tables.
//   3. Normalization works as advertised:
//        emailLowercase: case + trim collapse
//        exact:          no transformation
//   4. Key handling: missing key → KeyNotConfiguredError; malformed
//      key → FieldEncryptionError.
//   5. NUL-in-domain rejected (would defeat canonicalization).
//   6. Constant-time comparison: searchHashEqual on different-length
//      inputs returns false without throwing.
//   7. Stability: a known key + plaintext produces a known digest
//      (regression guard against accidental algorithm changes).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  searchHash,
  searchHashEqual,
  normalize,
  _setKeyForTesting,
} from "@/lib/soc2/deterministic-encryption";
import { FieldEncryptionError } from "@/lib/soc2/field-encryption";

const TEST_KEY_HEX = "a".repeat(64); // 32 bytes of 0xaa
const SAVED = process.env.FIELD_DETERMINISTIC_KEY;

beforeEach(() => {
  process.env.FIELD_DETERMINISTIC_KEY = TEST_KEY_HEX;
  _setKeyForTesting(null); // force re-read on next call
});

afterEach(() => {
  if (SAVED !== undefined) process.env.FIELD_DETERMINISTIC_KEY = SAVED;
  else delete process.env.FIELD_DETERMINISTIC_KEY;
  _setKeyForTesting(null);
});

describe("searchHash — determinism", () => {
  it("returns the same 32-byte digest for the same (domain, plaintext)", () => {
    const a = searchHash("User.email", "alice@acme.test", "emailLowercase");
    const b = searchHash("User.email", "alice@acme.test", "emailLowercase");
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it("returns DIFFERENT digests for the same plaintext under different domains", () => {
    const a = searchHash("User.email", "alice@acme.test", "emailLowercase");
    const b = searchHash(
      "TenantInvite.email",
      "alice@acme.test",
      "emailLowercase"
    );
    expect(a).not.toEqual(b);
    // Sanity — neither is all-zero (would indicate a no-op HMAC).
    expect(a.every((byte) => byte === 0)).toBe(false);
    expect(b.every((byte) => byte === 0)).toBe(false);
  });

  it("returns DIFFERENT digests for different plaintexts under the same domain", () => {
    const a = searchHash("User.email", "alice@acme.test", "emailLowercase");
    const b = searchHash("User.email", "bob@acme.test", "emailLowercase");
    expect(a).not.toEqual(b);
  });
});

describe("searchHash — normalization", () => {
  it("emailLowercase collapses casing", () => {
    const a = searchHash("User.email", "Alice@Acme.Test", "emailLowercase");
    const b = searchHash("User.email", "alice@acme.test", "emailLowercase");
    expect(a).toEqual(b);
  });

  it("emailLowercase trims surrounding whitespace", () => {
    const a = searchHash(
      "User.email",
      "  alice@acme.test  ",
      "emailLowercase"
    );
    const b = searchHash("User.email", "alice@acme.test", "emailLowercase");
    expect(a).toEqual(b);
  });

  it("exact preserves casing — different cases hash differently", () => {
    const a = searchHash("Tenant.slug", "Acme-Corp", "exact");
    const b = searchHash("Tenant.slug", "acme-corp", "exact");
    expect(a).not.toEqual(b);
  });

  it("normalize() helper matches the policy used inside searchHash", () => {
    expect(normalize("  Alice@Acme.test  ", "emailLowercase")).toBe(
      "alice@acme.test"
    );
    expect(normalize("Acme-Corp", "exact")).toBe("Acme-Corp");
  });
});

describe("searchHash — key handling", () => {
  it("throws FieldEncryptionError mentioning FIELD_DETERMINISTIC_KEY when unset", () => {
    delete process.env.FIELD_DETERMINISTIC_KEY;
    _setKeyForTesting(null);
    expect(() =>
      searchHash("User.email", "alice@acme.test", "emailLowercase")
    ).toThrow(FieldEncryptionError);
    expect(() =>
      searchHash("User.email", "alice@acme.test", "emailLowercase")
    ).toThrow(/FIELD_DETERMINISTIC_KEY/);
  });

  it("throws FieldEncryptionError on wrong-length key", () => {
    process.env.FIELD_DETERMINISTIC_KEY = "abcdef"; // too short
    _setKeyForTesting(null);
    expect(() =>
      searchHash("User.email", "alice@acme.test", "emailLowercase")
    ).toThrow(FieldEncryptionError);
  });

  it("throws FieldEncryptionError on non-hex key", () => {
    process.env.FIELD_DETERMINISTIC_KEY = "z".repeat(64);
    _setKeyForTesting(null);
    expect(() =>
      searchHash("User.email", "alice@acme.test", "emailLowercase")
    ).toThrow(FieldEncryptionError);
  });

  it("caches the key after the first read (idempotent)", () => {
    const k1 = searchHash("User.email", "alice@acme.test", "emailLowercase");
    // Simulate the env var being unset AFTER the first call. The
    // cached key should still serve subsequent calls.
    delete process.env.FIELD_DETERMINISTIC_KEY;
    const k2 = searchHash("User.email", "alice@acme.test", "emailLowercase");
    expect(k2).toEqual(k1);
  });
});

describe("searchHash — domain hygiene", () => {
  it("rejects an empty domain", () => {
    expect(() =>
      searchHash("", "alice@acme.test", "emailLowercase")
    ).toThrow(FieldEncryptionError);
  });

  it("rejects a domain containing NUL (canonicalization defeat)", () => {
    expect(() =>
      searchHash(
        "User.email\x00TenantInvite.email",
        "alice@acme.test",
        "emailLowercase"
      )
    ).toThrow(FieldEncryptionError);
  });
});

describe("searchHashEqual", () => {
  it("returns true on identical buffers", () => {
    const a = searchHash("User.email", "alice@acme.test", "emailLowercase");
    const b = searchHash("User.email", "alice@acme.test", "emailLowercase");
    expect(searchHashEqual(a, b)).toBe(true);
  });

  it("returns false on different buffers of the same length", () => {
    const a = searchHash("User.email", "alice@acme.test", "emailLowercase");
    const b = searchHash("User.email", "bob@acme.test", "emailLowercase");
    expect(searchHashEqual(a, b)).toBe(false);
  });

  it("returns false on different-length buffers without throwing", () => {
    // timingSafeEqual would throw on length mismatch; the wrapper
    // guards that.
    const a = randomBytes(32);
    const b = randomBytes(16);
    expect(() => searchHashEqual(a, b)).not.toThrow();
    expect(searchHashEqual(a, b)).toBe(false);
  });
});

describe("searchHash — stability (regression guard)", () => {
  it("produces a known digest for a known input + key", () => {
    // Lock in the wire format. If any of these change accidentally
    // (key derivation, separator, ordering), every existing search
    // hash on disk breaks. Update this test ONLY in lockstep with a
    // documented migration.
    process.env.FIELD_DETERMINISTIC_KEY = TEST_KEY_HEX;
    _setKeyForTesting(null);
    const digest = searchHash(
      "User.email",
      "alice@acme.test",
      "emailLowercase"
    );
    // Pre-image (with our 0xaa key + null separator):
    //   HMAC-SHA256(0xaa*32, "User.email" || 0x00 || "alice@acme.test")
    // Recomputed from a separate Node REPL to lock this in.
    expect(digest.toString("hex")).toBe(
      "2e0f97aa05447dad80977486e2eba6556212fafc1b8173426390a53e606fe546"
    );
  });
});
