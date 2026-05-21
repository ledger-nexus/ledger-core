// Seed data: Northwind Cloud, a fictional SaaS company.
//
// 6 months of activity (Jan–Jun 2026) — Pattern 2 multi-book ledger.
// Every transaction posts in full to US_GAAP, US_TAX, and IFRS unless the
// books treat the event differently (Globex prepay: ACCRUAL deferred for
// GAAP/IFRS, CASH-basis immediate revenue for TAX). Depreciation diverges
// per book (36-month SL for GAAP/IFRS, 60-month SL for TAX), producing
// the book-tax difference the v0.3 report can surface.
//
// Run with: pnpm db:seed

import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { CHART_OF_ACCOUNTS } from "../src/lib/db/chart-of-accounts";
import { openArItem, applyArPayment } from "../src/lib/accounting/sub-ledgers/ar";
import { openApItem, applyApPayment } from "../src/lib/accounting/sub-ledgers/ap";
import {
  createFixedAsset,
  runDepreciation,
} from "../src/lib/accounting/sub-ledgers/fixed-assets";
import {
  createRevenueContract,
  runStraightLineRecognition,
} from "../src/lib/accounting/sub-ledgers/revenue-contracts";
import { createLease, runLeaseAccounting } from "../src/lib/accounting/sub-ledgers/leases";

const prisma = new PrismaClient();

const ENTITY_CODE = "NORTHWIND";
const FISCAL_CALENDAR_CODE = "STANDARD_2026";
const PARALLEL_BOOKS = ["US_GAAP", "US_TAX", "IFRS"] as const;

// Books that recognize revenue / capitalize leases on accrual basis.
const ACCRUAL_BOOKS = ["US_GAAP", "IFRS"] as const;

// ---- Helpers ------------------------------------------------------------

type EntryShape = Omit<Parameters<typeof postJournalEntry>[1], "entityCode" | "bookCode">;

async function postToBooks(
  books: readonly string[],
  base: EntryShape
): Promise<{ bookCode: string; id: string; entryNumber: string }[]> {
  const results: { bookCode: string; id: string; entryNumber: string }[] = [];
  for (const bookCode of books) {
    // Object.assign avoids TS's "specified more than once" check that fires
    // when an Omit'd spread can't statically prove a key was removed.
    const input = Object.assign({}, base, { entityCode: ENTITY_CODE, bookCode });
    const r = await postJournalEntry(prisma, input);
    results.push({ bookCode, id: r.id, entryNumber: r.entryNumber });
  }
  return results;
}

const MONTH_ENDS = [
  { date: "2026-01-31", label: "Jan" },
  { date: "2026-02-28", label: "Feb" },
  { date: "2026-03-31", label: "Mar" },
  { date: "2026-04-30", label: "Apr" },
  { date: "2026-05-31", label: "May" },
  { date: "2026-06-30", label: "Jun" },
];

// ---- Master data seeding -----------------------------------------------

async function seedMasterData() {
  console.log("Seeding master data (Layer 2)...");

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

  const entity = await prisma.legalEntity.upsert({
    where: { code: ENTITY_CODE },
    create: {
      code: ENTITY_CODE,
      name: "Northwind Cloud, Inc.",
      functionalCurrencyId: "USD",
    },
    update: {},
  });

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

  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: {},
    });
  }

  console.log("  ✓ master data ready");
}

async function seedAccounts() {
  console.log("Seeding chart of accounts (shared chart, entityId=null)...");
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

async function seedParties() {
  console.log("Seeding parties (customers, vendors, lessor)...");
  const entity = await prisma.legalEntity.findUniqueOrThrow({
    where: { code: ENTITY_CODE },
    select: { id: true },
  });

  for (const p of [
    { code: "ACME", displayName: "Acme Corp", role: "CUSTOMER" as const },
    { code: "GLOBEX", displayName: "Globex Corporation", role: "CUSTOMER" as const },
    { code: "SMITH_CO", displayName: "Smith & Co Legal", role: "VENDOR" as const },
    { code: "HUDSON_YARDS", displayName: "50 Hudson Yards LLC", role: "VENDOR" as const },
  ]) {
    const party = await prisma.party.upsert({
      where: { entityId_code: { entityId: entity.id, code: p.code } },
      create: {
        entityId: entity.id,
        code: p.code,
        displayName: p.displayName,
      },
      update: {},
    });
    await prisma.partyRole.upsert({
      where: { partyId_role: { partyId: party.id, role: p.role } },
      create: { partyId: party.id, role: p.role },
      update: {},
    });
  }
  console.log("  ✓ 4 parties seeded");
}

// ---- Sub-ledger setup --------------------------------------------------

async function setupFixedAssets() {
  console.log("Creating fixed asset (laptops) with divergent book attributes...");
  // $24k of laptops, January 5 2026.
  // GAAP / IFRS: 36-month straight line, $24k / 36 = $666.67/mo
  // US Tax: 60-month straight line, $24k / 60 = $400/mo
  // → 6-month YTD: GAAP/IFRS $4,000.02, TAX $2,400. Δ = $1,600.02 temporary.
  await createFixedAsset(prisma, {
    entityCode: ENTITY_CODE,
    code: "LAPTOPS-2026-001",
    description: "8 MacBooks (engineering team) @ $3,000",
    category: "COMPUTER_EQUIPMENT",
    acquisitionDate: new Date("2026-01-05"),
    acquisitionCost: 24_000,
    acquisitionCurrencyCode: "USD",
    assetAccountCode: "1500",
    books: [
      {
        bookCode: "US_GAAP",
        usefulLifeMonths: 36,
        method: "STRAIGHT_LINE",
        inServiceDate: new Date("2026-01-05"),
        depreciationExpenseAccountCode: "8000",
        accumDepreciationAccountCode: "1510",
      },
      {
        bookCode: "IFRS",
        usefulLifeMonths: 36,
        method: "STRAIGHT_LINE",
        inServiceDate: new Date("2026-01-05"),
        depreciationExpenseAccountCode: "8000",
        accumDepreciationAccountCode: "1510",
      },
      {
        bookCode: "US_TAX",
        usefulLifeMonths: 60,
        method: "STRAIGHT_LINE",
        inServiceDate: new Date("2026-01-05"),
        depreciationExpenseAccountCode: "8000",
        accumDepreciationAccountCode: "1510",
      },
    ],
  });
  console.log("  ✓ fixed asset record created (3 book-attributes rows)");
}

async function setupRevenueContract() {
  console.log("Creating Globex revenue contract (ASC 606 / CASH-basis tax)...");
  // Globex prepays $60k for 12 months of service starting 2026-03-01.
  // ACCRUAL books (US_GAAP, IFRS): recognize $5k/mo over the 12-month service period.
  // CASH-basis book (US_TAX): recognize the full $60k when cash is received (March).
  // → After 6/30/2026: Accrual revenue YTD = $20k (Mar/Apr/May/Jun). Tax = $60k.
  //   Deferred revenue: Accrual $40k. Tax $0.
  await createRevenueContract(prisma, {
    entityCode: ENTITY_CODE,
    code: "GLOBEX-2026-A1",
    description: "Globex annual subscription",
    customerPartyCode: "GLOBEX",
    contractStartDate: new Date("2026-03-01"),
    contractEndDate: new Date("2027-02-28"),
    totalContractValue: 60_000,
    currencyCode: "USD",
    performanceObligations: [
      {
        sequenceNo: 1,
        description: "SaaS subscription access",
        ssp: 60_000,
        recognitionPattern: "OVER_TIME_STRAIGHT",
        startDate: new Date("2026-03-01"),
        endDate: new Date("2027-02-28"),
        revenueAccountCode: "4000",
        deferredAccountCode: "2200",
      },
    ],
    books: [
      { bookCode: "US_GAAP", recognitionBasis: "ACCRUAL" },
      { bookCode: "IFRS", recognitionBasis: "ACCRUAL" },
      { bookCode: "US_TAX", recognitionBasis: "CASH" },
    ],
  });
  console.log("  ✓ revenue contract + performance obligation created");
}

async function setupLease() {
  console.log("Creating NYC office lease (ASC 842 operating for GAAP/IFRS, cash basis for TAX)...");
  // 24-month lease, $5k/mo, 6% annual rate, starting 2026-03-01.
  // GAAP/IFRS OPERATING: PV ≈ $112,814 → Dr ROU $112,814, Cr Lease Liability $112,814 at commencement.
  //   Each month: combined JE Dr Lease Expense $5,000 / Cr ROU (amort) / Cr Lease Liability (interest).
  //   Then cash payment Dr Lease Liability $5,000 / Cr Cash $5,000.
  // US_TAX TAX_CASH_BASIS: no ROU, no liability. Monthly Dr Lease Expense $5k / Cr Cash $5k.
  // → Substantial BS divergence: GAAP/IFRS show ROU + lease liability, TAX shows neither.
  await createLease(prisma, {
    entityCode: ENTITY_CODE,
    code: "NYC-2026",
    description: "NYC office, 50 Hudson Yards",
    lessorPartyCode: "HUDSON_YARDS",
    leaseStartDate: new Date("2026-03-01"),
    leaseEndDate: new Date("2028-02-29"),
    paymentFrequency: "MONTHLY",
    paymentAmount: 5_000,
    currencyCode: "USD",
    books: [
      {
        bookCode: "US_GAAP",
        classification: "OPERATING",
        discountRate: 0.06,
        rouAccountCode: "1600",
        liabilityAccountCode: "2600",
        expenseAccountCode: "7400",
      },
      {
        bookCode: "IFRS",
        classification: "OPERATING",
        discountRate: 0.06,
        rouAccountCode: "1600",
        liabilityAccountCode: "2600",
        expenseAccountCode: "7400",
      },
      {
        bookCode: "US_TAX",
        classification: "TAX_CASH_BASIS",
        expenseAccountCode: "7400",
      },
    ],
  });
  console.log("  ✓ lease record created (3 book-attributes rows; ASC 842 operating vs cash-basis tax)");
}

// ---- Journal entries (Pattern 2 parallel posting) ----------------------

async function seedFoundingEntries() {
  console.log("Posting founding entries (parallel to 3 books)...");

  await postToBooks(PARALLEL_BOOKS, {
    documentDate: new Date("2026-01-02"),
    memo: "Initial capitalization — founders contribute $500k seed",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 500_000, description: "Cash received" },
      { accountCode: "3000", credit: 1_000, description: "Common stock at par" },
      { accountCode: "3100", credit: 499_000, description: "Paid-in capital" },
    ],
  });

  // Laptop acquisition — same in all books (cost basis is uniform; the
  // book divergence is in depreciation, not acquisition).
  await postToBooks(PARALLEL_BOOKS, {
    documentDate: new Date("2026-01-05"),
    memo: "Purchase laptops for engineering team",
    source: "SEED",
    sourceRecordType: "AssetAcquisition",
    sourceRecordId: "LAPTOPS-2026-001",
    lines: [
      { accountCode: "1500", debit: 24_000, description: "8 MacBooks @ $3,000" },
      { accountCode: "1000", credit: 24_000 },
    ],
  });

  await postToBooks(PARALLEL_BOOKS, {
    documentDate: new Date("2026-01-15"),
    memo: "Annual prepayment for office G&A insurance",
    source: "SEED",
    lines: [
      { accountCode: "1400", debit: 12_000 },
      { accountCode: "1000", credit: 12_000 },
    ],
  });
}

async function seedRecurringMonthlyEntries() {
  console.log("Posting recurring monthly entries (payroll, SaaS, marketing, hosting, prepaid amortization)...");

  for (const m of MONTH_ENDS) {
    const docDate = new Date(m.date);
    await postToBooks(PARALLEL_BOOKS, {
      documentDate: docDate,
      memo: `${m.label} payroll`,
      source: "SEED",
      lines: [
        { accountCode: "6000", debit: 80_000, description: "Gross salaries" },
        { accountCode: "6100", debit: 6_400, description: "Employer payroll taxes" },
        { accountCode: "6200", debit: 8_000, description: "Health & benefits" },
        { accountCode: "1010", credit: 94_400, description: "Net cash out" },
      ],
    });

    await postToBooks(PARALLEL_BOOKS, {
      documentDate: docDate,
      memo: `${m.label} SaaS subscriptions`,
      source: "SEED",
      lines: [
        { accountCode: "7000", debit: 4_500 },
        { accountCode: "1000", credit: 4_500 },
      ],
    });

    await postToBooks(PARALLEL_BOOKS, {
      documentDate: docDate,
      memo: `${m.label} marketing spend`,
      source: "SEED",
      lines: [
        { accountCode: "7100", debit: 7_500 },
        { accountCode: "1000", credit: 7_500 },
      ],
    });

    await postToBooks(PARALLEL_BOOKS, {
      documentDate: docDate,
      memo: `${m.label} AWS hosting`,
      source: "SEED",
      lines: [
        { accountCode: "5000", debit: 3_200 },
        { accountCode: "1000", credit: 3_200 },
      ],
    });

    await postToBooks(PARALLEL_BOOKS, {
      documentDate: docDate,
      memo: `${m.label} prepaid insurance amortization`,
      source: "SEED",
      lines: [
        { accountCode: "7300", debit: 1_000 },
        { accountCode: "1400", credit: 1_000 },
      ],
    });
  }
}

async function seedAcmeArCycle() {
  console.log("Posting Acme invoices + payments + opening/applying AR items per book...");

  // Monthly Acme invoice ($5k each) → opens AR open item per book.
  const acmeInvoices: Record<string, { entryId: string; openItemIds: Record<string, string> }> = {};
  for (const m of MONTH_ENDS) {
    const docDate = new Date(m.date);
    const refNum = `INV-ACME-${m.label.toUpperCase()}`;
    const dueDate = new Date(docDate);
    dueDate.setUTCDate(dueDate.getUTCDate() + 30);

    const results = await postToBooks(PARALLEL_BOOKS, {
      documentDate: docDate,
      memo: `${m.label} invoice — Acme Corp`,
      source: "SEED",
      sourceRecordType: "Invoice",
      sourceRecordId: refNum,
      lines: [
        { accountCode: "1200", debit: 5_000, partyCode: "ACME", description: "Acme Corp AR" },
        { accountCode: "4000", credit: 5_000, description: "Acme subscription revenue" },
      ],
    });

    acmeInvoices[m.label] = { entryId: "", openItemIds: {} };
    for (const r of results) {
      const item = await openArItem(prisma, {
        entityCode: ENTITY_CODE,
        bookCode: r.bookCode,
        partyCode: "ACME",
        openedByEntryId: r.id,
        referenceNumber: refNum,
        openedDate: docDate,
        dueDate,
        amount: 5_000,
        currencyCode: "USD",
        controlAccountCode: "1200",
        sourceSystem: undefined,
        sourceRecordType: "Invoice",
        sourceRecordId: refNum,
      });
      acmeInvoices[m.label].openItemIds[r.bookCode] = item.id;
    }
  }

  // Collections: Acme pays Jan invoice on Feb 15, Feb on Mar 15, Mar on Apr 15.
  for (const [collectDateStr, invoiceMonth, memo] of [
    ["2026-02-15", "Jan", "Acme Corp pays January invoice"],
    ["2026-03-15", "Feb", "Acme Corp pays February invoice"],
    ["2026-04-15", "Mar", "Acme Corp pays March invoice"],
  ] as const) {
    const collectDate = new Date(collectDateStr);
    const paymentResults = await postToBooks(PARALLEL_BOOKS, {
      documentDate: collectDate,
      memo,
      source: "SEED",
      sourceRecordType: "Payment",
      sourceRecordId: `PMT-ACME-${invoiceMonth}`,
      lines: [
        { accountCode: "1000", debit: 5_000 },
        { accountCode: "1200", credit: 5_000, partyCode: "ACME" },
      ],
    });
    for (const r of paymentResults) {
      const itemId = acmeInvoices[invoiceMonth].openItemIds[r.bookCode];
      await applyArPayment(prisma, {
        openItemId: itemId,
        appliedByEntryId: r.id,
        appliedAmount: 5_000,
        appliedDate: collectDate,
      });
    }
  }
}

async function seedSmithCoApCycle() {
  console.log("Posting Smith & Co bill + payment + opening/applying AP items per book...");

  // Bill: 2026-04-10, $8,500
  const billResults = await postToBooks(PARALLEL_BOOKS, {
    documentDate: new Date("2026-04-10"),
    memo: "Professional fees — legal review, billed",
    source: "SEED",
    sourceRecordType: "Bill",
    sourceRecordId: "BILL-SMITH-001",
    lines: [
      { accountCode: "7200", debit: 8_500 },
      {
        accountCode: "2000",
        credit: 8_500,
        partyCode: "SMITH_CO",
        description: "Vendor: Smith & Co",
      },
    ],
  });
  const dueDate = new Date("2026-05-10");
  const apItemIdsByBook: Record<string, string> = {};
  for (const r of billResults) {
    const item = await openApItem(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: r.bookCode,
      partyCode: "SMITH_CO",
      openedByEntryId: r.id,
      referenceNumber: "BILL-SMITH-001",
      openedDate: new Date("2026-04-10"),
      dueDate,
      amount: 8_500,
      currencyCode: "USD",
      controlAccountCode: "2000",
      sourceRecordType: "Bill",
      sourceRecordId: "BILL-SMITH-001",
    });
    apItemIdsByBook[r.bookCode] = item.id;
  }

  // Payment: 2026-05-10
  const payResults = await postToBooks(PARALLEL_BOOKS, {
    documentDate: new Date("2026-05-10"),
    memo: "Smith & Co — pay legal invoice",
    source: "SEED",
    sourceRecordType: "VendorPayment",
    sourceRecordId: "VPMT-SMITH-001",
    lines: [
      { accountCode: "2000", debit: 8_500, partyCode: "SMITH_CO" },
      { accountCode: "1000", credit: 8_500 },
    ],
  });
  for (const r of payResults) {
    await applyApPayment(prisma, {
      openItemId: apItemIdsByBook[r.bookCode],
      appliedByEntryId: r.id,
      appliedAmount: 8_500,
      appliedDate: new Date("2026-05-10"),
    });
  }
}

async function seedGlobexPrepayAndRecognition() {
  console.log("Posting Globex prepayment with book-divergent treatment...");

  // Cash receipt — accrual books defer, cash-basis book recognizes immediately.
  // We post to ACCRUAL books with Dr Cash, Cr Deferred Revenue. To CASH book
  // we post Dr Cash, Cr Revenue directly. Pattern 2 — divergent line treatment
  // per book.
  for (const bookCode of ["US_GAAP", "IFRS"]) {
    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode,
      documentDate: new Date("2026-03-01"),
      memo: "Globex prepays annual contract — $60k (deferred)",
      source: "SEED",
      sourceRecordType: "Payment",
      sourceRecordId: "PMT-GLOBEX-PREPAY",
      lines: [
        { accountCode: "1000", debit: 60_000 },
        {
          accountCode: "2200",
          credit: 60_000,
          partyCode: "GLOBEX",
          description: "Deferred revenue — Globex contract",
        },
      ],
    });
  }
  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_TAX",
    documentDate: new Date("2026-03-01"),
    memo: "Globex prepays annual contract — $60k (cash-basis recognition)",
    source: "SEED",
    sourceRecordType: "Payment",
    sourceRecordId: "PMT-GLOBEX-PREPAY",
    lines: [
      { accountCode: "1000", debit: 60_000 },
      {
        accountCode: "4000",
        credit: 60_000,
        partyCode: "GLOBEX",
        description: "Globex subscription revenue (cash basis)",
      },
    ],
  });
}

// ---- Period-end runners (depreciation, recognition, lease) -------------

async function runMonthEndRunners() {
  console.log("Running depreciation + revenue recognition + lease amortization at each month-end...");
  for (const m of MONTH_ENDS) {
    const throughDate = new Date(m.date);
    for (const bookCode of PARALLEL_BOOKS) {
      // Depreciation diverges per book (3 different useful lives).
      await runDepreciation(prisma, {
        entityCode: ENTITY_CODE,
        bookCode,
        throughDate,
        source: "SEED",
      });
      // Revenue recognition runs ONLY for accrual books; cash-basis book
      // recognized the $60k Globex prepay all at once on 2026-03-01.
      if ((ACCRUAL_BOOKS as readonly string[]).includes(bookCode)) {
        await runStraightLineRecognition(prisma, {
          entityCode: ENTITY_CODE,
          bookCode,
          throughDate,
          source: "SEED",
        });
      }
      // Lease accounting — ASC 842 operating for GAAP/IFRS, cash basis for TAX.
      await runLeaseAccounting(prisma, {
        entityCode: ENTITY_CODE,
        bookCode,
        throughDate,
        source: "SEED",
        cashAccountCode: "1000",
      });
    }
  }
}

// ---- Main --------------------------------------------------------------

async function main() {
  await seedMasterData();
  await seedAccounts();
  await seedParties();
  await setupFixedAssets();
  await setupRevenueContract();
  await setupLease();
  await seedFoundingEntries();
  await seedRecurringMonthlyEntries();
  await seedAcmeArCycle();
  await seedSmithCoApCycle();
  await seedGlobexPrepayAndRecognition();
  await runMonthEndRunners();

  const entryCount = await prisma.journalEntry.count();
  const arOpen = await prisma.arOpenItem.count({ where: { status: { in: ["OPEN", "PARTIAL"] } } });
  const apOpen = await prisma.apOpenItem.count({ where: { status: { in: ["OPEN", "PARTIAL"] } } });
  const assetCount = await prisma.fixedAsset.count();
  console.log(
    `\nDone.\n` +
      `  ${entryCount} journal entries (across 3 books)\n` +
      `  ${arOpen} open AR items, ${apOpen} open AP items\n` +
      `  ${assetCount} fixed asset(s)\n`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
