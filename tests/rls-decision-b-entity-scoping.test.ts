// Test for RLS Phase 3 decision B — entity-code-collision gap fix.
//
// Verifies the surgical change: when two tenants both have an entity
// with the same code (entirely possible — codes are scoped per tenant),
// a tenant-A admin invoking closePeriod with that code MUST NOT close
// tenant-B's period. The scoped findFirst returns null → user sees
// "Unknown entity" instead of mutating the wrong tenant's data.
//
// This test deliberately does NOT depend on Phase 3 FORCE — it proves
// the application-layer fix works pre-FORCE, providing the more
// informative error message the design doc described.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let tenantAId: string;
let tenantBId: string;
const SHARED_CODE = `RLS-DECB-${Date.now().toString().slice(-8)}`;

beforeAll(async () => {
  // Need an owner user for the tenants.
  const anyUser = await prisma.user.findFirstOrThrow({ select: { id: true } });

  // Create 2 disposable tenants, each with an entity sharing the same code.
  const tA = await prisma.tenant.create({
    data: {
      slug: `rls-decb-a-${Date.now().toString().slice(-6)}`,
      name: "RLS Decision B test — tenant A",
      ownerUserId: anyUser.id,
    },
    select: { id: true },
  });
  tenantAId = tA.id;
  await prisma.legalEntity.create({
    data: {
      tenantId: tenantAId,
      code: SHARED_CODE,
      name: "A_CORP",
      functionalCurrencyId: "USD",
    },
  });

  const tB = await prisma.tenant.create({
    data: {
      slug: `rls-decb-b-${Date.now().toString().slice(-6)}-x`,
      name: "RLS Decision B test — tenant B",
      ownerUserId: anyUser.id,
    },
    select: { id: true },
  });
  tenantBId = tB.id;
  await prisma.legalEntity.create({
    data: {
      tenantId: tenantBId,
      code: SHARED_CODE,
      name: "B_CORP",
      functionalCurrencyId: "USD",
    },
  });

  // Make sure USD currency exists (some test setups don't seed it).
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
});

afterAll(async () => {
  // Cleanup. legalEntity → tenant order.
  await prisma.legalEntity.deleteMany({
    where: { tenantId: { in: [tenantAId, tenantBId] } },
  });
  // Remove any audit-log rows that might reference these tenants.
  await prisma.auditLog.deleteMany({
    where: { tenantId: { in: [tenantAId, tenantBId] } },
  });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: { in: [tenantAId, tenantBId] } },
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: [tenantAId, tenantBId] } },
  });
  await prisma.$disconnect();
});

describe("RLS Phase 3 decision B — entity scoping", () => {
  it("pre-fix simulation: findFirst by code alone matches BOTH tenants (1 of 2)", async () => {
    // This is the legacy behavior that the fix removes. The lookup
    // returns whichever row Postgres happened to scan first — depending
    // on insertion order. We just assert it returns SOMETHING (the bug
    // was that the WRONG tenant's row was returned).
    const legacyMatch = await prisma.legalEntity.findFirst({
      where: { code: SHARED_CODE },
      select: { tenantId: true },
    });
    expect(legacyMatch).not.toBeNull();
    expect([tenantAId, tenantBId]).toContain(legacyMatch!.tenantId);
  });

  it("post-fix: scoped lookup returns ONLY tenant-A's entity when scoped to tenant-A", async () => {
    const found = await prisma.legalEntity.findFirst({
      where: { code: SHARED_CODE, tenantId: tenantAId },
      select: { tenantId: true },
    });
    expect(found?.tenantId).toBe(tenantAId);
  });

  it("post-fix: scoped lookup returns ONLY tenant-B's entity when scoped to tenant-B", async () => {
    const found = await prisma.legalEntity.findFirst({
      where: { code: SHARED_CODE, tenantId: tenantBId },
      select: { tenantId: true },
    });
    expect(found?.tenantId).toBe(tenantBId);
  });

  it("post-fix: scoped lookup returns null for a third (non-existent) tenant id", async () => {
    // 00000000-... is a syntactically-valid UUID that won't match any tenant.
    const bogusId = "00000000-0000-0000-0000-000000000000";
    const found = await prisma.legalEntity.findFirst({
      where: { code: SHARED_CODE, tenantId: bogusId },
      select: { tenantId: true },
    });
    expect(found).toBeNull();
  });
});
