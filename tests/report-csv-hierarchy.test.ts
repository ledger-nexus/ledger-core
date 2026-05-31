// Integration tests for the hierarchy-aware report CSV exports.
//
// What we verify:
//   - Default (hierarchical) BS / IS / TB CSVs emit the Depth + Type
//     columns and include subtotal rows for parent accounts.
//   - The ?flat=1 override emits the old shape (no Depth / no Type)
//     so legacy CSV consumers stay working.
//   - Subtotal math: parent row's amount equals the sum of its
//     children's amounts (recursive — locked in via a real parent/
//     child pair seeded for this test).
//   - Each route still writes the DATA_EXPORT audit row (no regression
//     from the existing tests/report-csv-audit.test.ts coverage).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

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
import { GET as bsCsv } from "@/app/api/reports/balance-sheet/csv/route";
import { GET as isCsv } from "@/app/api/reports/income-statement/csv/route";
import { GET as tbCsv } from "@/app/api/reports/trial-balance/csv/route";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = ("HIER" + Date.now().toString(36)).toUpperCase();
const ENTITY_CODE = `HIER-${SUFFIX}`;

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let entityId: string;

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
      email: `csvhier-${SUFFIX}@example.test`,
      displayName: "CSV hierarchy tester",
      isActive: true,
    },
  });
  user = { id: u.id, email: u.email };

  tenant = await prisma.tenant.create({
    data: {
      slug: `csvhier-${SUFFIX.toLowerCase()}`,
      name: "CSV hier tenant",
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
      name: "CSV Hier Co.",
      functionalCurrencyId: "USD",
    },
  });
  entityId = entity.id;

  // Calendar + a period so postJournalEntry has somewhere to bind.
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId,
      code: `CAL-${SUFFIX}`,
      name: "Test cal",
      periodFrequency: "MONTHLY",
    },
  });
  await prisma.period.create({
    data: {
      tenantId: tenant.id,
      calendarId: cal.id,
      code: "2026-05",
      ordinal: 5,
      startsOn: new Date(Date.UTC(2026, 4, 1)),
      endsOn: new Date(Date.UTC(2026, 4, 31)),
    },
  });

  // Build a tiny hierarchy:
  //   1000 Current Assets (group)
  //     1010 Cash             (leaf, debit 100)
  //     1200 AR               (leaf, debit 25)
  //   3000 Common Stock       (leaf, credit 125)
  // BS: Assets 125 = Liab 0 + Equity 125 ✓
  const parent = await prisma.account.create({
    data: {
      tenantId: tenant.id,
      entityId,
      code: "1000",
      name: "Current Assets",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
  });
  await prisma.account.createMany({
    data: [
      {
        tenantId: tenant.id,
        entityId,
        code: "1010",
        name: "Cash",
        type: "ASSET",
        normalBalance: "DEBIT",
        parentAccountId: parent.id,
      },
      {
        tenantId: tenant.id,
        entityId,
        code: "1200",
        name: "AR",
        type: "ASSET",
        normalBalance: "DEBIT",
        parentAccountId: parent.id,
      },
      {
        tenantId: tenant.id,
        entityId,
        code: "3000",
        name: "Common Stock",
        type: "EQUITY",
        normalBalance: "CREDIT",
      },
    ],
  });

  // Post 2 JEs:
  //   1. Dr Cash 100 / Cr Common Stock 100
  //   2. Dr AR 25 / Cr Common Stock 25
  await postJournalEntry(prisma, {
    tenantId: tenant.id,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-10"),
    memo: "Capital infusion #1",
    source: "MANUAL",
    createdBy: user.email,
    lines: [
      { accountCode: "1010", debit: "100" },
      { accountCode: "3000", credit: "100" },
    ],
  });
  await postJournalEntry(prisma, {
    tenantId: tenant.id,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-15"),
    memo: "AR billing",
    source: "MANUAL",
    createdBy: user.email,
    lines: [
      { accountCode: "1200", debit: "25" },
      { accountCode: "3000", credit: "25" },
    ],
  });
});

afterAll(async () => {
  // audit_log is DB-level append-only (CC6 RULE) — escape hatch lets
  // cleanup remove rows that would otherwise block tenant.delete via FK.
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
  });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.period.deleteMany({ where: { calendar: { entityId } } });
  await prisma.fiscalCalendar.deleteMany({ where: { entityId } });
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
  // Scope this test entity into the cookie so getScope() resolves.
  mockCookieStore.set("lc-scope", { value: JSON.stringify({ entityCode: ENTITY_CODE, bookCode: "US_GAAP" }) });
}

describe("Balance Sheet CSV — hierarchy", () => {
  it("default (hierarchical) emits Depth + Type columns + a subtotal row for the parent", async () => {
    signIn();
    const res = await bsCsv(
      new NextRequest(`http://localhost/api/reports/balance-sheet/csv?asOf=2026-05-31`)
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Header row should have the hierarchy columns.
    expect(body).toMatch(/Section,Code,Depth,Account,Type,Amount/);
    // Parent row "Current Assets" should appear with Type=subtotal.
    expect(body).toMatch(/1000,0,Current Assets,subtotal,125\.00/);
    // Children should appear at depth 1, indented with two leading spaces.
    expect(body).toMatch(/1010,1,  Cash,leaf,100\.00/);
    expect(body).toMatch(/1200,1,  AR,leaf,25\.00/);
  });

  it("?flat=1 emits the old per-account-only shape", async () => {
    signIn();
    const res = await bsCsv(
      new NextRequest(`http://localhost/api/reports/balance-sheet/csv?asOf=2026-05-31&flat=1`)
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Old shape: no Depth / no Type columns.
    expect(body).toMatch(/Section,Code,Account,Amount/);
    expect(body).not.toMatch(/Section,Code,Depth/);
    // Cash + AR appear directly (no indent).
    expect(body).toMatch(/Asset,1010,Cash,100\.00/);
    expect(body).toMatch(/Asset,1200,AR,25\.00/);
  });

  it("writes a DATA_EXPORT audit row both with and without ?flat", async () => {
    signIn();
    const before = await prisma.auditLog.count({
      where: { eventType: "DATA_EXPORT", tenantId: tenant.id, resource: "BalanceSheet" },
    });
    await bsCsv(new NextRequest(`http://localhost/api/reports/balance-sheet/csv?asOf=2026-05-31`));
    await bsCsv(
      new NextRequest(`http://localhost/api/reports/balance-sheet/csv?asOf=2026-05-31&flat=1`)
    );
    const after = await prisma.auditLog.count({
      where: { eventType: "DATA_EXPORT", tenantId: tenant.id, resource: "BalanceSheet" },
    });
    expect(after).toBe(before + 2);
  });
});

describe("Income Statement CSV — hierarchy", () => {
  it("default emits Depth + Type columns", async () => {
    signIn();
    const res = await isCsv(
      new NextRequest(`http://localhost/api/reports/income-statement/csv?from=2026-05-01&to=2026-05-31`)
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Section,Code,Depth,Account,Type,Amount/);
    // This entity has no Revenue/Expense activity — the section will
    // still emit a TOTAL row at the bottom of each section.
    expect(body).toMatch(/Revenue,,,TOTAL REVENUE,total,0\.00/);
    expect(body).toMatch(/Expense,,,TOTAL EXPENSES,total,0\.00/);
  });
});

describe("Trial Balance CSV — hierarchy", () => {
  it("default emits Depth + Group columns + subtotal row for the parent (with Dr / Cr roll-up)", async () => {
    signIn();
    const res = await tbCsv(
      new NextRequest(`http://localhost/api/reports/trial-balance/csv?asOf=2026-05-31`)
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Code,Depth,Account,Type,Group,Debit,Credit/);
    // Current Assets parent row: subtotal Dr = 125 (sum of Cash 100 + AR 25),
    // Cr = 0.
    expect(body).toMatch(/1000,0,Current Assets,ASSET,subtotal,125\.00,0\.00/);
    // Leaves at depth 1.
    expect(body).toMatch(/1010,1,  Cash,ASSET,leaf,100\.00,0\.00/);
    expect(body).toMatch(/1200,1,  AR,ASSET,leaf,25\.00,0\.00/);
    // Common Stock leaf at depth 0 (no parent), 125 credit total.
    expect(body).toMatch(/3000,0,Common Stock,EQUITY,leaf,0\.00,125\.00/);
    // TOTALS row.
    expect(body).toMatch(/,,TOTALS,,,125\.00,125\.00/);
  });

  it("?flat=1 keeps the legacy 5-column shape", async () => {
    signIn();
    const res = await tbCsv(
      new NextRequest(`http://localhost/api/reports/trial-balance/csv?asOf=2026-05-31&flat=1`)
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Code,Account,Type,Debit,Credit/);
    expect(body).not.toMatch(/Code,Depth/);
  });
});
