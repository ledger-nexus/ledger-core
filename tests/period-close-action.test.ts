// Period close + reopen tests.
//
// The substrate has had PERIOD_CLOSED enforcement since v0.2 (postJournalEntry
// rejects writes against any (entity, book, period) with a row in
// `period_close`). What's NEW in v1.12 is the admin-gated Server Action
// path for creating/removing those rows.
//
// These tests cover:
//   1. closePeriodAction creates a PeriodClose row + stamps closedBy.
//   2. postJournalEntry now rejects writes to that period.
//   3. Idempotent close (second call returns wasAlreadyClosed=true,
//      doesn't bump closedAt).
//   4. reopenPeriodAction removes the row + unblocks posting.
//   5. Idempotent reopen.
//   6. Per-book independence: closing US_GAAP doesn't close US_TAX.
//
// Auth: the Server Actions call requireAdmin() which reads from the
// `lc-user` HMAC-signed cookie and checks the email against the
// hardcoded ADMIN_EMAIL_ALLOWLIST. We use the seed admin email
// (controller@northwind.test) and the exported _internal.encode helper
// to produce a valid cookie.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
// next/headers' cookies() only works inside a Next.js request scope.
// Mock it with a simple in-memory store so the auth stub + the Server
// Action's revalidatePath calls can run in vitest. Must be hoisted
// before the modules that import from next/headers are evaluated.
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
}));
// next/cache's revalidatePath is a no-op in test context.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { PeriodClosedError } from "../src/lib/accounting/types";
import {
  closePeriodAction,
  reopenPeriodAction,
} from "../src/app/actions/period-close";
import { _internal as authInternal } from "../src/lib/auth/current-user";

const prisma = new PrismaClient();

const ENTITY_CODE = "CLOSECO";
const BOOK_GAAP = "US_GAAP";
const BOOK_TAX = "US_TAX";
const ADMIN_EMAIL = "controller@northwind.test";

let adminUserId: string;

beforeAll(async () => {
  await seedMasterData();
});

async function clearLedger() {
  // Wipe close state + journal entries for this test entity; preserve seed data.
  await prisma.periodClose.deleteMany({
    where: { entity: { code: ENTITY_CODE } },
  });
  await prisma.journalLine.deleteMany({
    where: { entry: { entity: { code: ENTITY_CODE } } },
  });
  await prisma.journalEntry.deleteMany({
    where: { entity: { code: ENTITY_CODE } },
  });
}

beforeEach(clearLedger);
afterAll(async () => {
  await clearLedger();
  await prisma.$disconnect();
});

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY_CODE } },
    create: { tenantId, code: ENTITY_CODE, name: "Close Co.", functionalCurrencyId: "USD" },
    update: { tenantId },
  });
  for (const b of [
    { code: BOOK_GAAP, name: "US GAAP", basis: "US_GAAP" as const },
    { code: BOOK_TAX, name: "US Tax", basis: "US_TAX" as const },
  ]) {
    await prisma.book.upsert({
      where: { code: b.code },
      create: { code: b.code, name: b.name, basis: b.basis, reportingCurrencyId: "USD" },
      update: {},
    });
  }
  for (const a of [
    { code: "1000", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
    { code: "4000", name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
  ] as const) {
    const existing = await prisma.account.findFirst({
      where: { entityId: entity.id, code: a.code },
    });
    if (!existing) {
      await prisma.account.create({
        data: {
          tenantId: tenantId,
          entityId: entity.id,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
        },
      });
    }
  }
  const calendar = await prisma.fiscalCalendar.upsert({
    where: { entityId_code: { entityId: entity.id, code: "TEST-CAL-2026" } },
    create: {
      tenantId: tenantId,
      entityId: entity.id,
      code: "TEST-CAL-2026",
      name: "Test Calendar 2026",
      periodFrequency: "MONTHLY",
    },
    update: {},
  });
  await prisma.period.upsert({
    where: { calendarId_code: { calendarId: calendar.id, code: "2026-05" } },
    create: {
      tenantId: tenantId,
      calendarId: calendar.id,
      code: "2026-05",
      ordinal: 5,
      startsOn: new Date("2026-05-01"),
      endsOn: new Date("2026-05-31"),
    },
    update: {},
  });
  // Admin user (matches the allowlist in current-user.ts).
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      email: ADMIN_EMAIL,
      displayName: "Carla Controller",
      isActive: true,
    },
    update: { isActive: true },
  });
  adminUserId = admin.id;
}

function setAdminCookie() {
  mockCookieStore.set(authInternal.cookieName, {
    value: authInternal.encode(adminUserId),
  });
}

function setCookie(name: string, value: string) {
  mockCookieStore.set(name, { value });
}

async function postSampleEntry(bookCode: string) {
  return postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode,
    currencyCode: "USD",
    documentDate: new Date("2026-05-15"),
    memo: "Test post during period",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 100 },
      { accountCode: "4000", credit: 100 },
    ],
  });
}

describe("closePeriodAction + reopenPeriodAction", () => {
  it("close creates a PeriodClose row and stamps closedBy with the admin email", async () => {
    setAdminCookie();
    const result = await closePeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });
    expect(result.ok).toBe(true);
    expect(result.wasAlreadyClosed).toBe(false);
    expect(result.closedBy).toBe(ADMIN_EMAIL);

    const close = await prisma.periodClose.findFirst({
      where: { entity: { code: ENTITY_CODE }, book: { code: BOOK_GAAP } },
      select: { closedBy: true },
    });
    expect(close?.closedBy).toBe(ADMIN_EMAIL);
  });

  it("after close, postJournalEntry rejects writes to the closed (entity, book, period)", async () => {
    setAdminCookie();
    await closePeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });
    await expect(postSampleEntry(BOOK_GAAP)).rejects.toBeInstanceOf(PeriodClosedError);
  });

  it("idempotent close — second call returns wasAlreadyClosed=true and preserves original closedAt", async () => {
    setAdminCookie();
    const r1 = await closePeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });
    expect(r1.wasAlreadyClosed).toBe(false);
    const t1 = r1.closedAt;
    const r2 = await closePeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });
    expect(r2.ok).toBe(true);
    expect(r2.wasAlreadyClosed).toBe(true);
    expect(r2.closedAt).toBe(t1);
  });

  it("reopen removes the row and unblocks posting", async () => {
    setAdminCookie();
    await closePeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });
    await expect(postSampleEntry(BOOK_GAAP)).rejects.toBeInstanceOf(PeriodClosedError);

    const reopen = await reopenPeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });
    expect(reopen.ok).toBe(true);
    expect(reopen.wasAlreadyOpen).toBe(false);

    const posted = await postSampleEntry(BOOK_GAAP);
    expect(posted.entryNumber).toBeTruthy();
  });

  it("idempotent reopen — calling on an already-open period returns wasAlreadyOpen=true", async () => {
    setAdminCookie();
    const r = await reopenPeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });
    expect(r.ok).toBe(true);
    expect(r.wasAlreadyOpen).toBe(true);
  });

  it("per-book independence: closing US_GAAP does NOT close US_TAX", async () => {
    setAdminCookie();
    await closePeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });

    await expect(postSampleEntry(BOOK_GAAP)).rejects.toBeInstanceOf(PeriodClosedError);
    const taxEntry = await postSampleEntry(BOOK_TAX);
    expect(taxEntry.entryNumber).toBeTruthy();
  });

  it("non-admin user gets denied", async () => {
    // Create a non-admin user + cookie
    const nonAdmin = await prisma.user.upsert({
      where: { email: "regular@test.local" },
      create: { email: "regular@test.local", displayName: "Regular User", isActive: true },
      update: { isActive: true },
    });
    setCookie(authInternal.cookieName, authInternal.encode(nonAdmin.id));
    const r = await closePeriodAction({
      entityCode: ENTITY_CODE,
      bookCode: BOOK_GAAP,
      periodCode: "2026-05",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/admin/i);
  });
});
