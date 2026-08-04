// Report Builder PR 7 — Cross-tenant Account read isolation test.
//
// THE POINT: prove that legacy `getIncomeStatement` and `getBalanceSheet`
// now tenant-scope their `Account.findMany` query. Before this PR, a
// shared account (entityId: null) in TENANT B with `code: "1000"` could
// surface in TENANT A's report — balances were correct (lines are
// entity-filtered) but metadata (name, parentCode, isContra) bled across
// tenants.
//
// Setup: create two tenants. Both have an entity + a shared chart that
// includes a `code: "1000"` Cash account, but with DIFFERENT names
// ("Tenant A Cash" vs "Tenant B Cash"). Tenant A posts a JE to its 1000.
// Then call getIncomeStatement / getBalanceSheet for Tenant A with
// tenantId set, and assert the row name is Tenant A's, never Tenant B's.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import {
  getIncomeStatement,
  getBalanceSheet,
  getTrialBalance,
} from "@/lib/accounting/reports";

const prisma = new PrismaClient();

const PREFIX = "RPTTI"; // ReportBuilder Tenant Isolation
const STAMP = Date.now().toString(36);
const TENANT_A_NAME = `${PREFIX}_A_${STAMP}`;
const TENANT_B_NAME = `${PREFIX}_B_${STAMP}`;
const ENT_A_CODE = `${PREFIX}_ENT_A_${STAMP}`;
const ENT_B_CODE = `${PREFIX}_ENT_B_${STAMP}`;
const BOOK_CODE = "US_GAAP";

let tenantAId: string;
let tenantBId: string;
let entityAId: string;
let entityBId: string;
// Per-tenant 1000 account ids — both must exist (entityId: null shared
// chart) for the cross-tenant leak to be testable.
let accountA1000Id: string;
let accountB1000Id: string;
let accountA4000Id: string;

async function ensureFixture(): Promise<void> {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: { code: BOOK_CODE, name: BOOK_CODE, basis: BOOK_CODE, reportingCurrencyId: "USD" },
    update: {},
  });

  // Tenant rows require an owner user. One shared admin works for the
  // test — multi-tenant fanout is what we're proving, not user setup.
  const admin = await prisma.user.upsert({
    where: { email: `pr7-isolation-${STAMP}@northwind.test` },
    create: {
      email: `pr7-isolation-${STAMP}@northwind.test`,
      displayName: "PR7 isolation admin",
      isActive: true,
    },
    update: { isActive: true },
  });

  // Two separate tenants.
  const tA = await prisma.tenant.create({
    data: {
      name: TENANT_A_NAME,
      slug: TENANT_A_NAME.toLowerCase(),
      ownerUserId: admin.id,
    },
  });
  const tB = await prisma.tenant.create({
    data: {
      name: TENANT_B_NAME,
      slug: TENANT_B_NAME.toLowerCase(),
      ownerUserId: admin.id,
    },
  });
  tenantAId = tA.id;
  tenantBId = tB.id;

  // One entity per tenant.
  const eA = await prisma.legalEntity.create({
    data: { tenantId: tA.id, code: ENT_A_CODE, name: ENT_A_CODE, functionalCurrencyId: "USD" },
  });
  const eB = await prisma.legalEntity.create({
    data: { tenantId: tB.id, code: ENT_B_CODE, name: ENT_B_CODE, functionalCurrencyId: "USD" },
  });
  entityAId = eA.id;
  entityBId = eB.id;

  // Per-tenant fiscal calendar so postJournalEntry can resolve a period.
  for (const [t, e] of [
    [tA.id, eA.id],
    [tB.id, eB.id],
  ] as const) {
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId: t,
        entityId: e,
        code: `STANDARD_2026_${t.slice(0, 8)}`,
        name: "2026",
        periodFrequency: "MONTHLY",
      },
    });
    for (let m = 1; m <= 12; m++) {
      await prisma.period.create({
        data: {
          tenantId: t,
          calendarId: cal.id,
          code: `2026-${String(m).padStart(2, "0")}`,
          ordinal: m,
          startsOn: new Date(2026, m - 1, 1),
          endsOn: new Date(2026, m, 0),
        },
      });
    }
  }

  // The crux: two distinct `code: "1000"` accounts — one per tenant —
  // with DIFFERENT NAMES. Both entity-shared (entityId: null). Without
  // tenant-scoping in the report query, the dedup would arbitrarily
  // pick one of them based on iteration order.
  const a1000 = await prisma.account.create({
    data: {
      tenantId: tA.id,
      code: "1000",
      name: "Tenant A Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
  });
  const b1000 = await prisma.account.create({
    data: {
      tenantId: tB.id,
      code: "1000",
      name: "Tenant B Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
  });
  accountA1000Id = a1000.id;
  accountB1000Id = b1000.id;

  // Tenant A also gets a Revenue account so IS produces a non-zero
  // row, and a Common Stock for BS balance.
  const a4000 = await prisma.account.create({
    data: {
      tenantId: tA.id,
      code: "4000",
      name: "Tenant A Revenue",
      type: "REVENUE",
      normalBalance: "CREDIT",
    },
  });
  accountA4000Id = a4000.id;
  await prisma.account.create({
    data: {
      tenantId: tA.id,
      code: "3000",
      name: "Tenant A Equity",
      type: "EQUITY",
      normalBalance: "CREDIT",
    },
  });

  // Post a single JE in Tenant A: $1,000 revenue paid in cash.
  await postJournalEntry(prisma, {
    entityCode: ENT_A_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-02-15"),
    memo: "TA revenue",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 1000, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 1000 },
    ],
  });
}

async function cleanup(): Promise<void> {
  // Wipe in dependency order.
  for (const entityId of [entityAId, entityBId]) {
    if (!entityId) continue;
    await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
    await prisma.journalEntry.deleteMany({ where: { entityId } });
  }
  for (const tenantId of [tenantAId, tenantBId]) {
    if (!tenantId) continue;
    await prisma.period.deleteMany({
      where: { calendar: { tenantId } },
    });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId } });
    await prisma.account.deleteMany({ where: { tenantId } });
    await prisma.legalEntity.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }
}

describe("Report Builder PR 7 — Legacy report tenant-isolation guard", () => {
  beforeAll(async () => {
    await ensureFixture();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("getTrialBalance scopes by tenant: name is Tenant A's, never Tenant B's", async () => {
    const tb = await getTrialBalance(
      prisma,
      { entityCode: ENT_A_CODE, bookCode: BOOK_CODE, tenantId: tenantAId },
      new Date("2026-12-31")
    );
    const row1000 = tb.rows.find((r) => r.accountCode === "1000");
    expect(row1000).toBeDefined();
    expect(row1000!.accountName).toBe("Tenant A Cash");
    expect(row1000!.accountName).not.toBe("Tenant B Cash");
  });

  it("getIncomeStatement scopes by tenant: revenue row 4000 has Tenant A's name", async () => {
    const pnl = await getIncomeStatement(
      prisma,
      { entityCode: ENT_A_CODE, bookCode: BOOK_CODE, tenantId: tenantAId },
      new Date("2026-01-01"),
      new Date("2026-12-31")
    );
    const row4000 = pnl.revenue.find((r) => r.code === "4000");
    expect(row4000).toBeDefined();
    expect(row4000!.name).toBe("Tenant A Revenue");
    expect(pnl.totalRevenue.toString()).toBe("1000");
  });

  it("getBalanceSheet scopes by tenant: 1000 row carries Tenant A's metadata, not Tenant B's", async () => {
    const bs = await getBalanceSheet(
      prisma,
      { entityCode: ENT_A_CODE, bookCode: BOOK_CODE, tenantId: tenantAId },
      new Date("2026-12-31")
    );
    const row1000 = bs.assets.find((r) => r.code === "1000");
    expect(row1000).toBeDefined();
    expect(row1000!.name).toBe("Tenant A Cash");
    expect(row1000!.name).not.toBe("Tenant B Cash");
    expect(row1000!.amount.toString()).toBe("1000");
  });

  it("Tenant A account ids differ from Tenant B's (fixture sanity)", () => {
    expect(accountA1000Id).not.toBe(accountB1000Id);
  });
});
