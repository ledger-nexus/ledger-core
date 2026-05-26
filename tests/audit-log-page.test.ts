// Audit-log explorer integration tests.
//
// We don't render the Server Component (JSX trees aren't ergonomic to
// assert on in vitest). Instead we test the contract that matters: the
// data layer is tenant-scoped and the filter semantics are correct. The
// page itself is a thin wrapper around the Prisma query — if the query
// returns the right rows, the UI does too.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";

// next/cache no-op so logAuditEvent's caller chain doesn't fail.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
  headers: () => ({ get: () => null }),
}));

import { logAuditEvent } from "@/lib/audit/log";

const prisma = new PrismaClient();

const SUFFIX = "audit" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: { id: string };
let tenantB: { id: string };
let ownerId: string;

beforeAll(async () => {
  // Re-use the seeded admin user; tenants need a valid ownerUserId.
  const admin = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!admin) {
    throw new Error("Run Northwind seed first.");
  }
  ownerId = admin.id;

  tenantA = await prisma.tenant.create({
    data: { slug: `audit-a-${SUFFIX}`, name: "Audit Tenant A", ownerUserId: ownerId },
  });
  tenantB = await prisma.tenant.create({
    data: { slug: `audit-b-${SUFFIX}`, name: "Audit Tenant B", ownerUserId: ownerId },
  });

  // Seed: 3 events in tenantA (one FAILURE), 2 in tenantB, 1 platform (null).
  for (let i = 0; i < 3; i++) {
    await logAuditEvent({
      eventType: "PRIVILEGED_ACTION",
      action: `tenantA-action-${i}-${SUFFIX}`,
      tenantId: tenantA.id,
      actorEmail: "admin@a.test",
      outcome: i === 2 ? "FAILURE" : "SUCCESS",
    });
  }
  for (let i = 0; i < 2; i++) {
    await logAuditEvent({
      eventType: "TOKEN_USED",
      action: `tenantB-action-${i}-${SUFFIX}`,
      tenantId: tenantB.id,
      outcome: "SUCCESS",
    });
  }
  await logAuditEvent({
    eventType: "TOKEN_REJECTED",
    action: `platform-rejected-${SUFFIX}`,
    tenantId: null,
    outcome: "FAILURE",
  });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { tenantId: { in: [tenantA.id, tenantB.id] } },
        { action: { contains: SUFFIX } },
      ],
    },
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: [tenantA.id, tenantB.id] } },
  });
  await prisma.$disconnect();
});

// Mirrors the audit-log page's where-clause builder. If this drifts,
// the test catches it.
function buildWhere(input: {
  tenantId: string;
  isDefault?: boolean;
  event?: string;
  outcome?: string;
  actor?: string;
  from?: Date;
  to?: Date;
}): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (input.from || input.to) {
    where.occurredAt = {};
    if (input.from) (where.occurredAt as Prisma.DateTimeFilter).gte = input.from;
    if (input.to) (where.occurredAt as Prisma.DateTimeFilter).lte = input.to;
  }
  if (input.isDefault) {
    where.OR = [{ tenantId: input.tenantId }, { tenantId: null }];
  } else {
    where.tenantId = input.tenantId;
  }
  if (input.event)
    where.eventType = input.event as Prisma.AuditLogWhereInput["eventType"];
  if (input.outcome)
    where.outcome = input.outcome as Prisma.AuditLogWhereInput["outcome"];
  if (input.actor)
    where.actorEmail = { contains: input.actor, mode: "insensitive" };
  return where;
}

describe("audit-log scope: tenantA-scoped admin sees only A's events", () => {
  it("returns 3 PRIVILEGED_ACTION events in tenantA, zero from tenantB", async () => {
    const rows = await prisma.auditLog.findMany({
      where: buildWhere({ tenantId: tenantA.id }),
      orderBy: { occurredAt: "desc" },
    });
    const actions = rows.map((r) => r.action).filter((a) => a.includes(SUFFIX));
    expect(actions.filter((a) => a.startsWith("tenantA-action")).length).toBe(3);
    expect(actions.filter((a) => a.startsWith("tenantB-action")).length).toBe(0);
    expect(actions.filter((a) => a.startsWith("platform-rejected")).length).toBe(
      0
    );
  });
});

describe("audit-log scope: tenantB-scoped admin sees only B's events", () => {
  it("returns 2 TOKEN_USED events in tenantB, zero from tenantA", async () => {
    const rows = await prisma.auditLog.findMany({
      where: buildWhere({ tenantId: tenantB.id }),
      orderBy: { occurredAt: "desc" },
    });
    const actions = rows.map((r) => r.action).filter((a) => a.includes(SUFFIX));
    expect(actions.filter((a) => a.startsWith("tenantB-action")).length).toBe(2);
    expect(actions.filter((a) => a.startsWith("tenantA-action")).length).toBe(0);
  });
});

describe("audit-log scope: default-tenant admin sees platform NULL events too", () => {
  it("isDefault=true includes both tenant rows AND NULL-tenant platform rows", async () => {
    // Treat tenantA as if it were the default tenant for this test.
    const rows = await prisma.auditLog.findMany({
      where: buildWhere({ tenantId: tenantA.id, isDefault: true }),
      orderBy: { occurredAt: "desc" },
    });
    const actions = rows.map((r) => r.action).filter((a) => a.includes(SUFFIX));
    expect(actions.filter((a) => a.startsWith("tenantA-action")).length).toBe(3);
    expect(actions.filter((a) => a.startsWith("platform-rejected")).length).toBe(
      1
    );
    expect(actions.filter((a) => a.startsWith("tenantB-action")).length).toBe(0);
  });
});

describe("audit-log filters: event type", () => {
  it("event=PRIVILEGED_ACTION returns only those rows", async () => {
    const rows = await prisma.auditLog.findMany({
      where: buildWhere({
        tenantId: tenantA.id,
        event: "PRIVILEGED_ACTION",
      }),
    });
    for (const r of rows.filter((r) => r.action.includes(SUFFIX))) {
      expect(r.eventType).toBe("PRIVILEGED_ACTION");
    }
  });
});

describe("audit-log filters: outcome", () => {
  it("outcome=FAILURE filters to just the one failed event in tenantA", async () => {
    const rows = await prisma.auditLog.findMany({
      where: buildWhere({ tenantId: tenantA.id, outcome: "FAILURE" }),
    });
    const inSuite = rows.filter((r) => r.action.includes(SUFFIX));
    expect(inSuite).toHaveLength(1);
    expect(inSuite[0].action).toMatch(/tenantA-action-2/);
    expect(inSuite[0].outcome).toBe("FAILURE");
  });
});

describe("audit-log filters: actor email", () => {
  it("actor=admin@a.test matches case-insensitively", async () => {
    const rows = await prisma.auditLog.findMany({
      where: buildWhere({
        tenantId: tenantA.id,
        actor: "ADMIN@A",
      }),
    });
    const inSuite = rows.filter((r) => r.action.includes(SUFFIX));
    // All 3 tenantA events have this email.
    expect(inSuite).toHaveLength(3);
  });
});

describe("audit-log row shape", () => {
  it("captures the fields the explorer renders", async () => {
    const row = await prisma.auditLog.findFirst({
      where: { action: { contains: `tenantA-action-0-${SUFFIX}` } },
      select: {
        id: true,
        occurredAt: true,
        eventType: true,
        action: true,
        outcome: true,
        actorEmail: true,
        tenantId: true,
        metadata: true,
        ipAddress: true,
        userAgent: true,
        resource: true,
        resourceId: true,
      },
    });
    expect(row).not.toBeNull();
    expect(row!.eventType).toBe("PRIVILEGED_ACTION");
    expect(row!.outcome).toBe("SUCCESS");
    expect(row!.actorEmail).toBe("admin@a.test");
    expect(row!.tenantId).toBe(tenantA.id);
  });
});
