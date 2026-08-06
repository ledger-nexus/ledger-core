// Per-line functional-currency measurement — the schema gate for ASC 830
// current-rate translation (#151 postmortem: translation must start from
// functional balances, which postJournalEntry now stores per line).
//
// Derivation contract under test:
//   1. explicit line.functionalAmount override wins (revaluation's 0)
//   2. entry currency == entity functional → transaction amount
//   3. entity functional == book reporting → reporting amount
//   4. three-way → resolveFxRate(txn→functional, documentDate) or throw

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { FxRateNotFoundError } from "@/lib/accounting/fx";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);
const BOOK = "US_GAAP"; // USD reporting
const DOC_DATE = new Date("2026-06-15");

const E_USD = `FNAMU${SUFFIX}`.toUpperCase().slice(0, 14);
const E_GBP = `FNAMG${SUFFIX}`.toUpperCase().slice(0, 14);

let tenantId: string;

async function scrubStale() {
  const stale = await prisma.tenant.findMany({
    where: { slug: { startsWith: "fnam" } },
    select: { id: true },
  });
  const tIds = stale.map((t) => t.id);
  if (tIds.length === 0) return;
  await prisma.journalLine.deleteMany({ where: { tenantId: { in: tIds } } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tIds } } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tIds } } });
  await prisma.account.deleteMany({ where: { tenantId: { in: tIds } } });
  await prisma.period.deleteMany({ where: { tenantId: { in: tIds } } });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: tIds } } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: "FNAM Fixture" } },
    select: { id: true },
  });
  if (staleUsers.length > 0) {
    // app_user hard-deletes error XX000 while the audit RULEs are armed
    // (FK action rewrite) — even with zero referencing audit rows.
    await withAuditLogMutable(prisma, async () => {
      await prisma.user.deleteMany({ where: { id: { in: staleUsers.map((u) => u.id) } } });
    });
  }
}

beforeAll(async () => {
  await scrubStale();

  for (const [code, name, symbol] of [
    ["GBP", "Pound Sterling", "£"],
    ["EUR", "Euro", "€"],
  ] as const) {
    await prisma.currency.upsert({
      where: { code },
      create: { code, name, decimals: 2, symbol },
      update: {},
    });
  }

  const owner = await prisma.user.create({
    data: {
      email: `fnam-owner-${SUFFIX}@example.test`,
      displayName: `FNAM Fixture owner`,
    },
    select: { id: true },
  });
  const tenant = await prisma.tenant.create({
    data: { slug: `fnam-${SUFFIX}`, name: "FNAM Co", ownerUserId: owner.id },
    select: { id: true },
  });
  tenantId = tenant.id;

  for (const [code, ccy] of [
    [E_USD, "USD"],
    [E_GBP, "GBP"],
  ] as const) {
    const ent = await prisma.legalEntity.create({
      data: { tenantId, code, name: code, functionalCurrencyId: ccy },
      select: { id: true },
    });
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId,
        entityId: ent.id,
        code: `FNAM_CAL_${code}`.slice(0, 30),
        name: "2026",
        periodFrequency: "MONTHLY",
      },
      select: { id: true },
    });
    await prisma.period.create({
      data: {
        tenantId,
        calendarId: cal.id,
        code: "2026-06",
        ordinal: 6,
        startsOn: new Date("2026-06-01"),
        endsOn: new Date("2026-06-30"),
      },
    });
    // Shared-form chart per entity, minimal: one asset, one revenue.
    for (const [acode, aname, type, nb] of [
      [`F${code[4]}1${SUFFIX}`.slice(0, 12), "Cash", "ASSET", "DEBIT"],
      [`F${code[4]}4${SUFFIX}`.slice(0, 12), "Revenue", "REVENUE", "CREDIT"],
    ] as const) {
      await prisma.account.create({
        data: {
          tenantId,
          entityId: ent.id,
          code: acode,
          name: aname,
          type,
          normalBalance: nb,
        },
      });
    }
  }

  // EUR→GBP CLOSE rate for the three-way derivation. resolveFxRate
  // defaults to rateType CLOSE with on-or-before semantics. Upsert:
  // fx_rate is GLOBAL (not tenant-scoped), so the tenant scrub can't
  // clean it and a prior run's row survives.
  await prisma.fxRate.upsert({
    where: {
      fromCurrencyId_toCurrencyId_asOf_rateType: {
        fromCurrencyId: "EUR",
        toCurrencyId: "GBP",
        asOf: new Date("2026-06-10"),
        rateType: "CLOSE",
      },
    },
    create: {
      fromCurrencyId: "EUR",
      toCurrencyId: "GBP",
      asOf: new Date("2026-06-10"),
      rate: "0.8500000000",
      rateType: "CLOSE",
    },
    update: { rate: "0.8500000000" },
  });
});

afterAll(async () => {
  await scrubStale();
  await prisma.$disconnect();
});

const acct = (entityCode: string, last: string) =>
  `F${entityCode[4]}${last}${SUFFIX}`.slice(0, 12);

async function linesOf(entryId: string) {
  return prisma.journalLine.findMany({
    where: { entryId },
    orderBy: { lineNo: "asc" },
    select: {
      functionalAmount: true,
      functionalCurrencyId: true,
      transactionAmount: true,
      reportingAmount: true,
    },
  });
}

describe("functional-amount derivation at post time", () => {
  it("single-currency USD/USD: functional == signed == reporting, stamped USD", async () => {
    const r = await postJournalEntry(prisma, {
      tenantId,
      entityCode: E_USD,
      bookCode: BOOK,
      documentDate: DOC_DATE,
      memo: "plain USD",
      source: "MANUAL",
      lines: [
        { accountCode: acct(E_USD, "1"), debit: 250 },
        { accountCode: acct(E_USD, "4"), credit: 250 },
      ],
    });
    const lines = await linesOf(r.id);
    expect(lines[0].functionalCurrencyId).toBe("USD");
    expect(new Decimal(lines[0].functionalAmount.toString()).toNumber()).toBe(250);
    expect(new Decimal(lines[1].functionalAmount.toString()).toNumber()).toBe(-250);
  });

  it("GBP-functional entity posting GBP: functional = transaction amount, NOT the fx-multiplied reporting amount", async () => {
    const r = await postJournalEntry(prisma, {
      tenantId,
      entityCode: E_GBP,
      bookCode: BOOK,
      currencyCode: "GBP",
      fxRate: 1.2,
      documentDate: DOC_DATE,
      memo: "GBP revenue",
      source: "MANUAL",
      lines: [
        { accountCode: acct(E_GBP, "1"), debit: 1000 },
        { accountCode: acct(E_GBP, "4"), credit: 1000 },
      ],
    });
    const lines = await linesOf(r.id);
    // The #151 trap, pinned: reporting is 1200 (posted at 1.20); the
    // functional measurement is 1000 GBP. Translation at a 1.30 close
    // must produce 1300 from THIS number — never 1560 from reporting.
    expect(lines[0].functionalCurrencyId).toBe("GBP");
    expect(new Decimal(lines[0].functionalAmount.toString()).toNumber()).toBe(1000);
    expect(new Decimal(lines[0].reportingAmount.toString()).toNumber()).toBe(1200);
  });

  it("USD-functional entity posting EUR: functional = reporting (transaction-date conversion lands in functional)", async () => {
    const r = await postJournalEntry(prisma, {
      tenantId,
      entityCode: E_USD,
      bookCode: BOOK,
      currencyCode: "EUR",
      fxRate: 1.1,
      documentDate: DOC_DATE,
      memo: "EUR bill",
      source: "MANUAL",
      lines: [
        { accountCode: acct(E_USD, "1"), debit: 100 },
        { accountCode: acct(E_USD, "4"), credit: 100 },
      ],
    });
    const lines = await linesOf(r.id);
    expect(lines[0].functionalCurrencyId).toBe("USD");
    expect(new Decimal(lines[0].functionalAmount.toString()).toNumber()).toBeCloseTo(110, 4);
  });

  it("three-way (EUR entry, GBP functional, USD reporting): functional = txn × resolved EUR→GBP CLOSE rate", async () => {
    const r = await postJournalEntry(prisma, {
      tenantId,
      entityCode: E_GBP,
      bookCode: BOOK,
      currencyCode: "EUR",
      fxRate: 1.1,
      documentDate: DOC_DATE,
      memo: "EUR expense in GBP-functional entity",
      source: "MANUAL",
      lines: [
        { accountCode: acct(E_GBP, "1"), debit: 200 },
        { accountCode: acct(E_GBP, "4"), credit: 200 },
      ],
    });
    const lines = await linesOf(r.id);
    expect(lines[0].functionalCurrencyId).toBe("GBP");
    // 200 EUR × 0.85 = 170 GBP; reporting stays 200 × 1.1 = 220 USD.
    expect(new Decimal(lines[0].functionalAmount.toString()).toNumber()).toBeCloseTo(170, 4);
    expect(new Decimal(lines[0].reportingAmount.toString()).toNumber()).toBeCloseTo(220, 4);
    // Functional view of a balanced entry balances.
    const sum = lines.reduce(
      (a, l) => a.plus(new Decimal(l.functionalAmount.toString())),
      new Decimal(0)
    );
    expect(sum.toNumber()).toBe(0);
  });

  it("three-way with no rate on file throws instead of guessing", async () => {
    await prisma.fxRate.deleteMany({
      where: { fromCurrencyId: "EUR", toCurrencyId: "GBP", asOf: { lt: new Date("2026-01-01") } },
    });
    await expect(
      postJournalEntry(prisma, {
        tenantId,
        entityCode: E_GBP,
        bookCode: BOOK,
        currencyCode: "EUR",
        fxRate: 1.1,
        documentDate: new Date("2025-06-15"), // before any EUR→GBP rate
        memo: "no rate",
        source: "MANUAL",
        lines: [
          { accountCode: acct(E_GBP, "1"), debit: 10 },
          { accountCode: acct(E_GBP, "4"), credit: 10 },
        ],
      })
    ).rejects.toBeInstanceOf(FxRateNotFoundError);
  });

  it("explicit functionalAmount: 0 override is honored (the revaluation stamp)", async () => {
    const r = await postJournalEntry(prisma, {
      tenantId,
      entityCode: E_GBP,
      bookCode: BOOK,
      currencyCode: "USD", // reporting-ccy-only adjustment, like postRevaluation
      documentDate: DOC_DATE,
      memo: "reporting true-up",
      source: "SYSTEM",
      lines: [
        { accountCode: acct(E_GBP, "1"), debit: 33, functionalAmount: 0 },
        { accountCode: acct(E_GBP, "4"), credit: 33, functionalAmount: 0 },
      ],
    });
    const lines = await linesOf(r.id);
    expect(new Decimal(lines[0].functionalAmount.toString()).toNumber()).toBe(0);
    expect(new Decimal(lines[1].functionalAmount.toString()).toNumber()).toBe(0);
    expect(lines[0].functionalCurrencyId).toBe("GBP");
  });
});
