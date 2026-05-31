// Integration test for SOC 2 CC4 data-export audit on report CSV routes.
//
// Mirrors tests/audit-log-csv.test.ts ("writes a DATA_EXPORT audit row on
// download"). One representative route is covered here (trial-balance);
// the same import + audit-call pattern is repeated across all 11 report
// routes. If a future contributor copy-pastes a new report route from one
// of the others, this test enforces the lineage doesn't get dropped.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (
      opts: { name: string; value: string } | string,
      maybeValue?: string
    ) => {
      if (typeof opts === "string") {
        mockCookieStore.set(opts, { value: maybeValue ?? "" });
      } else {
        mockCookieStore.set(opts.name, { value: opts.value });
      }
    },
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import { GET } from "@/app/api/reports/trial-balance/csv/route";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = "rpt" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenant: { id: string; slug: string };
let user: { id: string; email: string };

beforeAll(async () => {
  // Reuse the seeded controller — the route has no admin gate, but
  // getCurrentUser still needs a real User row to resolve identity.
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  user = { id: u.id, email: u.email };

  tenant = await prisma.tenant.create({
    data: {
      slug: `rpt-${SUFFIX}`,
      name: "Report CSV Tenant",
      ownerUserId: user.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
  });
  // The CSV route now goes through getCurrentScope(), which requires
  // the tenant to have at least one entity (the scope fallback target).
  // Add a placeholder entity so the smoke test reaches the report.
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `RPT-${SUFFIX}`,
      name: "Report CSV Entity",
      functionalCurrencyId: "USD",
    },
  });
});

afterAll(async () => {
  // audit_log is DB-level append-only (CC6 RULE) — escape hatch lets
  // cleanup remove rows that would otherwise block tenant.delete via FK.
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({
      where: { tenantId: tenant.id },
    });
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId: tenant.id },
  });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: tenant.id },
  });
  await prisma.tenant.delete({ where: { id: tenant.id } });
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
  // Default scope is fine — NORTHWIND / US_GAAP from the seed.
}

describe("report CSV: writes a DATA_EXPORT audit row on download", () => {
  it("trial-balance CSV writes a DATA_EXPORT row with resource=TrialBalance", async () => {
    signIn();
    const before = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: user.id,
        tenantId: tenant.id,
        resource: "TrialBalance",
      },
    });
    const req = new NextRequest(
      "http://localhost/api/reports/trial-balance/csv?asOf=2026-12-31"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);

    const after = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: user.id,
        tenantId: tenant.id,
        resource: "TrialBalance",
      },
    });
    expect(after).toBe(before + 1);

    const row = await prisma.auditLog.findFirst({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: user.id,
        tenantId: tenant.id,
        resource: "TrialBalance",
      },
      orderBy: { occurredAt: "desc" },
      select: {
        resource: true,
        action: true,
        actorEmail: true,
        metadata: true,
        outcome: true,
      },
    });
    expect(row).not.toBeNull();
    expect(row!.resource).toBe("TrialBalance");
    expect(row!.action).toBe("download-csv");
    expect(row!.outcome).toBe("SUCCESS");
    expect(row!.actorEmail).toBe(user.email);
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.format).toBe("csv");
    expect(typeof meta.rowCount).toBe("number");
  });
});
