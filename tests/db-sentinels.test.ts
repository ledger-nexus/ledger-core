// Unit tests for the tenantScopeOrNone / NIL_UUID helpers.
//
// Pure helpers — no DB needed. Tests both the constant and the function
// return shape. The runtime "did this fix the 500" verification is
// already proven by the dev-server walk that ships with the PR
// description.

import { describe, expect, it } from "vitest";

import { NIL_UUID, tenantScopeOrNone } from "@/lib/db-sentinels";

describe("NIL_UUID", () => {
  it("is a syntactically valid UUID string Prisma will accept", () => {
    // RFC 4122 UUID format check — 8-4-4-4-12 hex pattern. The point is
    // this string does NOT contain underscores or other characters that
    // would crash Prisma's UUID coercion (the bug we just fixed).
    expect(NIL_UUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("is the canonical nil UUID (all zeros)", () => {
    expect(NIL_UUID).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("tenantScopeOrNone", () => {
  it("returns the tenant id when supplied", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(tenantScopeOrNone(id)).toEqual({ tenantId: id });
  });

  it("returns NIL_UUID when given null", () => {
    expect(tenantScopeOrNone(null)).toEqual({ tenantId: NIL_UUID });
  });

  it("returns NIL_UUID when given undefined", () => {
    expect(tenantScopeOrNone(undefined)).toEqual({ tenantId: NIL_UUID });
  });

  it("never returns a value with underscores (regression guard for the original bug)", () => {
    // The bug was that the previous sentinel `"__none__"` contains
    // underscores, which Prisma's UUID coercion rejected at
    // deserialize time with `Inconsistent column data: Error creating
    // UUID, ... found '_' at 1`. This test pins the contract: whatever
    // tenantScopeOrNone returns for the no-tenant case must NOT trip
    // Prisma's UUID parser.
    const out = tenantScopeOrNone(null);
    expect(out.tenantId).not.toContain("_");
    expect(out.tenantId).toMatch(/^[0-9a-f-]+$/);
  });
});
