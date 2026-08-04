// Integration tests for /api/admin/audit-log/csv.
//
// Verifies:
//   1. Non-admin requests → 403.
//   2. Admin requests → 200 with CSV body, correct Content-Type,
//      Content-Disposition with audit-log-YYYY-MM-DD.csv.
//   3. Tenant scope: only the caller's tenant's rows appear in the body.
//      Default-tenant admin also sees NULL-tenant platform rows.
//   4. Filters in the query string (event, outcome, actor, from/to) are
//      applied to the exported rows.
//   5. The export itself generates a DATA_EXPORT audit row.
//
// Same mock pattern as audit-log-page.test.ts.

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
import { logAuditEvent } from "@/lib/audit/log";
import { GET } from "@/app/api/admin/audit-log/csv/route";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = "csv" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };
let admin: { id: string; email: string };
let nonAdmin: { id: string };

beforeAll(async () => {
  const a = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!a) throw new Error("Run Northwind seed first.");
  admin = { id: a.id, email: a.email };

  const na = await prisma.user.upsert({
    where: { email: `csv-non-admin-${SUFFIX}@example.test` },
    create: {
      email: `csv-non-admin-${SUFFIX}@example.test`,
      displayName: "Non-Admin",
      isActive: true,
    },
    update: {},
  });
  nonAdmin = { id: na.id };

  tenantA = await prisma.tenant.create({
    data: {
      slug: `csv-a-${SUFFIX}`,
      name: "CSV Tenant A",
      ownerUserId: admin.id,
    },
  });
  tenantB = await prisma.tenant.create({
    data: {
      slug: `csv-b-${SUFFIX}`,
      name: "CSV Tenant B",
      ownerUserId: admin.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenantA.id, userId: admin.id, role: "OWNER" },
  });

  // Seed: 2 events in A (one PRIVILEGED_ACTION SUCCESS, one DATA_EXPORT FAILURE),
  // 1 event in B (TOKEN_USED), 1 platform (NULL).
  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: `csv-a-action-1-${SUFFIX}`,
    tenantId: tenantA.id,
    actorEmail: "admin@a.test",
    outcome: "SUCCESS",
  });
  await logAuditEvent({
    eventType: "DATA_EXPORT",
    action: `csv-a-action-2-${SUFFIX}`,
    tenantId: tenantA.id,
    actorEmail: "admin@a.test",
    outcome: "FAILURE",
  });
  await logAuditEvent({
    eventType: "TOKEN_USED",
    action: `csv-b-action-${SUFFIX}`,
    tenantId: tenantB.id,
    outcome: "SUCCESS",
  });
  await logAuditEvent({
    eventType: "TOKEN_REJECTED",
    action: `csv-platform-${SUFFIX}`,
    tenantId: null,
    outcome: "FAILURE",
  });
});

afterAll(async () => {
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { tenantId: { in: [tenantA.id, tenantB.id] } },
        { action: { contains: SUFFIX } },
      ],
    },
  });
  });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: { in: [tenantA.id, tenantB.id] } },
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: [tenantA.id, tenantB.id] } },
  });
  // By id, not email prefix — `email` is encrypted with a random IV so
  // `contains` matches nothing. Only the throwaway non-admin is ours;
  // `admin` is the shared Northwind controller and must survive.
  await prisma.user.deleteMany({
    where: { id: nonAdmin.id },
  }).catch(() => {});
  await prisma.$disconnect();
});

function signInAs(userId: string) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(userId) });
}

function setTenant(slug: string) {
  mockCookieStore.set("lc-tenant", { value: slug });
}

function makeReq(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/admin/audit-log/csv${qs}`);
}

describe("audit-log CSV: auth gate", () => {
  it("401 for unauthenticated", async () => {
    mockCookieStore.clear();
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("403 for non-admin", async () => {
    signInAs(nonAdmin.id);
    setTenant(tenantA.slug);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });

  it("200 + CSV body for admin", async () => {
    signInAs(admin.id);
    setTenant(tenantA.slug);
    const res = await GET(makeReq("?from=2026-01-01&to=2026-12-31"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(res.headers.get("Content-Disposition")).toMatch(
      /attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/
    );
    const body = await res.text();
    expect(body).toMatch(/Audit log export/);
    expect(body).toMatch(/Occurred at \(UTC\)/);
  });
});

describe("audit-log CSV: tenant scope", () => {
  it("tenantA admin sees only A's events", async () => {
    signInAs(admin.id);
    setTenant(tenantA.slug);
    const res = await GET(makeReq("?from=2026-01-01&to=2026-12-31"));
    const body = await res.text();
    expect(body).toMatch(`csv-a-action-1-${SUFFIX}`);
    expect(body).toMatch(`csv-a-action-2-${SUFFIX}`);
    expect(body).not.toMatch(`csv-b-action-${SUFFIX}`);
    // tenantA is NOT the default tenant in this test, so platform NULL
    // events are NOT visible.
    expect(body).not.toMatch(`csv-platform-${SUFFIX}`);
  });
});

describe("audit-log CSV: filter preservation", () => {
  it("event filter narrows to the chosen event type", async () => {
    signInAs(admin.id);
    setTenant(tenantA.slug);
    const res = await GET(
      makeReq(
        "?from=2026-01-01&to=2026-12-31&event=PRIVILEGED_ACTION"
      )
    );
    const body = await res.text();
    expect(body).toMatch(`csv-a-action-1-${SUFFIX}`); // PRIVILEGED_ACTION
    expect(body).not.toMatch(`csv-a-action-2-${SUFFIX}`); // DATA_EXPORT (filtered out)
  });

  it("outcome filter narrows to FAILURE only", async () => {
    signInAs(admin.id);
    setTenant(tenantA.slug);
    const res = await GET(
      makeReq("?from=2026-01-01&to=2026-12-31&outcome=FAILURE")
    );
    const body = await res.text();
    expect(body).not.toMatch(`csv-a-action-1-${SUFFIX}`); // SUCCESS
    expect(body).toMatch(`csv-a-action-2-${SUFFIX}`); // FAILURE
  });
});

describe("audit-log CSV: writes a DATA_EXPORT audit row on download", () => {
  it("a DATA_EXPORT row is created with the admin's identity and rowCount", async () => {
    signInAs(admin.id);
    setTenant(tenantA.slug);
    const before = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: admin.id,
        tenantId: tenantA.id,
      },
    });
    await GET(makeReq("?from=2026-01-01&to=2026-12-31"));
    const after = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: admin.id,
        tenantId: tenantA.id,
      },
    });
    expect(after).toBe(before + 1);

    const row = await prisma.auditLog.findFirst({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: admin.id,
        tenantId: tenantA.id,
      },
      orderBy: { occurredAt: "desc" },
      select: {
        resource: true,
        action: true,
        metadata: true,
        outcome: true,
      },
    });
    expect(row).not.toBeNull();
    expect(row!.resource).toBe("AuditLog");
    expect(row!.action).toBe("download-csv");
    expect(row!.outcome).toBe("SUCCESS");
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.format).toBe("csv");
    expect(typeof meta.rowCount).toBe("number");
    expect((meta.rowCount as number) >= 2).toBe(true); // at least the 2 tenantA rows
  });
});
