// Seed data: Northwind Cloud, a fictional SaaS company.
//
// 6 months of activity (Jan–Jun 2026): incorporation, hiring, customer sales,
// expense accruals, monthly depreciation. Every transaction balances.
//
// In this v1 seed, postings go to the US_GAAP book only. The schema seeds
// three books (US_GAAP, US_TAX, IFRS) so the structure is exercised, but
// divergent multi-book postings (and the book-tax difference report) arrive
// in the next batch alongside the sub-ledger work.
//
// Run with: pnpm db:seed

import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { CHART_OF_ACCOUNTS } from "../src/lib/db/chart-of-accounts";

const prisma = new PrismaClient();

const ENTITY_CODE = "NORTHWIND";
const FISCAL_CALENDAR_CODE = "STANDARD_2026";

// ---- Master data seeding (currencies, entity, books, calendar, periods) ----

async function seedMasterData() {
  console.log("Seeding master data (Layer 2)...");

  // Currencies — minimum viable set. USD is the entity's functional.
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.currency.upsert({
    where: { code: "EUR" },
    create: { code: "EUR", name: "Euro", decimals: 2, symbol: "€" },
    update: {},
  });

  // Legal entity.
  const entity = await prisma.legalEntity.upsert({
    where: { code: ENTITY_CODE },
    create: {
      code: ENTITY_CODE,
      name: "Northwind Cloud, Inc.",
      functionalCurrencyId: "USD",
    },
    update: {},
  });

  // Books. Three peer books per the locked multi-book decision — all
  // reporting in USD for this US-only entity. IFRS book exists for the
  // future ECB-reporting subsidiary scenario.
  for (const b of [
    { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP" as const },
    { code: "US_TAX", name: "US Federal Tax", basis: "US_TAX" as const },
    { code: "IFRS", name: "IFRS", basis: "IFRS" as const },
  ]) {
    await prisma.book.upsert({
      where: { code: b.code },
      create: {
        code: b.code,
        name: b.name,
        basis: b.basis,
        reportingCurrencyId: "USD",
      },
      update: {},
    });
  }

  // Fiscal calendar with 12 monthly periods for 2026.
  const calendar = await prisma.fiscalCalendar.upsert({
    where: { entityId_code: { entityId: entity.id, code: FISCAL_CALENDAR_CODE } },
    create: {
      entityId: entity.id,
      code: FISCAL_CALENDAR_CODE,
      name: "Standard 2026 Calendar",
      periodFrequency: "MONTHLY",
    },
    update: {},
  });

  const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0));
  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: monthEnd(2026, m),
      },
      update: {},
    });
  }

  console.log("  ✓ master data ready");
}

async function seedAccounts() {
  console.log("Seeding chart of accounts (Layer 1)...");
  // entityId = null → shared chart across entities.
  for (const acct of CHART_OF_ACCOUNTS) {
    await prisma.account.upsert({
      where: { entityId_code: { entityId: null as any, code: acct.code } as any },
      create: {
        code: acct.code,
        name: acct.name,
        type: acct.type,
        normalBalance: acct.normalBalance,
        isContra: acct.isContra ?? false,
        isControlAccount: acct.isControlAccount ?? false,
        isBank: acct.isBank ?? false,
        subtype: acct.subtype,
      },
      update: {},
    });
  }
  console.log(`  ✓ ${CHART_OF_ACCOUNTS.length} accounts loaded`);
}

async function seedEntries() {
  console.log("Seeding journal entries for Northwind Cloud (US_GAAP)...");

  // ---- January 2026: Incorporation & initial setup ----

  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-01-02"),
    memo: "Initial capitalization — founders contribute $500k seed",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 500_000, description: "Cash received" },
      { accountCode: "3000", credit: 1_000, description: "Common stock at par" },
      { accountCode: "3100", credit: 499_000, description: "Paid-in capital" },
    ],
  });

  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-01-05"),
    memo: "Purchase laptops for engineering team",
    source: "SEED",
    lines: [
      { accountCode: "1500", debit: 24_000, description: "8 MacBooks @ $3,000" },
      { accountCode: "1000", credit: 24_000 },
    ],
  });

  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-01-15"),
    memo: "Annual prepayment for office G&A insurance",
    source: "SEED",
    lines: [
      { accountCode: "1400", debit: 12_000 },
      { accountCode: "1000", credit: 12_000 },
    ],
  });

  // ---- Recurring monthly patterns: payroll, SaaS tools, revenue, depreciation ----

  const months = [
    { date: "2026-01-31", label: "Jan" },
    { date: "2026-02-28", label: "Feb" },
    { date: "2026-03-31", label: "Mar" },
    { date: "2026-04-30", label: "Apr" },
    { date: "2026-05-31", label: "May" },
    { date: "2026-06-30", label: "Jun" },
  ];

  for (const m of months) {
    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(m.date),
      memo: `${m.label} payroll`,
      source: "SEED",
      lines: [
        { accountCode: "6000", debit: 80_000, description: "Gross salaries" },
        { accountCode: "6100", debit: 6_400, description: "Employer payroll taxes" },
        { accountCode: "6200", debit: 8_000, description: "Health & benefits" },
        { accountCode: "1010", credit: 94_400, description: "Net cash out" },
      ],
    });

    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(m.date),
      memo: `${m.label} SaaS subscriptions`,
      source: "SEED",
      lines: [
        { accountCode: "7000", debit: 4_500 },
        { accountCode: "1000", credit: 4_500 },
      ],
    });

    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(m.date),
      memo: `${m.label} marketing spend`,
      source: "SEED",
      lines: [
        { accountCode: "7100", debit: 7_500 },
        { accountCode: "1000", credit: 7_500 },
      ],
    });

    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(m.date),
      memo: `${m.label} AWS hosting`,
      source: "SEED",
      lines: [
        { accountCode: "5000", debit: 3_200 },
        { accountCode: "1000", credit: 3_200 },
      ],
    });

    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(m.date),
      memo: `${m.label} prepaid insurance amortization`,
      source: "SEED",
      lines: [
        { accountCode: "7300", debit: 1_000 },
        { accountCode: "1400", credit: 1_000 },
      ],
    });

    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(m.date),
      memo: `${m.label} depreciation expense`,
      source: "SEED",
      lines: [
        { accountCode: "8000", debit: 667 },
        { accountCode: "1510", credit: 667, description: "Accumulated depreciation" },
      ],
    });
  }

  // ---- Sample customer revenue cycle: invoice → collect ----

  for (const m of months) {
    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(m.date),
      memo: `${m.label} invoice — Acme Corp`,
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 5_000, description: "Acme Corp AR" },
        { accountCode: "4000", credit: 5_000, description: "Acme subscription revenue" },
      ],
    });
  }

  for (const [collectDate, memo] of [
    ["2026-02-15", "Acme Corp pays January invoice"],
    ["2026-03-15", "Acme Corp pays February invoice"],
    ["2026-04-15", "Acme Corp pays March invoice"],
  ] as const) {
    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(collectDate),
      memo,
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 5_000 },
        { accountCode: "1200", credit: 5_000 },
      ],
    });
  }

  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-03-01"),
    memo: "Globex prepays annual contract — $60k",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 60_000 },
      { accountCode: "2200", credit: 60_000, description: "Deferred — Globex" },
    ],
  });

  for (const m of months.slice(2)) {
    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(m.date),
      memo: `${m.label} Globex revenue recognition`,
      source: "SEED",
      lines: [
        { accountCode: "2200", debit: 5_000 },
        { accountCode: "4000", credit: 5_000 },
      ],
    });
  }

  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-04-10"),
    memo: "Professional fees — legal review, billed",
    source: "SEED",
    lines: [
      { accountCode: "7200", debit: 8_500 },
      { accountCode: "2000", credit: 8_500, description: "Vendor: Smith & Co" },
    ],
  });

  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-10"),
    memo: "Smith & Co — pay legal invoice",
    source: "SEED",
    lines: [
      { accountCode: "2000", debit: 8_500 },
      { accountCode: "1000", credit: 8_500 },
    ],
  });

  console.log("  ✓ seed entries posted");
}

async function main() {
  await seedMasterData();
  await seedAccounts();
  await seedEntries();
  const count = await prisma.journalEntry.count();
  console.log(`\nDone. ${count} journal entries in the ledger.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
