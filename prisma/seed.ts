// Seed data: Northwind Cloud, a fictional SaaS company.
//
// 6 months of activity (Jan–Jun 2026): incorporation, hiring, customer sales,
// expense accruals, monthly depreciation. Every transaction balances.
//
// Run with: pnpm db:seed

import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "../accounting/post-journal";
import { CHART_OF_ACCOUNTS } from "./chart-of-accounts";

const prisma = new PrismaClient();

async function seedAccounts() {
  console.log("Seeding chart of accounts...");
  for (const acct of CHART_OF_ACCOUNTS) {
    await prisma.account.upsert({
      where: { code: acct.code },
      create: {
        code: acct.code,
        name: acct.name,
        type: acct.type,
        normalBalance: acct.normalBalance,
        isContra: acct.isContra ?? false,
      },
      update: {},
    });
  }
  console.log(`  ✓ ${CHART_OF_ACCOUNTS.length} accounts loaded`);
}

async function seedEntries() {
  console.log("Seeding journal entries for Northwind Cloud...");

  // ---- January 2026: Incorporation & initial setup ----

  await postJournalEntry(prisma, {
    date: new Date("2026-01-02"),
    memo: "Initial capitalization — founders contribute $500k seed",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 500_000, description: "Cash received" },
      { accountCode: "3000", credit: 1_000, description: "Common stock at par" },
      { accountCode: "3100", credit: 499_000, description: "Paid-in capital" },
    ],
  });

  await postJournalEntry(prisma, {
    date: new Date("2026-01-05"),
    memo: "Purchase laptops for engineering team",
    source: "SEED",
    lines: [
      { accountCode: "1500", debit: 24_000, description: "8 MacBooks @ $3,000" },
      { accountCode: "1000", credit: 24_000 },
    ],
  });

  await postJournalEntry(prisma, {
    date: new Date("2026-01-15"),
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
    // Payroll: 8 people, ~$10k each, plus 8% payroll taxes and $1k benefits each.
    await postJournalEntry(prisma, {
      date: new Date(m.date),
      memo: `${m.label} payroll`,
      source: "SEED",
      lines: [
        { accountCode: "6000", debit: 80_000, description: "Gross salaries" },
        { accountCode: "6100", debit: 6_400, description: "Employer payroll taxes" },
        { accountCode: "6200", debit: 8_000, description: "Health & benefits" },
        { accountCode: "1010", credit: 94_400, description: "Net cash out" },
      ],
    });

    // SaaS tooling
    await postJournalEntry(prisma, {
      date: new Date(m.date),
      memo: `${m.label} SaaS subscriptions`,
      source: "SEED",
      lines: [
        { accountCode: "7000", debit: 4_500 },
        { accountCode: "1000", credit: 4_500 },
      ],
    });

    // Marketing spend
    await postJournalEntry(prisma, {
      date: new Date(m.date),
      memo: `${m.label} marketing spend`,
      source: "SEED",
      lines: [
        { accountCode: "7100", debit: 7_500 },
        { accountCode: "1000", credit: 7_500 },
      ],
    });

    // Hosting (cost of revenue)
    await postJournalEntry(prisma, {
      date: new Date(m.date),
      memo: `${m.label} AWS hosting`,
      source: "SEED",
      lines: [
        { accountCode: "5000", debit: 3_200 },
        { accountCode: "1000", credit: 3_200 },
      ],
    });

    // Prepaid insurance amortization: $12k / 12 months = $1k/mo
    await postJournalEntry(prisma, {
      date: new Date(m.date),
      memo: `${m.label} prepaid insurance amortization`,
      source: "SEED",
      lines: [
        { accountCode: "7300", debit: 1_000 },
        { accountCode: "1400", credit: 1_000 },
      ],
    });

    // Depreciation: $24k / 36 months ≈ $667/mo
    await postJournalEntry(prisma, {
      date: new Date(m.date),
      memo: `${m.label} depreciation expense`,
      source: "SEED",
      lines: [
        { accountCode: "8000", debit: 667 },
        { accountCode: "1510", credit: 667, description: "Accumulated depreciation" },
      ],
    });
  }

  // ---- Sample customer revenue cycle: invoice → collect ----

  // Customer A signs an annual contract, billed monthly @ $5k
  for (const m of months) {
    await postJournalEntry(prisma, {
      date: new Date(m.date),
      memo: `${m.label} invoice — Acme Corp`,
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 5_000, description: "Acme Corp AR" },
        { accountCode: "4000", credit: 5_000, description: "Acme subscription revenue" },
      ],
    });
  }

  // Collections (a few invoices paid, some still outstanding for AR aging realism)
  await postJournalEntry(prisma, {
    date: new Date("2026-02-15"),
    memo: "Acme Corp pays January invoice",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 5_000 },
      { accountCode: "1200", credit: 5_000 },
    ],
  });
  await postJournalEntry(prisma, {
    date: new Date("2026-03-15"),
    memo: "Acme Corp pays February invoice",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 5_000 },
      { accountCode: "1200", credit: 5_000 },
    ],
  });
  await postJournalEntry(prisma, {
    date: new Date("2026-04-15"),
    memo: "Acme Corp pays March invoice",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 5_000 },
      { accountCode: "1200", credit: 5_000 },
    ],
  });

  // Annual prepaid customer — creates deferred revenue
  await postJournalEntry(prisma, {
    date: new Date("2026-03-01"),
    memo: "Globex prepays annual contract — $60k",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 60_000 },
      { accountCode: "2200", credit: 60_000, description: "Deferred — Globex" },
    ],
  });

  // Monthly release of Globex deferred revenue: $60k / 12 = $5k/mo, starting Mar
  for (const m of months.slice(2)) {
    await postJournalEntry(prisma, {
      date: new Date(m.date),
      memo: `${m.label} Globex revenue recognition`,
      source: "SEED",
      lines: [
        { accountCode: "2200", debit: 5_000 },
        { accountCode: "4000", credit: 5_000 },
      ],
    });
  }

  // Vendor bill paid late (AP cycle)
  await postJournalEntry(prisma, {
    date: new Date("2026-04-10"),
    memo: "Professional fees — legal review, billed",
    source: "SEED",
    lines: [
      { accountCode: "7200", debit: 8_500 },
      { accountCode: "2000", credit: 8_500, description: "Vendor: Smith & Co" },
    ],
  });
  await postJournalEntry(prisma, {
    date: new Date("2026-05-10"),
    memo: "Smith & Co — pay legal invoice",
    source: "SEED",
    lines: [
      { accountCode: "2000", debit: 8_500 },
      { accountCode: "1000", credit: 8_500 },
    ],
  });

  console.log("  ✓ Seed entries posted");
}

async function main() {
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
