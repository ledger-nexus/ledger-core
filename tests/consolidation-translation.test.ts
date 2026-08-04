// ASC 830 current-rate consolidation translation (Phase B) — the engine
// consumes per-line FUNCTIONAL amounts (#334), never stored reporting
// values. Pins, by name, both #151 failure modes:
//   - double-application: translated cash must be functional × CLOSE,
//     never (stored reporting) × CLOSE;
//   - revaluation compounding: FX_REVAL-style true-ups carry functional
//     0, so they vanish from the translated view.
// CTA sign convention (re-derived; #151's doc was inverted): the plug
// is credit-positive = Σ translated signed balances. Rising rate on
// positive net assets → positive CTA.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getConsolidatedTrialBalance } from "@/lib/accounting/reports/consolidation";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);
const BOOK = "US_GAAP"; // USD reporting
const PERIOD_START = new Date("2026-04-01");
const AS_OF = new Date("2026-06-30");

const E_P = `CTRXP${SUFFIX}`.toUpperCase().slice(0, 14); // parent, USD
const E_G = `CTRXG${SUFFIX}`.toUpperCase().slice(0, 14); // sub, GBP functional
const E_U = `CTRXU${SUFFIX}`.toUpperCase().slice(0, 14); // sub, USD

let tenantId: string;

const A = {
  cash: `CG1${SUFFIX}`.slice(0, 12), // GBP sub: null category → CURRENT_RATE default
  rev: `CG4${SUFFIX}`.slice(0, 12), // GBP sub: WEIGHTED_AVG
  equity: `CG3${SUFFIX}`.slice(0, 12), // GBP sub: HISTORICAL
  fxgain: `CG8${SUFFIX}`.slice(0, 12), // GBP sub: EXCLUDED (the 8300 shape)
  ucash: `CU1${SUFFIX}`.slice(0, 12), // USD sub
  urev: `CU4${SUFFIX}`.slice(0, 12), // USD sub
};

async function scrubStale() {
  const stale = await prisma.tenant.findMany({
    where: { slug: { startsWith: "ctrx" } },
    select: { id: true },
  });
  const tIds = stale.map((t) => t.id);
  if (tIds.length > 0) {
    await prisma.journalLine.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.period.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.legalEntity.updateMany({
      where: { tenantId: { in: tIds } },
      data: { parentEntityId: null },
    });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
  }
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: "CTRX Fixture" } },
    select: { id: true },
  });
  if (staleUsers.length > 0) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.user.deleteMany({ where: { id: { in: staleUsers.map((u) => u.id) } } });
    });
  }
}

beforeAll(async () => {
  await scrubStale();

  await prisma.currency.upsert({
    where: { code: "GBP" },
    create: { code: "GBP", name: "Pound Sterling", decimals: 2, symbol: "£" },
    update: {},
  });

  const owner = await prisma.user.create({
    data: { email: `ctrx-owner-${SUFFIX}@example.test`, displayName: "CTRX Fixture owner" },
    select: { id: true },
  });
  const tenant = await prisma.tenant.create({
    data: { slug: `ctrx-${SUFFIX}`, name: "CTRX Group", ownerUserId: owner.id },
    select: { id: true },
  });
  tenantId = tenant.id;

  const parent = await prisma.legalEntity.create({
    data: { tenantId, code: E_P, name: "CTRX Parent", functionalCurrencyId: "USD" },
    select: { id: true },
  });
  const entities: Record<string, string> = { [E_P]: parent.id };
  for (const [code, ccy] of [
    [E_G, "GBP"],
    [E_U, "USD"],
  ] as const) {
    const ent = await prisma.legalEntity.create({
      data: {
        tenantId,
        code,
        name: code,
        functionalCurrencyId: ccy,
        parentEntityId: parent.id,
      },
      select: { id: true },
    });
    entities[code] = ent.id;
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId,
        entityId: ent.id,
        code: `CTRX_CAL_${code}`.slice(0, 30),
        name: "2026",
        periodFrequency: "MONTHLY",
      },
      select: { id: true },
    });
    for (const m of [4, 5, 6]) {
      await prisma.period.create({
        data: {
          tenantId,
          calendarId: cal.id,
          code: `2026-0${m}`,
          ordinal: m,
          startsOn: new Date(2026, m - 1, 1),
          endsOn: new Date(2026, m, 0),
        },
      });
    }
  }

  const mk = (
    code: string,
    name: string,
    type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
    entityCode: string,
    translationCategory: "CURRENT_RATE" | "HISTORICAL" | "WEIGHTED_AVG" | "EXCLUDED" | null
  ) =>
    prisma.account.create({
      data: {
        tenantId,
        entityId: entities[entityCode],
        code,
        name,
        type,
        normalBalance: type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT",
        translationCategory,
      },
    });
  await mk(A.cash, "Cash (GBP sub)", "ASSET", E_G, null); // null → CURRENT_RATE (documented default)
  await mk(A.rev, "Revenue (GBP sub)", "REVENUE", E_G, "WEIGHTED_AVG");
  await mk(A.equity, "Share capital (GBP sub)", "EQUITY", E_G, "HISTORICAL");
  await mk(A.fxgain, "FX gain (GBP sub)", "REVENUE", E_G, "EXCLUDED");
  await mk(A.ucash, "Cash (USD sub)", "ASSET", E_U, null);
  await mk(A.urev, "Revenue (USD sub)", "REVENUE", E_U, null);

  // GBP→USD CLOSE curve. On-or-before semantics: the 2026-05-10
  // contribution resolves 05-01's 1.10 (HISTORICAL), WEIGHTED_AVG =
  // mean(1.20 @ periodStart, 1.30 @ asOf) = 1.25, CURRENT_RATE = 1.30.
  for (const [date, rate] of [
    ["2026-04-01", "1.2000000000"],
    ["2026-05-01", "1.1000000000"],
    ["2026-06-30", "1.3000000000"],
  ] as const) {
    await prisma.fxRate.upsert({
      where: {
        fromCurrencyId_toCurrencyId_asOf_rateType: {
          fromCurrencyId: "GBP",
          toCurrencyId: "USD",
          asOf: new Date(date),
          rateType: "CLOSE",
        },
      },
      create: {
        fromCurrencyId: "GBP",
        toCurrencyId: "USD",
        asOf: new Date(date),
        rate,
        rateType: "CLOSE",
      },
      update: { rate },
    });
  }

  // GBP sub activity.
  // 1) Equity contribution 2026-05-10 @ 1.10: functional ±500 GBP.
  await postJournalEntry(prisma, {
    tenantId,
    entityCode: E_G,
    bookCode: BOOK,
    currencyCode: "GBP",
    fxRate: 1.1,
    documentDate: new Date("2026-05-10"),
    memo: "Share capital contribution",
    source: "MANUAL",
    lines: [
      { accountCode: A.cash, debit: 500 },
      { accountCode: A.equity, credit: 500 },
    ],
  });
  // 2) Revenue 2026-06-15 @ 1.20: functional ±1000 GBP (reporting 1200 —
  //    the #151 pinned example).
  await postJournalEntry(prisma, {
    tenantId,
    entityCode: E_G,
    bookCode: BOOK,
    currencyCode: "GBP",
    fxRate: 1.2,
    documentDate: new Date("2026-06-15"),
    memo: "June revenue",
    source: "MANUAL",
    lines: [
      { accountCode: A.cash, debit: 1000 },
      { accountCode: A.rev, credit: 1000 },
    ],
  });
  // 3) FX_REVAL-shaped reporting true-up 2026-06-30: functional 0 on
  //    both legs (what postRevaluation stamps for foreign-functional
  //    entities since #334). Must be INVISIBLE to translation.
  await postJournalEntry(prisma, {
    tenantId,
    entityCode: E_G,
    bookCode: BOOK,
    currencyCode: "USD",
    documentDate: new Date("2026-06-30"),
    memo: "FX revaluation true-up (reporting view only)",
    source: "SYSTEM",
    sourceSystem: "FX_REVAL",
    sourceRecordType: "MonetaryRevaluation",
    sourceRecordId: `ctrx-${SUFFIX}`,
    lines: [
      { accountCode: A.cash, debit: 145, functionalAmount: 0 },
      { accountCode: A.fxgain, credit: 145, functionalAmount: 0 },
    ],
  });

  // USD sub activity — must pass through translation untouched.
  await postJournalEntry(prisma, {
    tenantId,
    entityCode: E_U,
    bookCode: BOOK,
    documentDate: new Date("2026-06-15"),
    memo: "USD sub revenue",
    source: "MANUAL",
    lines: [
      { accountCode: A.ucash, debit: 700 },
      { accountCode: A.urev, credit: 700 },
    ],
  });
});

afterAll(async () => {
  await scrubStale();
  await prisma.$disconnect();
});

function row(report: Awaited<ReturnType<typeof getConsolidatedTrialBalance>>, code: string) {
  return report.rows.find((r) => r.accountCode === code);
}

describe("consolidation translation (Phase B)", () => {
  it("naïve mode (no periodStart) is unchanged: translation off, no CTA row", async () => {
    const report = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: E_P,
      bookCode: BOOK,
      asOf: AS_OF,
      tenantId,
    });
    expect(report.translationActive).toBe(false);
    expect(report.cumulativeTranslationAdjustment.toNumber()).toBe(0);
    expect(row(report, "CTA")).toBeUndefined();
    // Naïve mode passes the STORED debit/credit pair through — which is
    // raw posting-currency input (500 GBP + 1000 GBP + 145 USD = 1645),
    // not a single-currency number. This is exactly the incoherence the
    // disclosure banner warns about, pinned here so nobody mistakes the
    // naïve sum for a reporting-currency figure.
    expect(row(report, A.cash)!.totalDebit.toNumber()).toBeCloseTo(1645, 4);
  });

  it("translated: functional × category rate — never stored-reporting × rate (#151, inverted)", async () => {
    const report = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: E_P,
      bookCode: BOOK,
      asOf: AS_OF,
      periodStart: PERIOD_START,
      tenantId,
    });
    expect(report.translationActive).toBe(true);
    expect(report.translationRateByEntity[E_G]).toBe("1.3");
    expect(report.translationRateByEntity[E_U]).toBeNull();

    // Cash: functional 1500 GBP × 1.30 CLOSE = 1950. The #151 defect
    // would produce stored-reporting 1895 × 1.30 = 2463.50 — and before
    // #334's revaluation stamp, 1750 × 1.30-style compounding. Pin the
    // correct number and explicitly refute the double-application.
    const cash = row(report, A.cash)!;
    expect(cash.totalDebit.toNumber()).toBeCloseTo(1950, 4);
    expect(cash.totalDebit.toNumber()).not.toBeCloseTo(2463.5, 2);

    // Revenue: functional 1000 × WAVG mean(1.20, 1.30) = 1.25 → 1250 CR.
    expect(row(report, A.rev)!.totalCredit.toNumber()).toBeCloseTo(1250, 4);

    // Equity: HISTORICAL — frozen at the contribution date's 1.10 → 550
    // CR, regardless of the 1.30 close.
    expect(row(report, A.equity)!.totalCredit.toNumber()).toBeCloseTo(550, 4);

    // The FX_REVAL true-up (functional 0 both legs) is invisible: the
    // fxgain account contributes no row.
    expect(row(report, A.fxgain)).toBeUndefined();

    // CTA plug: 1950 − 1250 − 550 = +150 credit (rising rate on
    // positive net assets → positive CTA), surfaced as the field AND
    // the synthetic equity row, and the consolidated TB balances.
    expect(report.cumulativeTranslationAdjustment.toNumber()).toBeCloseTo(150, 4);
    const cta = row(report, "CTA")!;
    expect(cta).toBeDefined();
    expect(cta.type).toBe("EQUITY");
    expect(cta.totalCredit.toNumber()).toBeCloseTo(150, 4);
    expect(report.balances).toBe(true);

    // The USD sub passes through untranslated.
    expect(row(report, A.ucash)!.totalDebit.toNumber()).toBeCloseTo(700, 4);
  });

});
