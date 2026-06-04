// Integration tests for the NetSuite bootstrap mappers against a
// real Postgres + Prisma.
//
// These tests skip if DATABASE_URL is unset (e.g., in environments
// without a test DB available). When DATABASE_URL is set, they assert
// the end-to-end behavior:
//   - importSubsidiaries creates LegalEntity + per-entity FiscalCalendar
//     + wires parent links in pass 2
//   - importAccountingBooks creates Book rows
//   - importAccountingPeriods creates Period rows under the right
//     FiscalCalendar
//   - All three are idempotent: re-running with the same input
//     produces zero new rows
//
// Unit-level tests for the pure mappers live in
// tests/netsuite-bootstrap-mappers.test.ts (no DB required).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import {
  importSubsidiaries,
  importAccountingBooks,
  importAccountingPeriods,
  nsSubsidiaryCode,
  nsBookCode,
  nsCalendarCode,
  type NsSubsidiaryBootstrap,
  type NsAccountingBookBootstrap,
  type NsAccountingPeriodBootstrap,
} from "../src/lib/mappers/netsuite/bootstrap";

const DB_AVAILABLE = !!process.env.DATABASE_URL;
const dbDescribe = DB_AVAILABLE ? describe : describe.skip;

// Test-scoped entity prefix to avoid colliding with other tests' data.
// Every row this suite creates uses ITEST-* prefixes so cleanup is precise.
// Uses the default tenant (per CLAUDE.md convention) so we don't need to
// fabricate ownerUserId. The bootstrap rows are namespaced by NSSUB-ITEST-N
// codes so they're isolated from other tests sharing the default tenant.
const TEST_SUB_PREFIX = "ITEST"; // ITEST-1, ITEST-2, ITEST-3
const TEST_BOOK_PREFIX = "ITESTBOOK";

const prisma = new PrismaClient();

const SUBSIDIARIES: NsSubsidiaryBootstrap[] = [
  {
    internalid: `${TEST_SUB_PREFIX}-1`,
    name: "Test Parent",
    legal_name: "Test Parent Inc.",
    country: "US",
    base_currency: "USD",
    functional_currency: "USD",
    fiscal_calendar: "Standard 2026",
    is_elimination: false,
    is_inactive: false,
    consolidation_method: "full",
    accounting_standard: "US_GAAP",
  },
  {
    internalid: `${TEST_SUB_PREFIX}-2`,
    name: "Test Sub A",
    base_currency: "USD",
    fiscal_calendar: "Standard 2026",
    parent_subsidiary_id: `${TEST_SUB_PREFIX}-1`,
    is_elimination: false,
    is_inactive: false,
    consolidation_method: "full",
  },
  {
    internalid: `${TEST_SUB_PREFIX}-3`,
    name: "Test Elimination Entity",
    base_currency: "USD",
    fiscal_calendar: "Standard 2026",
    parent_subsidiary_id: `${TEST_SUB_PREFIX}-1`,
    is_elimination: true,
    is_inactive: false,
  },
];

const BOOKS: NsAccountingBookBootstrap[] = [
  {
    internalid: `${TEST_BOOK_PREFIX}-1`,
    name: "Test US GAAP",
    base_currency: "USD",
    accounting_standard: "US_GAAP",
    is_inactive: false,
  },
  {
    internalid: `${TEST_BOOK_PREFIX}-2`,
    name: "Test IFRS",
    base_currency: "USD",
    accounting_standard: "IFRS",
    is_inactive: false,
  },
];

const PERIODS: NsAccountingPeriodBootstrap[] = Array.from(
  { length: 12 },
  (_, i) => ({
    internalid: `ITESTP-${i + 1}`,
    name: `Test Month ${i + 1}`,
    start_date: `2026-${String(i + 1).padStart(2, "0")}-01`,
    end_date: `2026-${String(i + 1).padStart(2, "0")}-28`,
    fiscal_year: 2026,
    month: i + 1,
    status: i < 6 ? ("closed" as const) : ("open" as const),
  })
);

let testTenantId: string;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;

  // Reuse the default tenant rather than creating one (Tenant requires
  // ownerUserId which would force a User-bootstrap chain). Our test
  // rows are namespaced under NSSUB-ITEST-N codes for isolation from
  // any other rows that share the tenant.
  testTenantId = await getDefaultTenantId(prisma);

  // USD currency assumed to be seeded already (ISO 4217 default).
  const usd = await prisma.currency.findUnique({
    where: { code: "USD" },
    select: { code: true },
  });
  if (!usd) {
    throw new Error(
      "USD currency row not found in DB. Run `pnpm db:seed` first."
    );
  }

  // Clean any leftover rows from a prior run.
  await cleanup();
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup() {
  if (!testTenantId) return;

  // Scope cleanup to NSSUB-ITEST-* code prefix so we don't disturb
  // other tests sharing the default tenant.
  const testEntities = await prisma.legalEntity.findMany({
    where: {
      tenantId: testTenantId,
      code: { startsWith: `NSSUB-${TEST_SUB_PREFIX}` },
    },
    select: { id: true },
  });
  const testEntityIds = testEntities.map((e) => e.id);

  // Order: child rows first.
  if (testEntityIds.length > 0) {
    const cals = await prisma.fiscalCalendar.findMany({
      where: { entityId: { in: testEntityIds } },
      select: { id: true },
    });
    const calIds = cals.map((c) => c.id);

    if (calIds.length > 0) {
      await prisma.period.deleteMany({
        where: { calendarId: { in: calIds } },
      });
    }
    await prisma.fiscalCalendar.deleteMany({
      where: { entityId: { in: testEntityIds } },
    });
  }

  await prisma.book.deleteMany({
    where: { code: { startsWith: `NSBOOK-${TEST_BOOK_PREFIX}` } },
  });
  await prisma.legalEntity.deleteMany({
    where: {
      tenantId: testTenantId,
      code: { startsWith: `NSSUB-${TEST_SUB_PREFIX}` },
    },
  });
}

dbDescribe("importSubsidiaries — real Postgres", () => {
  it("creates one LegalEntity per subsidiary", async () => {
    const r = await importSubsidiaries(prisma, testTenantId, SUBSIDIARIES);
    expect(r.errors).toEqual([]);
    expect(r.subsidiariesCreated).toBe(3);
    expect(r.subsidiariesSkipped).toBe(0);

    const entities = await prisma.legalEntity.findMany({
      where: {
        tenantId: testTenantId,
        sourceSystem: "NETSUITE",
      },
      orderBy: { sourceRecordId: "asc" },
    });
    expect(entities).toHaveLength(3);
    expect(entities[0]!.code).toBe(nsSubsidiaryCode(`${TEST_SUB_PREFIX}-1`));
    expect(entities[0]!.name).toBe("Test Parent Inc.");
  });

  it("creates per-entity FiscalCalendar rows", async () => {
    const calendars = await prisma.fiscalCalendar.findMany({
      where: { tenantId: testTenantId },
    });
    // 3 subsidiaries × 1 calendar each = 3 calendars
    expect(calendars).toHaveLength(3);
    const codes = calendars.map((c) => c.code).sort();
    expect(codes[0]!).toContain("CAL-STANDARD_2026");
  });

  it("wires parent_subsidiary_id links in pass 2", async () => {
    const sub2 = await prisma.legalEntity.findFirstOrThrow({
      where: {
        tenantId: testTenantId,
        sourceSystem: "NETSUITE",
        sourceRecordId: `${TEST_SUB_PREFIX}-2`,
      },
    });
    const parent = await prisma.legalEntity.findFirstOrThrow({
      where: {
        tenantId: testTenantId,
        sourceSystem: "NETSUITE",
        sourceRecordId: `${TEST_SUB_PREFIX}-1`,
      },
    });
    expect(sub2.parentEntityId).toBe(parent.id);
  });

  it("preserves is_elimination + consolidationMethod in extensions Json", async () => {
    const elimEntity = await prisma.legalEntity.findFirstOrThrow({
      where: {
        tenantId: testTenantId,
        sourceSystem: "NETSUITE",
        sourceRecordId: `${TEST_SUB_PREFIX}-3`,
      },
    });
    const ext = elimEntity.extensions as Record<string, unknown>;
    expect(ext.isElimination).toBe(true);
    expect(ext.consolidationMethod).toBe("FULL");
  });

  it("is idempotent — re-running produces zero new rows", async () => {
    const r = await importSubsidiaries(prisma, testTenantId, SUBSIDIARIES);
    expect(r.errors).toEqual([]);
    expect(r.subsidiariesCreated).toBe(0);
    expect(r.subsidiariesSkipped).toBe(3);
    expect(r.fiscalCalendarsCreated).toBe(0);

    const totalEntities = await prisma.legalEntity.count({
      where: { tenantId: testTenantId, sourceSystem: "NETSUITE" },
    });
    expect(totalEntities).toBe(3);
  });
});

dbDescribe("importAccountingBooks — real Postgres", () => {
  it("creates one Book per accounting_books row", async () => {
    const r = await importAccountingBooks(prisma, BOOKS);
    expect(r.errors).toEqual([]);
    expect(r.booksCreated).toBe(2);
    expect(r.booksSkipped).toBe(0);

    const books = await prisma.book.findMany({
      where: { code: { startsWith: "NSBOOK-ITESTBOOK" } },
      orderBy: { code: "asc" },
    });
    expect(books).toHaveLength(2);
    expect(books[0]!.code).toBe(nsBookCode(`${TEST_BOOK_PREFIX}-1`));
    expect(books[0]!.basis).toBe("US_GAAP");
    expect(books[1]!.basis).toBe("IFRS");
  });

  it("is idempotent", async () => {
    const r = await importAccountingBooks(prisma, BOOKS);
    expect(r.errors).toEqual([]);
    expect(r.booksCreated).toBe(0);
    expect(r.booksSkipped).toBe(2);
  });
});

dbDescribe("importAccountingPeriods — real Postgres", () => {
  const fiscalCalendarCode = nsCalendarCode(
    nsSubsidiaryCode(`${TEST_SUB_PREFIX}-1`),
    "Standard 2026"
  );

  it("creates one Period per monthly accounting_periods row", async () => {
    const r = await importAccountingPeriods(
      prisma,
      testTenantId,
      fiscalCalendarCode,
      PERIODS
    );
    expect(r.errors).toEqual([]);
    expect(r.periodsCreated).toBe(12);
    expect(r.periodsSkipped).toBe(0);

    const periods = await prisma.period.findMany({
      where: {
        tenantId: testTenantId,
        calendar: { code: fiscalCalendarCode },
      },
      orderBy: { ordinal: "asc" },
    });
    expect(periods).toHaveLength(12);
    expect(periods[0]!.code).toBe("2026-01");
    expect(periods[0]!.ordinal).toBe(1);
    expect(periods[11]!.code).toBe("2026-12");
    expect(periods[11]!.ordinal).toBe(12);
  });

  it("returns an error if the FiscalCalendar doesn't exist", async () => {
    const r = await importAccountingPeriods(
      prisma,
      testTenantId,
      "MISSING-CAL",
      PERIODS
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!).toMatch(/MISSING-CAL not found/);
    expect(r.periodsCreated).toBe(0);
  });

  it("is idempotent", async () => {
    const r = await importAccountingPeriods(
      prisma,
      testTenantId,
      fiscalCalendarCode,
      PERIODS
    );
    expect(r.errors).toEqual([]);
    expect(r.periodsCreated).toBe(0);
    expect(r.periodsSkipped).toBe(12);
  });
});

dbDescribe("end-to-end bootstrap pipeline", () => {
  it("can import the full Fleet-scale shape without errors", async () => {
    // This test asserts that the pipeline (subs → books → periods) runs
    // cleanly even with rows already created by the preceding tests
    // (everything should skip idempotently).
    const subsR = await importSubsidiaries(prisma, testTenantId, SUBSIDIARIES);
    expect(subsR.errors).toEqual([]);

    const booksR = await importAccountingBooks(prisma, BOOKS);
    expect(booksR.errors).toEqual([]);

    const periodsR = await importAccountingPeriods(
      prisma,
      testTenantId,
      nsCalendarCode(nsSubsidiaryCode(`${TEST_SUB_PREFIX}-1`), "Standard 2026"),
      PERIODS
    );
    expect(periodsR.errors).toEqual([]);

    // Total counts
    expect(subsR.subsidiariesCreated + subsR.subsidiariesSkipped).toBe(3);
    expect(booksR.booksCreated + booksR.booksSkipped).toBe(2);
    expect(periodsR.periodsCreated + periodsR.periodsSkipped).toBe(12);
  });
});
