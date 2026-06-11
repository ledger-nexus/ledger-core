// Webhook-URL encryption helper tests.
//
// Pins:
//   1. Round-trip: decrypt(encrypt(x)) === x
//   2. Each encryption uses a fresh IV (two encrypts of the same
//      plaintext produce different ciphertext)
//   3. Wrong key fails closed (decrypt throws)
//   4. Tampered ciphertext fails closed (GCM auth tag rejects)
//   5. Missing env var throws with a clear error
//   6. Short ciphertext throws (DB corruption signal)
//   7. maskWebhookUrl redacts the last path segment
//   8. timingSafeEqualB64 is constant-time + length-aware

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";

import {
  encryptWebhookUrl,
  decryptWebhookUrl,
  maskWebhookUrl,
  timingSafeEqualB64,
} from "@/lib/notifications/crypto";

const TEST_KEY = randomBytes(32).toString("base64");
const ALT_KEY = randomBytes(32).toString("base64");

let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.WEBHOOK_ENCRYPTION_KEY;
  process.env.WEBHOOK_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (savedKey !== undefined) {
    process.env.WEBHOOK_ENCRYPTION_KEY = savedKey;
  } else {
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
  }
});

describe("encryptWebhookUrl + decryptWebhookUrl", () => {
  it("round-trips a Slack webhook URL", () => {
    const url = "https://hooks.slack.com/services/T123/B456/abcDEFghi789";
    const ct = encryptWebhookUrl(url);
    expect(ct).not.toContain(url);
    expect(decryptWebhookUrl(ct)).toBe(url);
  });

  it("produces different ciphertext for the same plaintext on each call (fresh IV)", () => {
    const url = "https://hooks.slack.com/services/X/Y/Z";
    const a = encryptWebhookUrl(url);
    const b = encryptWebhookUrl(url);
    expect(a).not.toBe(b);
    // But both decrypt to the same plaintext.
    expect(decryptWebhookUrl(a)).toBe(url);
    expect(decryptWebhookUrl(b)).toBe(url);
  });

  it("throws on wrong key (GCM auth tag rejects)", () => {
    const url = "https://hooks.slack.com/services/A/B/C";
    const ct = encryptWebhookUrl(url);
    process.env.WEBHOOK_ENCRYPTION_KEY = ALT_KEY;
    try {
      expect(() => decryptWebhookUrl(ct)).toThrow();
    } finally {
      process.env.WEBHOOK_ENCRYPTION_KEY = TEST_KEY;
    }
  });

  it("throws on tampered ciphertext", () => {
    const ct = encryptWebhookUrl("hello world");
    // Flip a bit somewhere in the middle of the ciphertext payload.
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptWebhookUrl(tampered)).toThrow();
  });

  it("throws when WEBHOOK_ENCRYPTION_KEY is missing", () => {
    const before = process.env.WEBHOOK_ENCRYPTION_KEY;
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
    try {
      expect(() => encryptWebhookUrl("anything")).toThrow(/not set/i);
      expect(() => decryptWebhookUrl("anything")).toThrow(/not set/i);
    } finally {
      process.env.WEBHOOK_ENCRYPTION_KEY = before;
    }
  });

  it("throws when WEBHOOK_ENCRYPTION_KEY is the wrong length", () => {
    const before = process.env.WEBHOOK_ENCRYPTION_KEY;
    process.env.WEBHOOK_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    try {
      expect(() => encryptWebhookUrl("anything")).toThrow(/32 bytes/);
    } finally {
      process.env.WEBHOOK_ENCRYPTION_KEY = before;
    }
  });

  it("throws on short ciphertext (DB corruption signal)", () => {
    expect(() => decryptWebhookUrl("aGVsbG8=")).toThrow(/too short/i);
  });
});

describe("maskWebhookUrl", () => {
  it("redacts the last path segment of a Slack webhook URL", () => {
    const url = "https://hooks.slack.com/services/T123/B456/abcDEFghi";
    expect(maskWebhookUrl(url)).toBe("https://hooks.slack.com/services/T123/B456/***");
  });

  it("handles URLs with no path", () => {
    expect(maskWebhookUrl("https://example.com/")).toBe("https://example.com/***");
  });

  it("returns a sentinel for invalid URLs", () => {
    expect(maskWebhookUrl("not a url")).toBe("***invalid-url***");
  });
});

describe("timingSafeEqualB64", () => {
  it("returns true for equal base64 strings", () => {
    const buf = randomBytes(16).toString("base64");
    expect(timingSafeEqualB64(buf, buf)).toBe(true);
  });

  it("returns false for different equal-length strings", () => {
    const a = randomBytes(16).toString("base64");
    const b = randomBytes(16).toString("base64");
    expect(timingSafeEqualB64(a, b)).toBe(false);
  });

  it("returns false for different-length strings (without throwing)", () => {
    const a = randomBytes(16).toString("base64");
    const b = randomBytes(32).toString("base64");
    expect(timingSafeEqualB64(a, b)).toBe(false);
  });
});
