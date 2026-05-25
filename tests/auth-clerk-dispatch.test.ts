// Auth dispatch tests — verify the runtime selector between the dev-cookie
// stub and the Clerk-backed path. The contract:
//
//   - When CLERK_SECRET_KEY is unset (or empty): isClerkEnabled() = false;
//     getCurrentUser() reads from the lc-user cookie + HMAC.
//   - When CLERK_SECRET_KEY is set: isClerkEnabled() = true;
//     getCurrentUser() delegates to ./clerk.getCurrentUserFromClerk().
//
// We don't exercise the Clerk SDK itself here (that'd require a real
// Clerk session); we verify the dispatch boundary using a module-level
// mock and env manipulation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock next/headers so getCurrentUser doesn't blow up outside a request.
const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: () => {},
    delete: () => {},
  }),
}));

import { isClerkEnabled } from "@/lib/auth/clerk";

describe("isClerkEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when CLERK_SECRET_KEY is empty", () => {
    vi.stubEnv("CLERK_SECRET_KEY", "");
    expect(isClerkEnabled()).toBe(false);
  });

  it("returns true when CLERK_SECRET_KEY is set", () => {
    vi.stubEnv(
      "CLERK_SECRET_KEY",
      "FAKE_TEST_SECRET_NOT_A_REAL_KEY_xxxxxxxxxxxx"
    );
    expect(isClerkEnabled()).toBe(true);
  });
});

describe("env validation: Clerk pairing", () => {
  // Use vi.stubEnv (and unstub in afterEach) — Vitest freezes
  // process.env when running, so direct mutation of NODE_ENV throws.

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("CLERK_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warns (does not error) when both keys are unset in dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { validateEnv } = await import("@/lib/env");
    const r = validateEnv();
    expect(r.errors.some((e) => /half-configured/i.test(e))).toBe(false);
  });

  it("warns in dev when only CLERK_SECRET_KEY is set", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv(
      "CLERK_SECRET_KEY",
      "FAKE_TEST_SECRET_NOT_A_REAL_KEY_xxxxxxxxxxxx"
    );
    const { validateEnv } = await import("@/lib/env");
    const r = validateEnv();
    expect(r.warnings.some((w) => /half-configured/i.test(w))).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("warns in dev when only NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is set", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_xxxxxxxxxxxxxxxx");
    const { validateEnv } = await import("@/lib/env");
    const r = validateEnv();
    expect(r.warnings.some((w) => /half-configured/i.test(w))).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("errors in production when half-configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "CLERK_SECRET_KEY",
      "FAKE_LIVE_SECRET_NOT_A_REAL_KEY_xxxxxxxxxxxx"
    );
    // Set the base required-prod vars so we isolate the Clerk error.
    vi.stubEnv("DATABASE_URL", "postgres://example");
    vi.stubEnv("AUTH_STUB_SECRET", "x".repeat(32));
    const { validateEnv } = await import("@/lib/env");
    const r = validateEnv();
    expect(r.errors.some((e) => /half-configured/i.test(e))).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("is happy when both Clerk keys are set together in dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv(
      "CLERK_SECRET_KEY",
      "FAKE_TEST_SECRET_NOT_A_REAL_KEY_xxxxxxxxxxxx"
    );
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_xxxxxxxxxxxxxxxx");
    const { validateEnv } = await import("@/lib/env");
    const r = validateEnv();
    expect(r.warnings.some((w) => /half-configured/i.test(w))).toBe(false);
    expect(r.errors.some((e) => /half-configured/i.test(e))).toBe(false);
  });
});

describe("middleware: public-path detection", () => {
  // Pull just the internal exports without instantiating Clerk.
  it("treats /sign-in as public", async () => {
    const { _internal } = await import("@/middleware");
    expect(_internal.isPublic("/sign-in")).toBe(true);
    expect(_internal.isPublic("/sign-in/factor-one")).toBe(true);
  });

  it("treats /sign-up as public", async () => {
    const { _internal } = await import("@/middleware");
    expect(_internal.isPublic("/sign-up")).toBe(true);
    expect(_internal.isPublic("/sign-up/verify-email-address")).toBe(true);
  });

  it("treats /api/internal/* as public (gated by token, not session)", async () => {
    const { _internal } = await import("@/middleware");
    expect(_internal.isPublic("/api/internal/journal-entries")).toBe(true);
    expect(_internal.isPublic("/api/internal/fixed-asset/record-depreciation")).toBe(
      true
    );
  });

  it("treats normal app routes as PROTECTED (not public)", async () => {
    const { _internal } = await import("@/middleware");
    expect(_internal.isPublic("/")).toBe(false);
    expect(_internal.isPublic("/journal-entries")).toBe(false);
    expect(_internal.isPublic("/reports/month-end")).toBe(false);
    expect(_internal.isPublic("/api/admin/reset")).toBe(false);
  });

  it("treats Next static assets as public (no auth needed for /_next)", async () => {
    const { _internal } = await import("@/middleware");
    expect(_internal.isPublic("/_next/static/foo.css")).toBe(true);
    expect(_internal.isPublic("/favicon.ico")).toBe(true);
  });
});
