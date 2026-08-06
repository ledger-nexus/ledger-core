// Multi-entity consolidation demo seed.
//
// Sets up a tiny parent + 2 subsidiaries with an intercompany transaction
// so the /reports/consolidation page has something to render. Independent
// of the Northwind seed — runs against the existing chart of accounts +
// US_GAAP book.
//
//   ACME_GROUP   (parent — non-operating)
//     ├── ACME_US   ($10k revenue from external customer, $3k IC sale to UK)
//     ├── ACME_UK   ($3k IC purchase from US, $5k revenue from external customer)
//     └── ACME_EU   (EUR-functional — €20k capital, €8k external revenue)
//
// At consolidation the IC revenue ($3k) + IC expense ($3k) eliminate,
// plus the Due-from / Due-to balances ($3k each) cancel. The group's
// consolidated revenue = $15k from the USD subs (NOT $18k), plus the
// translated EUR revenue; group AR = $0 IC + external receivables.
//
// ACME_EU exists to make ASC 830 current-rate translation OBSERVABLE.
// Without a genuinely foreign subsidiary the translation engine and the
// CTA row are dead UI: correct per their tests, but impossible to see in
// the product — which is exactly how they shipped. It carries NO
// intercompany balances on purpose, so the US/UK elimination math above
// is unchanged.
//
// Its CTA is deliberately non-zero, which takes more than one rate: a
// single uniform rate scales the whole trial balance evenly and leaves
// a CTA of exactly zero, demonstrating nothing. All three ASC 830
// treatments land in this one entity, and the seed only has to set the
// equity one — 4000 already carries WEIGHTED_AVG.
//
// As the consolidation page renders it out of the box — asOf 30 Jun
// with the DEFAULT period start, which is a quarter back day 1, i.e.
// 1 March (not 1 April; see the correction below):
//
//   cash     €28,000 × 1.11500  CURRENT_RATE   30 Jun close  = $31,220 DR
//   capital  €20,000 × 1.05000  HISTORICAL     2 Jan, the
//                               day it was contributed       = $21,000 CR
//   revenue   €8,000 × 1.10300  WEIGHTED_AVG   mean of the
//                               28 Feb 1.091 (the on-or-before
//                               rate at a 1 Mar start) and
//                               the 1.115 close              =  $8,824 CR
//   CTA (the balancing plug)                                 =  $1,396 CR
//
// ⚠️ This example previously read 1.10625 / $8,850 / CTA $1,370, which
// is what you get from a 1 APRIL start (mean of the 31 Mar 1.0975 and
// the close) — and the page reproduces those figures exactly if you
// hand it `periodStart=2026-04-01`. But `deriveDefaultPeriodStart`
// subtracts three months from 30 Jun and clamps to day 1, which lands
// on 1 March, and `resolveFxRate` is on-or-before, so the start rate is
// February's 1.091. The engine was right both times; the worked example
// was assuming a window the default does not produce.
//
// Read: the euros bought more dollars at the 30 Jun close than at the
// 2 Jan contribution rate, and that unrealized gain sits in equity
// rather than income. Consolidated revenue becomes $15,000 from the
// USD subs + $8,824 translated = $23,824.

import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "../accounting/post-journal";
import { getDefaultTenantId } from "./default-tenant";

const PARENT_CODE = "ACME_GROUP";
const SUB_US_CODE = "ACME_US";
const SUB_UK_CODE = "ACME_UK";
const SUB_EU_CODE = "ACME_EU";
const BOOK_CODE = "US_GAAP";

export const CONSOLIDATION_DEMO_ENTITIES = [
  PARENT_CODE,
  SUB_US_CODE,
  SUB_UK_CODE,
  SUB_EU_CODE,
];

/** EUR→USD for the demo's three dates. The contribution rate and the
 *  close rate differ, which is what gives ACME_EU a non-zero CTA. */
const EU_RATES: Array<[string, string]> = [
  ["2026-01-02", "1.0500"], // capital contributed here — the HISTORICAL rate
  ["2026-05-15", "1.1050"], // revenue earned here (sits on the existing curve)
  ["2026-06-30", "1.1150"], // period-end CLOSE
];

export async function seedConsolidationDemo(prisma: PrismaClient): Promise<void> {
  // Clear this demo's own transactions first. Without it every db:seed
  // run RE-POSTS all of them and the demo's numbers inflate silently —
  // observed going 6 → 14 → 22 entries across three runs. The lineage
  // unique index doesn't catch the duplicates because these entries set
  // sourceRecordType/sourceRecordId but no sourceSystem, and the index
  // is partial on all three being non-null. clearConsolidationDemo was
  // written for exactly this and then never called.
  await clearConsolidationDemo(prisma);

  // Ensure currencies + book exist (no-op if Northwind seed already ran).
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.currency.upsert({
    where: { code: "EUR" },
    create: { code: "EUR", name: "Euro", decimals: 2, symbol: "\u20ac" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: { code: BOOK_CODE, name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });

  const tenantId = await getDefaultTenantId(prisma);

  // Phase 4b: legalEntity.code unique per [tenantId, code]; upserts
  // target the composite key.
  const parent = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: PARENT_CODE } },
    create: {
      tenantId,
      code: PARENT_CODE,
      name: "Acme Group (consolidation parent)",
      functionalCurrencyId: "USD",
    },
    update: { tenantId },
  });

  const usSub = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: SUB_US_CODE } },
    create: {
      tenantId,
      code: SUB_US_CODE,
      name: "Acme US Subsidiary",
      functionalCurrencyId: "USD",
      parentEntityId: parent.id,
    },
    update: { tenantId, parentEntityId: parent.id },
  });
  const ukSub = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: SUB_UK_CODE } },
    create: {
      tenantId,
      code: SUB_UK_CODE,
      name: "Acme UK Subsidiary",
      functionalCurrencyId: "USD",  // Real-world: GBP; demo uses USD to keep math clean.
      parentEntityId: parent.id,
    },
    update: { tenantId, parentEntityId: parent.id },
  });
  // The one genuinely foreign subsidiary — the reason the translation
  // engine has anything to do.
  const euSub = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: SUB_EU_CODE } },
    create: {
      tenantId,
      code: SUB_EU_CODE,
      name: "Acme Europe SARL",
      functionalCurrencyId: "EUR",
      parentEntityId: parent.id,
    },
    update: { tenantId, parentEntityId: parent.id, functionalCurrencyId: "EUR" },
  });

  for (const [asOf, rate] of EU_RATES) {
    await prisma.fxRate.upsert({
      where: {
        fromCurrencyId_toCurrencyId_asOf_rateType: {
          fromCurrencyId: "EUR",
          toCurrencyId: "USD",
          asOf: new Date(asOf),
          rateType: "CLOSE",
        },
      },
      create: {
        fromCurrencyId: "EUR",
        toCurrencyId: "USD",
        asOf: new Date(asOf),
        rateType: "CLOSE",
        rate,
      },
      update: { rate },
    });
  }

  // Contributed capital is frozen at the rate on the day it was
  // contributed (ASC 830) — and it is what makes the CTA non-zero.
  await prisma.account.updateMany({
    where: { tenantId, code: "3100" },
    data: { translationCategory: "HISTORICAL" },
  });

  // Fiscal calendar + Q1 period for each sub (needed by postJournalEntry).
  for (const ent of [parent, usSub, ukSub, euSub]) {
    const cal = await prisma.fiscalCalendar.upsert({
      where: { entityId_code: { entityId: ent.id, code: "STANDARD_2026" } },
      create: {
        tenantId,
        entityId: ent.id,
        code: "STANDARD_2026",
        name: "Standard 2026",
        periodFrequency: "MONTHLY",
      },
      update: { tenantId },
    });
    for (let m = 1; m <= 12; m++) {
      const code = `2026-${String(m).padStart(2, "0")}`;
      await prisma.period.upsert({
        where: { calendarId_code: { calendarId: cal.id, code } },
        create: {
          tenantId,
          calendarId: cal.id,
          code,
          ordinal: m,
          startsOn: new Date(Date.UTC(2026, m - 1, 1)),
          endsOn: new Date(Date.UTC(2026, m, 0)),
        },
        update: { tenantId },
      });
    }
  }

  // ---- Transactions: subs only (the parent has no operating activity) ----

  // US sub: $10k external revenue + $3k intercompany sale to UK sub.
  await postJournalEntry(prisma, {
    entityCode: SUB_US_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-02-15"),
    memo: "External customer revenue",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 10_000 },
      { accountCode: "4000", credit: 10_000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: SUB_US_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-03-01"),
    memo: "Intercompany sale to Acme UK",
    source: "SEED",
    sourceRecordType: "IntercompanyInvoice",
    sourceRecordId: "IC-USUK-001",
    lines: [
      // US sub debits Due from Affiliates (asset) when shipping to UK sub on account
      { accountCode: "1300", debit: 3_000, description: "Due from Acme UK" },
      // Credits its intercompany revenue
      { accountCode: "4900", credit: 3_000, description: "Intercompany revenue" },
    ],
  });

  // UK sub: $5k external revenue + $3k intercompany expense from US.
  await postJournalEntry(prisma, {
    entityCode: SUB_UK_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-02-20"),
    memo: "External customer revenue (UK)",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 5_000 },
      { accountCode: "4000", credit: 5_000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: SUB_UK_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-03-01"),
    memo: "Intercompany purchase from Acme US",
    source: "SEED",
    sourceRecordType: "IntercompanyBill",
    sourceRecordId: "IC-USUK-001",
    lines: [
      // UK sub debits intercompany expense
      { accountCode: "5900", debit: 3_000, description: "Intercompany expense" },
      // Credits Due to Affiliates (liability owed to US sub)
      { accountCode: "2400", credit: 3_000, description: "Due to Acme US" },
    ],
  });

  // Capital contributions to each sub so the BS makes sense.
  await postJournalEntry(prisma, {
    entityCode: SUB_US_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-01-02"),
    memo: "Capital from parent",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 50_000 },
      { accountCode: "3100", credit: 50_000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: SUB_UK_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-01-02"),
    memo: "Capital from parent",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 25_000 },
      { accountCode: "3100", credit: 25_000 },
    ],
  });

  // ---- ACME_EU: posted in EUR, its own functional currency ----------
  //
  // fxRate is the transaction-date EUR→USD rate, so the stored
  // reporting amounts are the transaction-date conversion. The stored
  // FUNCTIONAL amounts stay in euros, which is what the translation
  // engine reads — translating the reporting pair instead would
  // double-apply FX (the #151 postmortem).
  await postJournalEntry(prisma, {
    entityCode: SUB_EU_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "EUR",
    fxRate: EU_RATES[0][1],
    documentDate: new Date("2026-01-02"),
    memo: "Capital from parent (EUR)",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 20_000 },
      { accountCode: "3100", credit: 20_000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: SUB_EU_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "EUR",
    fxRate: EU_RATES[1][1],
    documentDate: new Date("2026-05-15"),
    memo: "External customer revenue (EUR)",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 8_000 },
      { accountCode: "4000", credit: 8_000 },
    ],
  });
}

export async function clearConsolidationDemo(prisma: PrismaClient): Promise<void> {
  const entities = await prisma.legalEntity.findMany({
    where: { code: { in: CONSOLIDATION_DEMO_ENTITIES } },
    select: { id: true },
  });
  const ids = entities.map((e) => e.id);
  if (ids.length === 0) return;

  await prisma.arApplication.deleteMany({
    where: { openItem: { entityId: { in: ids } } },
  });
  await prisma.apApplication.deleteMany({
    where: { openItem: { entityId: { in: ids } } },
  });
  await prisma.arOpenItem.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.apOpenItem.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.journalEntry.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.partyRole.deleteMany({
    where: { party: { entityId: { in: ids } } },
  });
  await prisma.party.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.periodClose.deleteMany({ where: { entityId: { in: ids } } });
  // Leave fiscal calendars + entities themselves so re-seed is idempotent.
}
