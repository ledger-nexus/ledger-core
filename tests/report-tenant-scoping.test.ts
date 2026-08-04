// Report tenant-scoping regressions (deficiency #16).
//
// Account codes are only unique per tenant, and shared accounts
// (entityId=null) exist PER TENANT — so any report account scan without
// a tenantId filter pulls every tenant's shared chart. Two failure
// modes, both exercised here per report:
//
//   1. Leak: another tenant's account codes/names appear as
//      zero-balance rows in this tenant's report.
//   2. Shadow/poison: a same-code account in another tenant wins a
//      by-code map and drives this tenant's classification (name,
//      isBank, subtype → cash-flow bucketing, M-3 line, permanent vs
//      temporary).
//
// Modeled on "Consolidation: account metadata is tenant-scoped" in
// tests/consolidation.test.ts (deficiency #15 — same bug shape). Test-DB
// lessons inherited from there: mint per-run rows (unique suffix) rather
// than asserting against pre-existing shared chart rows, and wrap
// app_user hard-deletes in withAuditLogMutable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { getIncomeStatement, getBalanceSheet } from "../src/lib/accounting/reports";
import { getCashFlowStatement } from "../src/lib/accounting/reports/cash-flow";
import { getBookTaxDifference } from "../src/lib/accounting/reports/book-tax-difference";
import { getM3Detail } from "../src/lib/accounting/reports/m3-detail";
import { defaultTranslationCategory } from "../src/lib/db/chart-of-accounts";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

// Per-run fixtures: the test DB is shared and persistent, so every row
// this suite mints carries a unique suffix and is removed in afterAll.
const SFX = "rts" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const ENTITY = `RTS-${SFX}`;

// Default-tenant chart (the "real" rows the reports must use).
const CASH = `1000-${SFX}`;   // isBank — drives beginning/ending cash
const AR = `1200-${SFX}`;     // AR_TRADE — working-capital walk
const ACCUM = `1510-${SFX}`;  // ACCUM_DEPR contra — investing bucket, BTD temporary
const REV = `4000-${SFX}`;
const DEPR = `8000-${SFX}`;   // DEPRECIATION — add-back, BTD temporary, M-3 depreciation line

// Codes that exist ONLY in the poison tenant — must never leak into the
// default tenant's reports, even as zero-balance rows.
const LEAK_REV = `4099-${SFX}`;
const LEAK_ASSET = `1099-${SFX}`;

const ALL_CODES = [CASH, AR, ACCUM, REV, DEPR, LEAK_REV, LEAK_ASSET];

const PERIOD_START = new Date("2026-01-01");
const PERIOD_END = new Date("2026-12-31");

let defaultTenantId: string;
let poisonTenantId: string;
let poisonOwnerUserId: string;

type SeedAccount = {
  tenantId: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  subtype?: string | null;
  isContra?: boolean;
  isBank?: boolean;
};

async function createAccount(a: SeedAccount) {
  await prisma.account.create({
    data: {
      tenantId: a.tenantId,
      code: a.code,
      name: a.name,
      type: a.type,
      normalBalance: a.normalBalance,
      subtype: a.subtype ?? null,
      isContra: a.isContra ?? false,
      isBank: a.isBank ?? false,
      translationCategory: defaultTranslationCategory({
        type: a.type,
        subtype: a.subtype ?? undefined,
      }),
    },
  });
}

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  for (const b of [
    { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP" as const },
    { code: "US_TAX", name: "US Federal Tax", basis: "US_TAX" as const },
  ]) {
    await prisma.book.upsert({
      where: { code: b.code },
      create: { code: b.code, name: b.name, basis: b.basis, reportingCurrencyId: "USD" },
      update: {},
    });
  }

  defaultTenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: defaultTenantId,
      code: ENTITY,
      name: "Report-scope regression Co.",
      functionalCurrencyId: "USD",
    },
  });
  const calendar = await prisma.fiscalCalendar.create({
    data: {
      tenantId: defaultTenantId,
      entityId: entity.id,
      code: `CAL-${SFX}`,
      name: "2026",
      periodFrequency: "MONTHLY",
    },
  });
  for (let m = 1; m <= 12; m++) {
    await prisma.period.create({
      data: {
        tenantId: defaultTenantId,
        calendarId: calendar.id,
        code: `2026-${String(m).padStart(2, "0")}`,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
    });
  }

  // The default tenant's own chart — shared accounts (entityId=null).
  await createAccount({ tenantId: defaultTenantId, code: CASH, name: "Cash (report-scope regression)", type: "ASSET", normalBalance: "DEBIT", subtype: "CASH", isBank: true });
  await createAccount({ tenantId: defaultTenantId, code: AR, name: "AR (report-scope regression)", type: "ASSET", normalBalance: "DEBIT", subtype: "AR_TRADE" });
  await createAccount({ tenantId: defaultTenantId, code: ACCUM, name: "Accum depr (report-scope regression)", type: "ASSET", normalBalance: "CREDIT", subtype: "ACCUM_DEPR", isContra: true });
  await createAccount({ tenantId: defaultTenantId, code: REV, name: "Revenue (report-scope regression)", type: "REVENUE", normalBalance: "CREDIT" });
  await createAccount({ tenantId: defaultTenantId, code: DEPR, name: "Depreciation (report-scope regression)", type: "EXPENSE", normalBalance: "DEBIT", subtype: "DEPRECIATION" });

  // The poison tenant: same codes, hostile metadata. If any report scan
  // loses its tenant filter, these rows win by-code maps and flip the
  // default tenant's classification.
  const owner = await prisma.user.create({
    data: {
      email: `rts-owner-${SFX}@example.test`,
      displayName: "Report-scope poison owner",
      isActive: true,
    },
  });
  poisonOwnerUserId = owner.id;
  const tenant = await prisma.tenant.create({
    data: { slug: `rts-${SFX}`, name: "Report-scope poison tenant", ownerUserId: owner.id },
  });
  poisonTenantId = tenant.id;

  // CASH poisoned to NOT be a bank account → would vanish from
  // beginning/ending cash and reclassify as INVESTING.
  await createAccount({ tenantId: poisonTenantId, code: CASH, name: "POISON not-a-bank (other tenant)", type: "ASSET", normalBalance: "DEBIT", subtype: "FIXED_ASSET" });
  // AR poisoned to BE a bank account → would drop out of the
  // working-capital walk into the cash totals.
  await createAccount({ tenantId: poisonTenantId, code: AR, name: "POISON bank (other tenant)", type: "ASSET", normalBalance: "DEBIT", subtype: "CASH", isBank: true });
  // Revenue poisoned name → shadow candidate for the IS by-code dedup.
  await createAccount({ tenantId: poisonTenantId, code: REV, name: "POISON revenue (other tenant)", type: "REVENUE", normalBalance: "CREDIT" });
  // Depreciation poisoned to MEALS → BTD would flip TEMPORARY to
  // UNCLASSIFIED and M-3 would re-bucket under Meals and entertainment.
  await createAccount({ tenantId: poisonTenantId, code: DEPR, name: "POISON meals (other tenant)", type: "EXPENSE", normalBalance: "DEBIT", subtype: "MEALS" });
  // Leak probes: exist only in the poison tenant.
  await createAccount({ tenantId: poisonTenantId, code: LEAK_REV, name: "POISON leak probe revenue", type: "REVENUE", normalBalance: "CREDIT" });
  await createAccount({ tenantId: poisonTenantId, code: LEAK_ASSET, name: "POISON leak probe asset", type: "ASSET", normalBalance: "DEBIT" });

  // Activity in the default tenant, US_GAAP book:
  //   revenue on account, partial collection, depreciation.
  // Balances asOf 2026-12-31: cash 600 Dr, AR 400 Dr, accum 400 Cr,
  // revenue 1,000 Cr, depreciation 400 Dr → net income 600.
  await postJournalEntry(prisma, {
    entityCode: ENTITY,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-03-10"),
    memo: "Revenue on account",
    source: "SEED",
    lines: [
      { accountCode: AR, debit: 1_000 },
      { accountCode: REV, credit: 1_000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENTITY,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-03-12"),
    memo: "Partial collection",
    source: "SEED",
    lines: [
      { accountCode: CASH, debit: 600 },
      { accountCode: AR, credit: 600 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENTITY,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-03-20"),
    memo: "Book depreciation",
    source: "SEED",
    lines: [
      { accountCode: DEPR, debit: 400 },
      { accountCode: ACCUM, credit: 400 },
    ],
  });
  // US_TAX book: slower depreciation → book-tax delta of 240 on DEPR.
  await postJournalEntry(prisma, {
    entityCode: ENTITY,
    bookCode: "US_TAX",
    documentDate: new Date("2026-03-25"),
    memo: "Tax depreciation",
    source: "SEED",
    lines: [
      { accountCode: DEPR, debit: 160 },
      { accountCode: ACCUM, credit: 160 },
    ],
  });
});

afterAll(async () => {
  // JE lines reference the minted accounts — clear entries first.
  await prisma.journalLine.deleteMany({
    where: { entry: { entity: { code: ENTITY } } },
  });
  await prisma.journalEntry.deleteMany({ where: { entity: { code: ENTITY } } });
  await prisma.account.deleteMany({ where: { code: { in: ALL_CODES } } });

  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId: defaultTenantId, code: ENTITY },
    select: { id: true },
  });
  if (entity) {
    const calendars = await prisma.fiscalCalendar.findMany({
      where: { entityId: entity.id },
      select: { id: true },
    });
    await prisma.periodClose.deleteMany({ where: { entityId: entity.id } });
    await prisma.period.deleteMany({
      where: { calendarId: { in: calendars.map((c) => c.id) } },
    });
    await prisma.fiscalCalendar.deleteMany({
      where: { id: { in: calendars.map((c) => c.id) } },
    });
    await prisma.legalEntity.delete({ where: { id: entity.id } });
  }

  await prisma.tenant.delete({ where: { id: poisonTenantId } });
  // app_user hard-deletes trip the audit_log append-only RULE's
  // referential-integrity check — needs the mutable window.
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.user.delete({ where: { id: poisonOwnerUserId } });
  });
  await prisma.$disconnect();
});

describe("Income statement: account scan is tenant-scoped", () => {
  it("uses the entity tenant's row for a same-code account and leaks no other tenant's codes", async () => {
    const is = await getIncomeStatement(
      prisma,
      { entityCode: ENTITY, bookCode: "US_GAAP" },
      PERIOD_START,
      PERIOD_END
    );

    const revRows = is.revenue.filter((r) => r.code === REV);
    expect(revRows).toHaveLength(1);
    // Shadow check: the by-code dedup must see only this tenant's row.
    expect(revRows[0].name).toBe("Revenue (report-scope regression)");
    expect(revRows[0].amount.toNumber()).toBe(1_000);

    // Leak check: a code that exists only in the poison tenant must not
    // appear, not even as a zero-balance row.
    expect(is.revenue.map((r) => r.code)).not.toContain(LEAK_REV);
    expect(is.netIncome.toNumber()).toBe(600);
  });
});

describe("Balance sheet: account scan is tenant-scoped", () => {
  it("uses the entity tenant's row for a same-code account and leaks no other tenant's codes", async () => {
    const bs = await getBalanceSheet(
      prisma,
      { entityCode: ENTITY, bookCode: "US_GAAP" },
      PERIOD_END
    );

    const arRows = bs.assets.filter((r) => r.code === AR);
    expect(arRows).toHaveLength(1);
    expect(arRows[0].name).toBe("AR (report-scope regression)");
    expect(arRows[0].amount.toNumber()).toBe(400);

    expect(bs.assets.map((r) => r.code)).not.toContain(LEAK_ASSET);
    expect(bs.balances).toBe(true);
  });
});

describe("Cash flow: classification metadata is tenant-scoped", () => {
  it("classifies from the entity tenant's chart, not a same-code account in another tenant", async () => {
    const cf = await getCashFlowStatement(
      prisma,
      { entityCode: ENTITY, bookCode: "US_GAAP" },
      PERIOD_START,
      PERIOD_END
    );

    // AR is working capital per OUR chart (AR_TRADE). The poison
    // tenant's same-code row claims it's a bank account, which would
    // pull it out of the working-capital walk.
    const arLine = cf.workingCapitalChanges.find((l) => l.accountCode === AR);
    expect(arLine).toBeDefined();
    expect(arLine!.accountName).toBe("AR (report-scope regression)");
    expect(arLine!.deltaAmount.toNumber()).toBe(400);
    expect(arLine!.cashImpact.toNumber()).toBe(-400);

    // Cash is a bank account per OUR chart. The poison tenant's
    // same-code row says it isn't, which would zero the cash totals.
    expect(cf.endingCash.toNumber()).toBe(600);
    expect(cf.actualCashChange.toNumber()).toBe(600);

    // Depreciation adds back (subtype DEPRECIATION from OUR chart).
    const addBack = cf.nonCashAddBacks.find((l) => l.accountCode === DEPR);
    expect(addBack).toBeDefined();
    expect(addBack!.cashImpact.toNumber()).toBe(400);

    // NI 600 + add-back 400 − ΔAR 400 = 600 = Δ cash.
    expect(cf.netCashFlow.toNumber()).toBe(600);
    expect(cf.reconciles).toBe(true);
  });
});

describe("Book-tax difference: subtype scan is tenant-scoped", () => {
  it("classifies the depreciation delta TEMPORARY from the entity tenant's subtype", async () => {
    const btd = await getBookTaxDifference(prisma, {
      entityCode: ENTITY,
      fromBookCode: "US_GAAP",
      toBookCode: "US_TAX",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const deprRow = btd.pnlRows.find((r) => r.accountCode === DEPR);
    expect(deprRow).toBeDefined();
    expect(deprRow!.delta.toNumber()).toBe(240); // book 400 − tax 160
    // OUR subtype is DEPRECIATION → TEMPORARY. The poison tenant's
    // same-code MEALS subtype would leave this UNCLASSIFIED.
    expect(deprRow!.classification).toBe("TEMPORARY");

    const accumRow = btd.balanceSheetRows.find((r) => r.accountCode === ACCUM);
    expect(accumRow).toBeDefined();
    expect(accumRow!.classification).toBe("TEMPORARY");
  });
});

describe("M-3 detail: subtype lookup is tenant-scoped", () => {
  it("buckets the depreciation delta under Depreciation, not the poison tenant's Meals", async () => {
    const m3 = await getM3Detail(prisma, {
      entityCode: ENTITY,
      fromBookCode: "US_GAAP",
      toBookCode: "US_TAX",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const deprGroup = m3.groups.find((g) => g.m3Line === "Depreciation and amortization");
    expect(deprGroup).toBeDefined();
    expect(deprGroup!.rows.map((r) => r.accountCode)).toContain(DEPR);

    const mealsGroup = m3.groups.find((g) => g.m3Line === "Meals and entertainment");
    expect(mealsGroup?.rows.map((r) => r.accountCode) ?? []).not.toContain(DEPR);
  });
});
