// v0.9 NS SuiteAnalytics Phase 1 — endpoint auth + validation test.
//
// Covers the NEW surface this PR adds:
//   - Bearer auth gate (missing / wrong scheme / unknown token → 401)
//   - Query-shape validation (entityCode / bookCode / asOf regex → 400)
//
// Happy-path data (200 with rows from real seeded entity) is deferred
// to Phase 2's resolution-layer test where the multi-tenant fixture is
// already required for the NS internalid resolver. Avoids duplicating
// the seed work here. The report helpers (getTrialBalance / IS / BS)
// are themselves covered by their own integration tests since v1.0.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";

import { provisionTenantApiToken } from "@/lib/auth/token";

import { GET as getTrialBalance } from "@/app/api/external/ns-analytics/trial-balance/route";
import { GET as getIncomeStatement } from "@/app/api/external/ns-analytics/income-statement/route";
import { GET as getBalanceSheet } from "@/app/api/external/ns-analytics/balance-sheet/route";

const prisma = new PrismaClient();
const SUFFIX = "P1ANL";
const TENANT_SLUG = `nsa-${SUFFIX}`;

let tenantId: string;
let ownerUserId: string;
let token: string;

beforeAll(async () => {
  // The env fallback path interferes with negative test assertions.
  delete process.env.INTERNAL_API_TOKEN;

  // Tenant requires an owner user. Create a throwaway one.
  const user = await prisma.user.create({
    data: {
      email: `nsa-${SUFFIX}@example.test`,
      displayName: "NSA test owner",
      isActive: true,
    },
  });
  ownerUserId = user.id;
  const tenant = await prisma.tenant.create({
    data: {
      slug: TENANT_SLUG,
      name: "NS Analytics auth-test tenant",
      ownerUserId: user.id,
    },
  });
  tenantId = tenant.id;
  const prov = await provisionTenantApiToken({
    tenantId,
    label: `nsa-${SUFFIX}`,
  });
  token = prov.plaintext;
});

afterAll(async () => {
  if (tenantId) {
    await prisma.tenantApiToken.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }
  if (ownerUserId) {
    await prisma.user.delete({ where: { id: ownerUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

function makeReq(
  endpoint: string,
  params: Record<string, string>,
  authValue?: string
): NextRequest {
  const url = new URL(`http://localhost${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {};
  if (authValue) headers.authorization = authValue;
  return new NextRequest(url, { method: "GET", headers });
}

const VALID_QUERY = {
  entityCode: "DUMMY_ENTITY",
  bookCode: "US_GAAP",
  asOf: "2026-04-30",
};

describe("v0.9 NS SuiteAnalytics Phase 1: auth gate", () => {
  it("trial-balance returns 401 when Authorization header missing", async () => {
    const res = await getTrialBalance(
      makeReq("/api/external/ns-analytics/trial-balance", VALID_QUERY)
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("trial-balance returns 401 for non-Bearer scheme (Basic)", async () => {
    const res = await getTrialBalance(
      makeReq("/api/external/ns-analytics/trial-balance", VALID_QUERY, `Basic ${token}`)
    );
    expect(res.status).toBe(401);
  });

  it("trial-balance returns 401 for unknown bearer token", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        VALID_QUERY,
        `Bearer ${"deadbeef".repeat(8)}`
      )
    );
    expect(res.status).toBe(401);
  });

  it("income-statement returns 401 with same auth surface", async () => {
    const res = await getIncomeStatement(
      makeReq(
        "/api/external/ns-analytics/income-statement",
        { entityCode: "X", bookCode: "US_GAAP", fromDate: "2026-04-01", toDate: "2026-04-30" }
      )
    );
    expect(res.status).toBe(401);
  });

  it("balance-sheet returns 401 with same auth surface", async () => {
    const res = await getBalanceSheet(
      makeReq("/api/external/ns-analytics/balance-sheet", VALID_QUERY)
    );
    expect(res.status).toBe(401);
  });
});

describe("v0.9 NS SuiteAnalytics Phase 1: query-shape validation", () => {
  // Authenticated cases — validation runs AFTER the auth gate so we
  // need a real token for these to land on the 400 branch.

  it("trial-balance returns 400 for entityCode with control chars", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        { ...VALID_QUERY, entityCode: "ACME\x00" },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });

  it("trial-balance returns 400 for bookCode with shell metacharacters", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        { ...VALID_QUERY, bookCode: "US_GAAP; rm -rf /" },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });

  it("trial-balance returns 400 for asOf with non-ISO shape", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        { ...VALID_QUERY, asOf: "yesterday" },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });

  it("trial-balance returns 400 for missing asOf", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        { entityCode: VALID_QUERY.entityCode, bookCode: VALID_QUERY.bookCode },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });

  it("trial-balance returns 400 for invalid format value", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        { ...VALID_QUERY, format: "xml" },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });

  it("income-statement requires both fromDate and toDate", async () => {
    const res = await getIncomeStatement(
      makeReq(
        "/api/external/ns-analytics/income-statement",
        { entityCode: "X", bookCode: "US_GAAP", fromDate: "2026-04-01" },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });
});

describe("v0.9 NS SuiteAnalytics Phase 2: NS-side scope resolution", () => {
  // Phase 1 accepted entityCode + bookCode. Phase 2 also accepts
  // subsidiary + accountingBook (NS internalids) and resolves via
  // lineage tables. Mixing the two is an explicit operator error.

  it("returns 400 when neither scope param set is provided", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        { asOf: "2026-04-30" },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing scope|either/i);
  });

  it("returns 400 when BOTH scope param sets are provided", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        {
          entityCode: "DUMMY",
          bookCode: "US_GAAP",
          subsidiary: "1",
          accountingBook: "1",
          asOf: "2026-04-30",
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not both|either/i);
  });

  it("returns 400 for an invalid subsidiary internalid shape", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        {
          subsidiary: "1'; DROP TABLE",
          accountingBook: "1",
          asOf: "2026-04-30",
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 with structured error body when subsidiary internalid doesn't resolve", async () => {
    const res = await getTrialBalance(
      makeReq(
        "/api/external/ns-analytics/trial-balance",
        {
          subsidiary: "999",
          accountingBook: "1",
          asOf: "2026-04-30",
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Subsidiary not found.");
    expect(body.nsInternalid).toBe("999");
    expect(body.hint).toBeTruthy();
  });
});

describe("v0.9 NS SuiteAnalytics Phase 1: audit log", () => {
  it("a failed auth attempt writes an ACCESS_DENIED audit row", async () => {
    // Snapshot current count of ACCESS_DENIED for the NS_ANALYTICS_AUTH
    // action. Each failed auth call below should add one row.
    const beforeCount = await prisma.auditLog.count({
      where: { action: "NS_ANALYTICS_AUTH", eventType: "ACCESS_DENIED" },
    });
    await getTrialBalance(
      makeReq("/api/external/ns-analytics/trial-balance", VALID_QUERY)
    );
    const afterCount = await prisma.auditLog.count({
      where: { action: "NS_ANALYTICS_AUTH", eventType: "ACCESS_DENIED" },
    });
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount + 1);
  });
});
