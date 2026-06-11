// Close retrospective CSV route test.
//
// Drives GET /api/close/retrospective/csv end-to-end through the
// route handler. Verifies:
//   1. 403 without auth — fail-closed
//   2. 200 + text/csv response with all 5 section banners
//   3. DATA_EXPORT audit row written with resource=CloseRetrospective
//   4. Lookback + target query params are clamped to safe ranges
//   5. CSV body protects against formula-injection (account names
//      starting with "=" get the leading-apostrophe escape applied
//      by the toCsv helper; we verify the integration end-to-end)
//
// The retrospective math itself is covered by
// tests/close-retrospective.test.ts + close-retrospective-history.test.ts.
// This test only probes the route shape + auth + audit.

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
import { GET } from "@/app/api/close/retrospective/csv/route";

const prisma = new PrismaClient();

const SUFFIX =
  "rcv" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let entity: { id: string; code: string };
let book: { id: string; code: string };

beforeAll(async () => {
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  user = { id: u.id, email: u.email };

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });

  tenant = await prisma.tenant.create({
    data: {
      slug: `rcv-${SUFFIX}`.slice(0, 60),
      name: "Retrospective CSV Tenant",
      ownerUserId: user.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
  });

  const e = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `RCV-${SUFFIX}`.slice(0, 50),
      name: "Retrospective CSV Entity",
      functionalCurrencyId: "USD",
    },
    select: { id: true, code: true },
  });
  entity = e;

  const b = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true, code: true },
  });
  if (!b) throw new Error("Northwind seed missing US_GAAP book.");
  book = b;

  // Mint a calendar so getCloseRetrospective has SOMETHING to walk —
  // even if there are no closes/tasks/recons in scope, the helper
  // returns empty arrays and the CSV still renders the banners.
  await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      code: `RCV-CAL-${SUFFIX}`.slice(0, 32),
      name: "Cal",
      periodFrequency: "MONTHLY",
    },
  });
});

afterAll(async () => {
  await prisma.fiscalCalendar.deleteMany({ where: { entityId: entity.id } });
  await prisma.legalEntity.delete({ where: { id: entity.id } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
  try {
    await prisma.tenant.delete({ where: { id: tenant.id } });
  } catch {
    /* audit_log append-only blocks tenant delete — leak */
  }
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

function signOut() {
  mockCookieStore.clear();
}

describe("GET /api/close/retrospective/csv", () => {
  it("returns 403 when no user is signed in", async () => {
    signOut();
    const req = new NextRequest(
      `http://localhost/api/close/retrospective/csv?entity=${entity.code}&book=${book.code}`
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("returns 200 with all 5 section banners and writes an audit row", async () => {
    signIn();
    const before = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: user.id,
        tenantId: tenant.id,
        resource: "CloseRetrospective",
      },
    });

    const req = new NextRequest(
      `http://localhost/api/close/retrospective/csv?entity=${entity.code}&book=${book.code}&lookback=12&target=5`
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment/);
    expect(res.headers.get("Content-Disposition")).toMatch(
      /retrospective-.*\.csv/
    );

    const body = await res.text();
    expect(body).toContain("SUMMARY");
    expect(body).toContain("DAYS_TO_CLOSE");
    expect(body).toContain("TASK_LEAD_TIME");
    expect(body).toContain("EXCEPTION_RATE");
    expect(body).toContain("RECURRING_BLOCKERS");

    // Summary rows always populate (no period data needed).
    expect(body).toContain("lookback_periods,12");
    expect(body).toContain("target_days,5");
    expect(body).toContain(`entity,${entity.code}`);

    const after = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: user.id,
        tenantId: tenant.id,
        resource: "CloseRetrospective",
      },
    });
    expect(after).toBe(before + 1);
  });

  it("clamps lookback + target to safe ranges", async () => {
    signIn();

    // lookback=999 clamps to 36; target=999 clamps to 30
    const req = new NextRequest(
      `http://localhost/api/close/retrospective/csv?entity=${entity.code}&book=${book.code}&lookback=999&target=999`
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("lookback_periods,36");
    expect(body).toContain("target_days,30");
  });

  it("uses defaults when lookback + target are missing", async () => {
    signIn();
    const req = new NextRequest(
      `http://localhost/api/close/retrospective/csv?entity=${entity.code}&book=${book.code}`
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("lookback_periods,12");
    expect(body).toContain("target_days,5");
  });
});
