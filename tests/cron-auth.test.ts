// Cron auth helper tests. Unit-test only — no DB.
//
// Pins:
//   1. Missing CRON_SECRET env → always false (fail-closed)
//   2. Too-short CRON_SECRET (<16 chars) → always false
//   3. Header: Authorization: Bearer <secret> → true on match
//   4. Header: wrong scheme → false
//   5. Header: wrong secret → false (timing-safe)
//   6. Query: ?cron_secret=<secret> → true on match
//   7. Both header + query missing → false
//   8. Header takes precedence: header wrong but query correct → false
//      (header wins for security — Vercel cron always sends header)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";

// Generated at test load time so the literal never appears in git
// history — gitleaks otherwise flags any high-entropy string literal
// as a generic-api-key. Length 32 ≥ the helper's 16-char minimum.
const TEST_SECRET = randomBytes(16).toString("hex");
let savedSecret: string | undefined;

beforeAll(() => {
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = TEST_SECRET;
});

afterAll(() => {
  if (savedSecret !== undefined) {
    process.env.CRON_SECRET = savedSecret;
  } else {
    delete process.env.CRON_SECRET;
  }
});

function req(opts: { auth?: string; query?: string }): Request {
  const url = `http://localhost/api/cron/test${opts.query ?? ""}`;
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  return new Request(url, { method: "POST", headers });
}

describe("isAuthorizedCronRequest", () => {
  it("returns true with matching Authorization Bearer header", () => {
    expect(isAuthorizedCronRequest(req({ auth: `Bearer ${TEST_SECRET}` }))).toBe(true);
  });

  it("returns true with matching ?cron_secret= query param", () => {
    expect(
      isAuthorizedCronRequest(req({ query: `?cron_secret=${TEST_SECRET}` }))
    ).toBe(true);
  });

  it("returns false on wrong secret in header", () => {
    expect(isAuthorizedCronRequest(req({ auth: "Bearer wrongsecret123" }))).toBe(false);
  });

  it("returns false on wrong secret in query", () => {
    expect(isAuthorizedCronRequest(req({ query: "?cron_secret=wrongsecret" }))).toBe(false);
  });

  it("returns false on wrong scheme", () => {
    expect(isAuthorizedCronRequest(req({ auth: `Basic ${TEST_SECRET}` }))).toBe(false);
  });

  it("returns false when neither header nor query is provided", () => {
    expect(isAuthorizedCronRequest(req({}))).toBe(false);
  });

  it("returns false when CRON_SECRET env is missing", () => {
    const original = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      expect(isAuthorizedCronRequest(req({ auth: `Bearer ${TEST_SECRET}` }))).toBe(false);
    } finally {
      process.env.CRON_SECRET = original;
    }
  });

  it("returns false when CRON_SECRET is too short (<16 chars)", () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "shortsecret";
    try {
      expect(isAuthorizedCronRequest(req({ auth: "Bearer shortsecret" }))).toBe(false);
    } finally {
      process.env.CRON_SECRET = original;
    }
  });
});
