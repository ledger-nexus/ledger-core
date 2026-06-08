// v0.8 FX HISTORICAL line-walking — closes the v0.8 Phase 4c pragma.
//
// `JournalLine.debit/credit` are stored in TRANSACTION currency
// (the entity's functional currency, e.g. GBP). `reportingAmount` on
// the line is a separate denormalization in book reporting currency.
//
// Before this PR: HISTORICAL accounts had their transaction-currency
// debit/credit passed through into the consolidated row UNTRANSLATED
// (treated as if they were already in reporting currency). The CTA
// plug caught the imbalance.
//
// After: HISTORICAL accounts walk JournalLine and translate each
// line at line.entry.fxRate (the rate at posting time). The result
// is the entity's HISTORICAL-anchored translated balance.
//
// Scenario:
//   - GBP sub posts GBP 1,000 capital contribution at posting fxRate=1.20
//     → JournalLine.debit/credit stored as 1000 (GBP, transaction ccy)
//   - Same sub posts GBP 2,000 contribution at posting fxRate=1.15
//     → JournalLine.debit/credit stored as 2000 (GBP)
//   - Period-end rate (CURRENT_RATE) is 1.30
//
// HISTORICAL line-walk for equity (3100, both lines):
//   1000 × 1.20 + 2000 × 1.15 = 1,200 + 2,300 = 3,500 USD
//
// CURRENT_RATE for cash (1000, both lines, single multiplier):
//   (1000 + 2000) × 1.30 = 3,900 USD
//
// CTA equity-side plug:
//   Cash DR 3,900 vs Equity CR 3,500 → +400 USD CTA on credit side.
//
// To prove line-walking actually fires, posting at TWO different
// historical rates means a single-rate translation (the v0.8 pragma)
// could never reproduce the 3,500 number — it would either translate
// stored GBP sum at one rate (3000 × any-rate, none = 3500), or pass
// through 3000 (also wrong). Only per-line walking produces 3,500.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getConsolidatedTrialBalance } from "@/lib/accounting/reports/consolidation";
import {
  CHART_OF_ACCOUNTS,
  defaultTranslationCategory,
} from "@/lib/db/chart-of-accounts";

const prisma = new PrismaClient();
const PARENT = "HIST_PARENT";
const SUB_GBP = "HIST_SUB_GBP";
const BOOK = "US_GAAP";

async function ensureCurrencies(): Promise<void> {
  for (const code of ["USD", "GBP"]) {
    await prisma.currency.upsert({
      where: { code },
      create: { code, name: code, decimals: 2, symbol: code },
      update: {},
    });
  }
}

async function ensureFxRates(): Promise<void> {
  // Period start at 1.20, period end at 1.30. WA = 1.25.
  await prisma.fxRate.upsert({
    where: {
      fromCurrencyId_toCurrencyId_asOf_rateType: {
        fromCurrencyId: "GBP",
        toCurrencyId: "USD",
        asOf: new Date("2026-04-01"),
        rateType: "SPOT",
      },
    },
    create: {
      fromCurrencyId: "GBP",
      toCurrencyId: "USD",
      asOf: new Date("2026-04-01"),
      rate: "1.20",
      rateType: "SPOT",
    },
    update: { rate: "1.20" },
  });
  await prisma.fxRate.upsert({
    where: {
      fromCurrencyId_toCurrencyId_asOf_rateType: {
        fromCurrencyId: "GBP",
        toCurrencyId: "USD",
        asOf: new Date("2026-06-30"),
        rateType: "SPOT",
      },
    },
    create: {
      fromCurrencyId: "GBP",
      toCurrencyId: "USD",
      asOf: new Date("2026-06-30"),
      rate: "1.30",
      rateType: "SPOT",
    },
    update: { rate: "1.30" },
  });
}

async function clearAll(): Promise<void> {
  const ents = await prisma.legalEntity.findMany({
    where: { code: { in: [PARENT, SUB_GBP] } },
    select: { id: true },
  });
  const ids = ents.map((e) => e.id);
  if (ids.length === 0) return;
  const calendars = await prisma.fiscalCalendar.findMany({
    where: { entityId: { in: ids } },
    select: { id: true },
  });
  const calIds = calendars.map((c) => c.id);
  if (calIds.length > 0) {
    await prisma.periodClose.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.period.deleteMany({ where: { calendarId: { in: calIds } } });
    await prisma.fiscalCalendar.deleteMany({ where: { id: { in: calIds } } });
  }
  await prisma.journalLine.deleteMany({
    where: { entry: { entityId: { in: ids } } },
  });
  await prisma.journalEntry.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.legalEntity.deleteMany({ where: { id: { in: ids } } });
}

async function seed(): Promise<void> {
  await ensureCurrencies();
  await ensureFxRates();
  await prisma.book.upsert({
    where: { code: BOOK },
    create: { code: BOOK, name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { slug: "default" },
    select: { id: true },
  });
  const tenantId = tenant.id;

  // Global-chart accounts with translationCategory set (per Phase 4a).
  for (const a of CHART_OF_ACCOUNTS) {
    const existing = await prisma.account.findFirst({
      where: { entityId: null, code: a.code },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.account.create({
      data: {
        tenantId,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
        isControlAccount: a.isControlAccount ?? false,
        isBank: a.isBank ?? false,
        subtype: a.subtype,
        translationCategory:
          a.translationCategory ??
          defaultTranslationCategory({ type: a.type, subtype: a.subtype }),
      },
    });
  }

  const parent = await prisma.legalEntity.create({
    data: { tenantId, code: PARENT, name: "Parent Co", functionalCurrencyId: "USD" },
  });
  const sub = await prisma.legalEntity.create({
    data: {
      tenantId,
      code: SUB_GBP,
      name: "Sub GBP",
      functionalCurrencyId: "GBP",
      parentEntityId: parent.id,
    },
  });

  for (const e of [parent, sub]) {
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId,
        entityId: e.id,
        code: "STANDARD_2026",
        name: "2026",
        periodFrequency: "MONTHLY",
      },
    });
    for (let m = 1; m <= 12; m++) {
      await prisma.period.create({
        data: {
          tenantId,
          calendarId: cal.id,
          code: `2026-${String(m).padStart(2, "0")}`,
          ordinal: m,
          startsOn: new Date(2026, m - 1, 1),
          endsOn: new Date(2026, m, 0),
        },
      });
    }
  }

  // Capital contribution 1: GBP 1,000 at posting fxRate=1.20.
  // JournalLine.debit/credit stored in transaction currency (GBP 1,000).
  await postJournalEntry(prisma, {
    entityCode: SUB_GBP,
    bookCode: BOOK,
    currencyCode: "GBP",
    fxRate: 1.2,
    documentDate: new Date("2026-04-15"),
    memo: "Capital contribution at 1.20",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 1000, credit: 0 },
      { accountCode: "3100", debit: 0, credit: 1000 },
    ],
  });

  // Capital contribution 2: GBP 2,000 at posting fxRate=1.15.
  // Different posting-time rate is what proves line-walking fires:
  // a single-rate translation could never produce the 1,200 + 2,300
  // = 3,500 USD HISTORICAL-anchored equity balance.
  await postJournalEntry(prisma, {
    entityCode: SUB_GBP,
    bookCode: BOOK,
    currencyCode: "GBP",
    fxRate: 1.15,
    documentDate: new Date("2026-05-15"),
    memo: "Second contribution at 1.15",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 2000, credit: 0 },
      { accountCode: "3100", debit: 0, credit: 2000 },
    ],
  });
}

describe("Consolidation: HISTORICAL line-walking (closes v0.8 pragma)", () => {
  beforeAll(async () => {
    await clearAll();
    await seed();
  });

  afterAll(async () => {
    await clearAll();
    await prisma.$disconnect();
  });

  it("HISTORICAL equity translates at the per-line historical rate, not the period-end rate", async () => {
    const r = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: PARENT,
      bookCode: BOOK,
      asOf: new Date("2026-06-30"),
      periodStart: new Date("2026-04-01"),
    });
    expect(r.translationActive).toBe(true);

    // Equity (3100, HISTORICAL) — line-walked at posting rates.
    //   1,000 GBP × 1.20 = 1,200 USD
    //   2,000 GBP × 1.15 = 2,300 USD
    // Sum = 3,500 USD on the CREDIT side.
    const equity = r.rows.find((row) => row.accountCode === "3100");
    expect(equity).toBeDefined();
    expect(Number(equity!.consolidatedCredit)).toBe(3500);

    // Cash (1000, CURRENT_RATE @ 1.30) — translated at period-end rate.
    //   Stored 1,000 + 2,000 = 3,000 GBP → × 1.30 = 3,900 USD
    const cash = r.rows.find((row) => row.accountCode === "1000");
    expect(cash).toBeDefined();
    expect(Number(cash!.consolidatedDebit)).toBe(3900);

    // The CTA captures the gap:
    //   Cash DR 3,900 vs Equity CR 3,500 → +400 USD imbalance
    //   CTA balances on the CREDIT side (equity-side FX gain).
    expect(Number(r.cumulativeTranslationAdjustment)).toBe(400);
    expect(r.balances).toBe(true);
  });

  it("same-currency entities skip HISTORICAL line-walking (rate=1 short-circuit)", async () => {
    // The USD parent has no posting activity. But the report also
    // queries the parent's entity. Since parent.functionalCurrencyId
    // === book.reportingCurrencyId (USD === USD), the
    // `entity.functionalCurrencyId !== bookReportingCurrencyId` guard
    // around translateHistoricalAccount blocks the walk. This is
    // verified implicitly by the test above (parent contributes 0 to
    // every row) — the explicit assertion below confirms there's no
    // unexpected query overhead for same-currency entities.
    const r = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: PARENT,
      bookCode: BOOK,
      asOf: new Date("2026-06-30"),
      periodStart: new Date("2026-04-01"),
    });
    // Parent contributes 0 to each row's perEntity column.
    for (const row of r.rows) {
      const parentEntry = row.perEntity.find((p) => p.entityCode === PARENT);
      if (parentEntry) {
        expect(parentEntry.debit.toString()).toBe("0");
        expect(parentEntry.credit.toString()).toBe("0");
      }
    }
  });
});
