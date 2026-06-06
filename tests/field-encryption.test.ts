// Tests for the field-level encryption helper. Confidentiality TSC.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptField,
  decryptField,
  looksEncrypted,
  FieldEncryptionError,
  KeyNotConfiguredError,
  _setKeyForTesting,
} from "../src/lib/soc2/field-encryption";

const TEST_KEY = randomBytes(32);

beforeAll(() => {
  _setKeyForTesting(TEST_KEY);
});

afterEach(() => {
  _setKeyForTesting(TEST_KEY);
});

describe("encryptField + decryptField (Confidentiality TSC)", () => {
  it("round-trips a plaintext string", () => {
    const blob = encryptField("hello, world");
    expect(blob).toBeTruthy();
    expect(decryptField(blob)).toBe("hello, world");
  });

  it("round-trips JE memo (typical use case)", () => {
    const memo = "Capex purchase from Vendor X — Invoice #1234";
    expect(decryptField(encryptField(memo))).toBe(memo);
  });

  it("round-trips multibyte unicode", () => {
    const utf = "Hosung 是 a test — €100 💼";
    expect(decryptField(encryptField(utf))).toBe(utf);
  });

  it("returns null for null/empty/undefined input (symmetric)", () => {
    expect(encryptField(null)).toBeNull();
    expect(encryptField(undefined)).toBeNull();
    expect(encryptField("")).toBeNull();
    expect(decryptField(null)).toBeNull();
    expect(decryptField(undefined)).toBeNull();
    expect(decryptField("")).toBeNull();
  });

  it("produces a different ciphertext on each encrypt (IV is random)", () => {
    const a = encryptField("same plaintext");
    const b = encryptField("same plaintext");
    expect(a).not.toBe(b);
    // Both decrypt to the same value.
    expect(decryptField(a)).toBe(decryptField(b));
  });

  it("decryption fails loudly on tampered ciphertext (GCM auth tag rejects)", () => {
    const blob = encryptField("sensitive")!;
    // Flip one byte in the middle of the ciphertext.
    const raw = Buffer.from(blob, "base64");
    raw[20] = raw[20] ^ 0xff;
    const tampered = raw.toString("base64");
    expect(() => decryptField(tampered)).toThrow(FieldEncryptionError);
  });

  it("decryption fails on wrong key", () => {
    const blob = encryptField("locked")!;
    _setKeyForTesting(randomBytes(32));
    expect(() => decryptField(blob)).toThrow(FieldEncryptionError);
  });

  it("decryption fails on too-short blob (not version + IV + tag)", () => {
    expect(() => decryptField("AAAA")).toThrow(FieldEncryptionError);
  });

  it("decryption fails on unknown version byte (forward compat for rotation)", () => {
    const fake = Buffer.concat([
      Buffer.from([0xff]), // unknown version
      randomBytes(12),
      randomBytes(20),
      randomBytes(16),
    ]).toString("base64");
    expect(() => decryptField(fake)).toThrow(/Unknown encryption version/);
  });
});

describe("looksEncrypted (migration helper)", () => {
  it("identifies an encryptField output", () => {
    const blob = encryptField("anything")!;
    expect(looksEncrypted(blob)).toBe(true);
  });

  it("returns false for plaintext", () => {
    expect(looksEncrypted("plaintext memo")).toBe(false);
    expect(looksEncrypted("Capex purchase from Vendor X")).toBe(false);
  });

  it("returns false for empty/null", () => {
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted("")).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
  });
});

describe("KeyNotConfiguredError (CC6.7 — fail-closed on missing key)", () => {
  it("throws when key is null and env not set", () => {
    _setKeyForTesting(null);
    const originalKey = process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.FIELD_ENCRYPTION_KEY;
    try {
      expect(() => encryptField("anything")).toThrow(KeyNotConfiguredError);
    } finally {
      if (originalKey) process.env.FIELD_ENCRYPTION_KEY = originalKey;
    }
  });

  it("throws on wrong-length env key", () => {
    _setKeyForTesting(null);
    const originalKey = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = "abc";
    try {
      expect(() => encryptField("anything")).toThrow(/64 hex chars/);
    } finally {
      if (originalKey) process.env.FIELD_ENCRYPTION_KEY = originalKey;
      else delete process.env.FIELD_ENCRYPTION_KEY;
    }
  });

  it("throws on non-hex env key", () => {
    _setKeyForTesting(null);
    const originalKey = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = "z".repeat(64);
    try {
      expect(() => encryptField("anything")).toThrow(/hex-encoded/);
    } finally {
      if (originalKey) process.env.FIELD_ENCRYPTION_KEY = originalKey;
      else delete process.env.FIELD_ENCRYPTION_KEY;
    }
  });
});
