// End-to-end test of /api/internal/journal-entries with per-tenant
// Bearer tokens (Phase 5 of multi-tenancy).
//
// Verifies the integration of:
//   - resolveBearerToken → identity.tenantId
//   - postJournalEntry tenant-scope enforcement
//   - TenantScopeMismatchError → 403 from the route handler
//
// Scenario: two tenants with distinct entities + distinct API tokens.
//   * Tenant A's token POSTing to A's entity → 200 OK.
//   * Tenant A's token POSTing to B's entity → 403 TENANT_SCOPE_MISMATCH.
//   * Tenant B's token POSTing to B's entity → 200 OK.
//   * Token revocation makes the same call fail with 401.
//   * Garbage Bearer string fails with 401.
//
// We invoke the route handler directly with a synthetic NextRequest;
// same pattern as internal-journal-entries-dedup.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import {
  provisionTenantApiToken,
  revokeTenantApiToken,
} from "@/lib/auth/token";
import { POST } from "../src/app/api/internal/journal-entries/route";

const prisma = new PrismaClient();

const SUFFIX = "ts" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: { id: string };
let tenantB: { id: string };
let entityCodeA: string;
let entityCodeB: string;
let tokenA: string; // plaintext
let tokenB: string;
let tokenIdA: string; // for revocation test
let ownerUser: { id: string };

async function seedTenant(label: string): Promise<{ tenantId: string; entityCode: string }> {
  const user =
    ownerUser ??
    (ownerUser = await prisma.user.create({
      data: {
        email: `ts-owner-${SUFFIX}@example.test`,
        displayName: "Token Scope Test",
        isActive: true,
      },
    }));
  const tenant = await prisma.tenant.create({
    data: {
      slug: `ts-${label}-${SUFFIX}`,
      name: `Token Scope ${label.toUpperCase()}`,
      ownerUserId: user.id,
    },
  });
  const entityCode = `TS-${label.toUpperCase()}-ENT-${SUFFIX}`;
  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: entityCode,
      name: `Scope ${label} Entity`,
      functionalCurrencyId: "USD",
    },
  });
  await prisma.account.createMany({
    data: [
      {
        tenantId: tenant.id,
        entityId: entity.id,
        code: "1000",
        name: "Cash",
        type: "ASSET",
        normalBalance: "DEBIT",
      },
      {
        tenantId: tenant.id,
        entityId: entity.id,
        code: "3000",
        name: "Capital",
        type: "EQUITY",
        normalBalance: "CREDIT",
      },
    ],
  });
  return { tenantId: tenant.id, entityCode };
}

beforeAll(async () => {
  // Wipe any legacy INTERNAL_API_TOKEN so the DB path is the only one tested.
  delete process.env.INTERNAL_API_TOKEN;

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: {
      code: "US_GAAP",
      name: "US GAAP",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
    },
    update: {},
  });

  const a = await seedTenant("a");
  const b = await seedTenant("b");
  tenantA = { id: a.tenantId };
  tenantB = { id: b.tenantId };
  entityCodeA = a.entityCode;
  entityCodeB = b.entityCode;

  const provA = await provisionTenantApiToken({
    tenantId: tenantA.id,
    label: `scope-A-${SUFFIX}`,
  });
  tokenA = provA.plaintext;
  tokenIdA = provA.tokenId;
  const provB = await provisionTenantApiToken({
    tenantId: tenantB.id,
    label: `scope-B-${SUFFIX}`,
  });
  tokenB = provB.plaintext;
});

afterAll(async () => {
  const tenantIds = [tenantA.id, tenantB.id];
  await prisma.tenantApiToken.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.account.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: ownerUser.id } }).catch(() => {});
  await prisma.$disconnect();
});

function makeReq(token: string, body: object): NextRequest {
  return new NextRequest("http://localhost/api/internal/journal-entries", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function baseEntry(entityCode: string, memo: string) {
  return {
    entityCode,
    bookCode: "US_GAAP",
    documentDate: "2026-02-15",
    memo,
    lines: [
      { accountCode: "1000", debit: "1000" },
      { accountCode: "3000", credit: "1000" },
    ],
  };
}

describe("/api/internal/journal-entries: tenant-scoped token enforcement", () => {
  it("Tenant A's token posting to A's entity → 200", async () => {
    const res = await POST(makeReq(tokenA, baseEntry(entityCodeA, "A→A ok")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    // Confirm the row landed in tenant A.
    const je = await prisma.journalEntry.findUnique({
      where: { id: json.id },
      select: { tenantId: true },
    });
    expect(je!.tenantId).toBe(tenantA.id);
  });

  it("Tenant A's token posting to B's entity → 403 TENANT_SCOPE_MISMATCH", async () => {
    const res = await POST(makeReq(tokenA, baseEntry(entityCodeB, "A→B cross-tenant")));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("TENANT_SCOPE_MISMATCH");
  });

  it("Tenant B's token posting to B's entity → 200", async () => {
    const res = await POST(makeReq(tokenB, baseEntry(entityCodeB, "B→B ok")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("Garbage Bearer → 401", async () => {
    const res = await POST(makeReq("totally-bogus-token", baseEntry(entityCodeA, "garbage")));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("Missing Bearer → 401", async () => {
    const req = new NextRequest("http://localhost/api/internal/journal-entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseEntry(entityCodeA, "no auth")),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("Revoked token → 401", async () => {
    // Create + immediately revoke a fresh token so we don't break other tests.
    const fresh = await provisionTenantApiToken({
      tenantId: tenantA.id,
      label: `revoke-test-${SUFFIX}`,
    });
    await revokeTenantApiToken(fresh.tokenId);
    const res = await POST(
      makeReq(fresh.plaintext, baseEntry(entityCodeA, "after revoke"))
    );
    expect(res.status).toBe(401);
  });

  it("Audit log captures the token label on success", async () => {
    const res = await POST(makeReq(tokenA, baseEntry(entityCodeA, "audit metadata test")));
    expect(res.status).toBe(200);
    const log = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenantA.id,
        eventType: "TOKEN_USED",
        outcome: "SUCCESS",
      },
      orderBy: { occurredAt: "desc" },
      select: { metadata: true },
    });
    expect(log).not.toBeNull();
    const meta = log!.metadata as Record<string, unknown>;
    expect(meta.tokenLabel).toBe(`scope-A-${SUFFIX}`);
    expect(meta.tokenSource).toBe("db");
    expect(meta.tenantId).toBe(tenantA.id);
  });

  it("Audit log captures cross-tenant attempts with TOKEN_REJECTED + reason", async () => {
    // The cross-tenant test above attached identity.tenantId = A; the
    // rejection log is therefore scoped to tenant A. Tightening the
    // query rules out unrelated TOKEN_REJECTED logs (garbage Bearer
    // tests etc., which have tenantId = null).
    const log = await prisma.auditLog.findFirst({
      where: {
        eventType: "TOKEN_REJECTED",
        action: "POST /api/internal/journal-entries",
        tenantId: tenantA.id,
      },
      orderBy: { occurredAt: "desc" },
      select: { metadata: true, outcome: true },
    });
    expect(log).not.toBeNull();
    const meta = log!.metadata as Record<string, unknown>;
    expect(meta.reason).toMatch(/tenant scope mismatch/i);
  });
});
