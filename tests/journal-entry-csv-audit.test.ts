// Integration test: per-JE CSV export writes a DATA_EXPORT audit row
// (SOC 2 CC4 lineage discipline). Mirrors tests/report-csv-audit.test.ts.

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
import { GET } from "@/app/api/journal-entries/[id]/csv/route";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("jecsv" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `JECSV-${SUFFIX}`;

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let entityId: string;
let entryId: string;

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });

  const u = await prisma.user.create({
    data: {
      email: `je-csv-${SUFFIX}@example.test`,
      displayName: "JE CSV tester",
      isActive: true,
    },
  });
  user = { id: u.id, email: u.email };

  tenant = await prisma.tenant.create({
    data: {
      slug: `je-csv-${SUFFIX.toLowerCase()}`,
      name: "JE CSV tenant",
      ownerUserId: user.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: ENTITY_CODE,
      name: "JE CSV Co.",
      functionalCurrencyId: "USD",
    },
  });
  entityId = entity.id;

  // Two minimal accounts so postJournalEntry has somewhere to write.
  await prisma.account.createMany({
    data: [
      {
        tenantId: tenant.id,
        entityId,
        code: "1000",
        name: "Cash",
        type: "ASSET",
        normalBalance: "DEBIT",
      },
      {
        tenantId: tenant.id,
        entityId,
        code: "4000",
        name: "Revenue",
        type: "REVENUE",
        normalBalance: "CREDIT",
      },
    ],
  });

  const result = await postJournalEntry(prisma, {
    tenantId: tenant.id,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-01"),
    memo: "JE CSV audit test",
    source: "MANUAL",
    createdBy: user.email,
    lines: [
      { accountCode: "1000", debit: "500" },
      { accountCode: "4000", credit: "500" },
    ],
  });
  entryId = result.id;
});

afterAll(async () => {
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
  });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

describe("GET /api/journal-entries/[id]/csv", () => {
  it("returns the JE as CSV and writes a DATA_EXPORT audit row", async () => {
    signIn();
    const before = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        tenantId: tenant.id,
        resource: "JournalEntry",
      },
    });

    const req = new NextRequest(
      `http://localhost/api/journal-entries/${entryId}/csv`
    );
    const res = await GET(req, { params: { id: entryId } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);

    const body = await res.text();
    // Header rows + a blank + the column row + 2 lines = 14 rows.
    expect(body).toMatch(/Journal Entry/);
    expect(body).toMatch(/1000/);
    expect(body).toMatch(/4000/);
    expect(body).toMatch(/500/);

    const after = await prisma.auditLog.count({
      where: {
        eventType: "DATA_EXPORT",
        tenantId: tenant.id,
        resource: "JournalEntry",
      },
    });
    expect(after).toBe(before + 1);

    const row = await prisma.auditLog.findFirst({
      where: {
        eventType: "DATA_EXPORT",
        tenantId: tenant.id,
        resource: "JournalEntry",
      },
      orderBy: { occurredAt: "desc" },
      select: { resource: true, action: true, actorEmail: true, metadata: true, outcome: true },
    });
    expect(row).not.toBeNull();
    expect(row!.resource).toBe("JournalEntry");
    expect(row!.action).toBe("download-csv");
    expect(row!.outcome).toBe("SUCCESS");
    expect(row!.actorEmail).toBe(user.email);
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.format).toBe("csv");
    expect(meta.rowCount).toBe(2);
  });

  it("returns 404 for a cross-tenant id", async () => {
    // Sign in as a DIFFERENT tenant — the lookup should refuse to leak
    // the entry that lives in `tenant`.
    const otherUser = await prisma.user.create({
      data: {
        email: `je-csv-other-${SUFFIX}@example.test`,
        displayName: "other",
        isActive: true,
      },
    });
    const otherTenant = await prisma.tenant.create({
      data: {
        slug: `je-csv-other-${SUFFIX.toLowerCase()}`,
        name: "Other tenant",
        ownerUserId: otherUser.id,
      },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: otherTenant.id, userId: otherUser.id, role: "OWNER" },
    });
    try {
      mockCookieStore.clear();
      mockCookieStore.set("lc-user", { value: authInternal.encode(otherUser.id) });
      mockCookieStore.set("lc-tenant", { value: otherTenant.slug });
      const req = new NextRequest(
        `http://localhost/api/journal-entries/${entryId}/csv`
      );
      const res = await GET(req, { params: { id: entryId } });
      expect(res.status).toBe(404);
    } finally {
      await prisma.tenantMembership.deleteMany({ where: { tenantId: otherTenant.id } });
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
      await prisma.user.delete({ where: { id: otherUser.id } }).catch(() => {});
    }
  });
});
