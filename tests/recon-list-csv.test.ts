// BlackLine arc — Phase 1 PR 3 integration test.
//
// Drives GET /api/close/reconciliations/csv end-to-end through the route
// handler. Verifies:
//   1. The sort default (abs(diff) DESC, nulls last) — the worst-
//      disagreement row appears first in the CSV body.
//   2. The status filter returns only that status.
//   3. A DATA_EXPORT audit row lands with resource=ReconciliationList
//      and the expected metadata shape (CC7.2).
//   4. The CSV is formula-injection-safe (we check that an account name
//      starting with "=" gets the leading-apostrophe escape).
//
// Mirrors tests/report-csv-audit.test.ts setup: real Postgres, the
// next/headers cookie shim, the seeded controller user.

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
import { GET } from "@/app/api/close/reconciliations/csv/route";

const prisma = new PrismaClient();

const SUFFIX =
  "rcn3" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let entity: { id: string; code: string };
let book: { id: string; code: string };
let period: { id: string; code: string };
const createdReconIds: string[] = [];
const createdAccountIds: string[] = [];

beforeAll(async () => {
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!u) throw new Error("Run Northwind seed first (pnpm db:seed).");
  user = { id: u.id, email: u.email };

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });

  tenant = await prisma.tenant.create({
    data: {
      slug: `rcn3-${SUFFIX}`.slice(0, 60),
      name: "Recon CSV Tenant",
      ownerUserId: user.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
  });

  const e = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `RCN-${SUFFIX}`.slice(0, 50),
      name: "Recon CSV Entity",
      functionalCurrencyId: "USD",
    },
    select: { id: true, code: true },
  });
  entity = e;

  // Reuse the seeded book (Northwind seed creates US_GAAP).
  const b = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true, code: true },
  });
  if (!b) throw new Error("Northwind seed missing US_GAAP book.");
  book = b;

  // Mint a fiscal calendar + period for this entity.
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      code: `CAL-${SUFFIX}`.slice(0, 32),
      name: `Calendar ${SUFFIX}`,
      periodFrequency: "MONTHLY",
    },
  });
  const per = await prisma.period.create({
    data: {
      tenantId: tenant.id,
      calendarId: cal.id,
      code: `${SUFFIX.slice(0, 8)}-01`,
      ordinal: 1,
      startsOn: new Date("2026-06-01"),
      endsOn: new Date("2026-06-30"),
    },
    select: { id: true, code: true },
  });
  period = per;

  // Three accounts at three diff magnitudes — small, medium, large —
  // plus one with a formula-injection payload in the name.
  // The diff column is GL − supporting; we precompute and persist so
  // the route's sort surfaces the exact order we expect.
  async function mintAccount(code: string, name: string): Promise<string> {
    const a = await prisma.account.create({
      data: {
        tenantId: tenant.id,
        code,
        name,
        type: "ASSET",
        normalBalance: "DEBIT",
      },
      select: { id: true },
    });
    createdAccountIds.push(a.id);
    return a.id;
  }
  async function mintRecon(opts: {
    accountId: string;
    gl: string;
    supporting: string;
    status: "OPEN" | "PREPARED" | "RECONCILED" | "EXCEPTION";
  }): Promise<void> {
    const glD = parseFloat(opts.gl);
    const supD = parseFloat(opts.supporting);
    const r = await prisma.reconciliation.create({
      data: {
        tenantId: tenant.id,
        entityId: entity.id,
        bookId: book.id,
        periodId: period.id,
        accountId: opts.accountId,
        glBalance: opts.gl as never,
        supportingBalance: opts.supporting as never,
        reconciledDiff: (glD - supD).toFixed(4) as never,
        tolerance: "0.5000" as never,
        status: opts.status,
        requiresReview: true,
      },
      select: { id: true },
    });
    createdReconIds.push(r.id);
  }

  // Account A: diff +200,000 (the biggest absolute disagreement).
  const aId = await mintAccount(`R${SUFFIX}A`.slice(0, 20), "Acct Big");
  await mintRecon({ accountId: aId, gl: "1000000.00", supporting: "800000.00", status: "EXCEPTION" });

  // Account B: diff −100,000.
  const bId = await mintAccount(`R${SUFFIX}B`.slice(0, 20), "Acct Mid");
  await mintRecon({ accountId: bId, gl: "100.00", supporting: "100100.00", status: "PREPARED" });

  // Account C: tiny diff +0.25 (within tolerance → RECONCILED in real
  // life; we force RECONCILED here so the status filter has a target).
  const cId = await mintAccount(`R${SUFFIX}C`.slice(0, 20), "Acct Small");
  await mintRecon({ accountId: cId, gl: "100.25", supporting: "100.00", status: "RECONCILED" });

  // Account D: account name starts with "=" — formula-injection proof.
  // (Tested via the toCsv helper directly in csv.test.ts; here we want
  // a smoke check that the payload survives the route.)
  const dId = await mintAccount(`R${SUFFIX}D`.slice(0, 20), "=danger()");
  await mintRecon({ accountId: dId, gl: "50.00", supporting: "50.00", status: "OPEN" });
});

afterAll(async () => {
  // Clean owned rows. `audit_log` is DB-level append-only (CLAUDE.md
  // task #15) — Prisma's deleteMany returns count:0 and the FK from
  // audit_log.tenantId pins the test tenant in place. We accept the
  // leak: per-run slugs are timestamp-unique so they never collide.
  await prisma.reconciliation.deleteMany({
    where: { id: { in: createdReconIds } },
  });
  await prisma.account.deleteMany({
    where: { id: { in: createdAccountIds } },
  });
  await prisma.period.delete({ where: { id: period.id } });
  await prisma.fiscalCalendar.deleteMany({ where: { entityId: entity.id } });
  await prisma.legalEntity.delete({ where: { id: entity.id } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
  // Best-effort tenant wipe. Will throw on the audit_log FK in CI envs
  // that retain the append-only constraint; we swallow it so the test
  // suite doesn't go red on a known constraint.
  try {
    await prisma.tenant.delete({ where: { id: tenant.id } });
  } catch {
    /* expected when audit rows pin tenantId — see comment above */
  }
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

describe("Reconciliations CSV — sort, filter, audit", () => {
  it("returns 200 with the worst-disagreement row first, audit row written", async () => {
    signIn();
    const before = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: user.id,
        tenantId: tenant.id,
        resource: "ReconciliationList",
      },
    });

    const req = new NextRequest(
      `http://localhost/api/close/reconciliations/csv?period=${period.code}&entity=${entity.code}&book=US_GAAP`
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);

    const body = await res.text();
    const lines = body.split("\n");
    // Header block is 7 rows (Title, Entity, Book, Period, Status, Count,
    // blank) + 1 column-header row, then data rows in sort order.
    // Find the column header row to anchor.
    const headerIdx = lines.findIndex((l) => l.startsWith("Account code,"));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    const dataRows = lines.slice(headerIdx + 1).filter((l) => l.length > 0);
    expect(dataRows.length).toBe(4);

    // Sort proof: row 1 = Acct Big (diff 200,000); row 2 = Acct Mid
    // (diff −100,000 — abs 100,000); row 3 = Acct Small (0.25); row 4 =
    // formula-injection row (0.00 — sorted last on abs).
    expect(dataRows[0]).toContain("Acct Big");
    expect(dataRows[1]).toContain("Acct Mid");
    expect(dataRows[2]).toContain("Acct Small");
    // The formula-injection row's name should have a leading apostrophe
    // applied by toCsv()'s escapeFormula() — proves the safety hook
    // survived end-to-end.
    expect(dataRows[3]).toContain("'=danger()");

    const after = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: user.id,
        tenantId: tenant.id,
        resource: "ReconciliationList",
      },
    });
    expect(after).toBe(before + 1);

    const row = await prisma.auditLog.findFirst({
      where: {
        eventType: "DATA_EXPORT",
        actorUserId: user.id,
        tenantId: tenant.id,
        resource: "ReconciliationList",
      },
      orderBy: { occurredAt: "desc" },
      select: { action: true, metadata: true, resourceId: true },
    });
    expect(row).not.toBeNull();
    expect(row!.action).toBe("download-csv");
    expect(row!.resourceId).toContain(entity.code);
    expect(row!.resourceId).toContain("US_GAAP");
    expect(row!.resourceId).toContain(period.code);
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.rowCount).toBe(4);
  });

  it("filters by ?status=RECONCILED — only that status surfaces", async () => {
    signIn();
    const req = new NextRequest(
      `http://localhost/api/close/reconciliations/csv?period=${period.code}&entity=${entity.code}&book=US_GAAP&status=RECONCILED`
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    const lines = body.split("\n");
    const headerIdx = lines.findIndex((l) => l.startsWith("Account code,"));
    const dataRows = lines.slice(headerIdx + 1).filter((l) => l.length > 0);
    expect(dataRows.length).toBe(1);
    expect(dataRows[0]).toContain("Acct Small");
  });

  it("rejects unknown status values with 400", async () => {
    signIn();
    const req = new NextRequest(
      `http://localhost/api/close/reconciliations/csv?period=${period.code}&entity=${entity.code}&book=US_GAAP&status=BOGUS`
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("unknown period returns 404", async () => {
    signIn();
    const req = new NextRequest(
      `http://localhost/api/close/reconciliations/csv?period=9999-99&entity=${entity.code}&book=US_GAAP`
    );
    const res = await GET(req);
    expect(res.status).toBe(404);
  });
});
