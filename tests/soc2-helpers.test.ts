// Tests for the SOC 2 helper primitives in src/lib/soc2/index.ts.
// Pure-function coverage — no DB. The auditedMutation wrapper is
// covered separately in integration tests where Prisma is available.

import { describe, it, expect } from "vitest";
import {
  assertTenantScope,
  CrossTenantAccessError,
  constantTimeEqual,
  redactPii,
  sanitizeError,
  schemaFingerprint,
} from "../src/lib/soc2";

describe("assertTenantScope (CC6 — cross-tenant IDOR defense)", () => {
  const sameTenant = "00000000-0000-0000-0000-000000000aaa";
  const otherTenant = "00000000-0000-0000-0000-000000000bbb";

  it("returns the row when tenantId matches", () => {
    const row = { id: "1", tenantId: sameTenant, name: "x" };
    expect(assertTenantScope(row, sameTenant, "TestRow")).toBe(row);
  });

  it("throws CrossTenantAccessError on tenantId mismatch", () => {
    const row = { id: "1", tenantId: otherTenant, name: "x" };
    expect(() => assertTenantScope(row, sameTenant, "TestRow")).toThrow(
      CrossTenantAccessError
    );
  });

  it("throws on null row — same error as cross-tenant (no existence leak)", () => {
    // Critical: distinguishing 'not found' from 'in other tenant' would
    // let an attacker enumerate ids across tenants. Both must look the
    // same to the caller.
    expect(() => assertTenantScope(null, sameTenant, "TestRow")).toThrow(
      CrossTenantAccessError
    );
  });
});

describe("constantTimeEqual (CC6 — timing attack defense on secrets)", () => {
  it("returns true on identical strings", () => {
    expect(constantTimeEqual("token-abc-123", "token-abc-123")).toBe(true);
  });

  it("returns false on different content (same length)", () => {
    expect(constantTimeEqual("token-abc-123", "token-xyz-123")).toBe(false);
  });

  it("returns false on different lengths without crashing", () => {
    expect(constantTimeEqual("short", "longer-string")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

describe("redactPii (Confidentiality TSC — log scrubbing)", () => {
  it("redacts the standard PII field names", () => {
    const input = {
      email: "alice@example.com",
      displayName: "Alice Example",
      ssn: "111-22-3333",
      apiKey: "sk_live_xxx",
      memo: "Capex purchase from Vendor",
      // Not PII:
      tenantId: "tenant-1",
      entityCode: "ACME",
      amount: 1234.56,
    };
    const out = redactPii(input);
    expect(out.email).toBe("[REDACTED]");
    expect(out.displayName).toBe("[REDACTED]");
    expect(out.ssn).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.memo).toBe("[REDACTED]");
    // Pass-throughs unchanged
    expect(out.tenantId).toBe("tenant-1");
    expect(out.entityCode).toBe("ACME");
    expect(out.amount).toBe(1234.56);
  });

  it("recurses into nested objects + arrays", () => {
    const input = {
      tenantId: "t1",
      users: [
        { email: "a@x.com", role: "ADMIN" },
        { email: "b@x.com", role: "MEMBER" },
      ],
      meta: { actor: { email: "c@x.com", id: "u-1" } },
    };
    const out = redactPii(input);
    expect(out.tenantId).toBe("t1");
    expect(out.users[0].email).toBe("[REDACTED]");
    expect(out.users[0].role).toBe("ADMIN");
    expect(out.users[1].email).toBe("[REDACTED]");
    expect(out.meta.actor.email).toBe("[REDACTED]");
    expect(out.meta.actor.id).toBe("u-1");
  });

  it("passes through primitives + null without crashing", () => {
    expect(redactPii("a string")).toBe("a string");
    expect(redactPii(42)).toBe(42);
    expect(redactPii(null)).toBe(null);
    expect(redactPii(undefined)).toBe(undefined);
  });

  it("doesn't mutate the input", () => {
    const input = { email: "x@y.com", id: "1" };
    redactPii(input);
    expect(input.email).toBe("x@y.com");
  });
});

describe("sanitizeError (CC7 — information disclosure defense)", () => {
  it("returns a known code when the error has one", () => {
    const err = new Error("Unbalanced entry — debits 100 != credits 200");
    (err as unknown as { code: string }).code = "UNBALANCED";
    const out = sanitizeError(err);
    expect(out.code).toBe("UNBALANCED");
    // Application-emitted message under 200 chars passes through
    expect(out.message).toContain("Unbalanced");
  });

  it("masks long error messages with the generic fallback", () => {
    const longMsg = "x".repeat(500);
    const err = new Error(longMsg);
    const out = sanitizeError(err);
    expect(out.code).toBe("INTERNAL_ERROR");
    expect(out.message).not.toContain("xxxxx");
  });

  it("masks errors without a code (likely raw exceptions)", () => {
    const out = sanitizeError(new TypeError("Cannot read property 'x' of undefined"));
    expect(out.code).toBe("INTERNAL_ERROR");
    expect(out.message).not.toContain("Cannot read");
  });

  it("masks non-Error throws (strings, numbers, etc.)", () => {
    const out = sanitizeError("oops" as unknown);
    expect(out.code).toBe("INTERNAL_ERROR");
  });

  it("propagates CrossTenantAccessError as NOT_FOUND (no existence leak)", () => {
    const err = new CrossTenantAccessError("UserRow");
    const out = sanitizeError(err);
    expect(out.code).toBe("NOT_FOUND");
  });

  it("includes correlationId when provided", () => {
    const out = sanitizeError(new Error("x"), { correlationId: "req-123" });
    expect(out.correlationId).toBe("req-123");
  });
});

describe("schemaFingerprint (CC8 — schema-drift detection)", () => {
  it("returns a stable 16-char hex string", () => {
    const fp = schemaFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns the same value on repeated calls (cached)", () => {
    expect(schemaFingerprint()).toBe(schemaFingerprint());
  });
});
