// Northwind Cloud seed — exported as a module so both the CLI seed script
// (prisma/seed.ts) and the demo-reset API endpoint can share the same code
// path. Each helper takes the PrismaClient as a parameter; the orchestrator
// is `seedNorthwind(prisma)`.
//
// The reset helper (`resetNorthwindData`) deletes only the NORTHWIND-scoped
// transactional + sub-ledger data, leaving currencies, books, and master
// reference data intact. Re-seeding is then idempotent on the master rows
// (upserts) and fresh for the transactional rows.

import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "../accounting/post-journal";
import { CHART_OF_ACCOUNTS } from "../db/chart-of-accounts";
import { openArItem, applyArPayment } from "../accounting/sub-ledgers/ar";
import { openApItem, applyApPayment } from "../accounting/sub-ledgers/ap";
import { getDefaultTenantId } from "./default-tenant";
import {
  createFixedAsset,
  runDepreciation,
} from "../accounting/sub-ledgers/fixed-assets";
import {
  createRevenueContract,
  runStraightLineRecognition,
} from "../accounting/sub-ledgers/revenue-contracts";
import { createLease, runLeaseAccounting } from "../accounting/sub-ledgers/leases";

export const ENTITY_CODE = "NORTHWIND";
const FISCAL_CALENDAR_CODE = "STANDARD_2026";
const PARALLEL_BOOKS = ["US_GAAP", "US_TAX", "IFRS"] as const;
const ACCRUAL_BOOKS = ["US_GAAP", "IFRS"] as const;

const MONTH_ENDS = [
  { date: "2026-01-31", label: "Jan" },
  { date: "2026-02-28", label: "Feb" },
  { date: "2026-03-31", label: "Mar" },
  { date: "2026-04-30", label: "Apr" },
  { date: "2026-05-31", label: "May" },
  { date: "2026-06-30", label: "Jun" },
];

type EntryShape = Omit<Parameters<typeof postJournalEntry>[1], "entityCode" | "bookCode">;

function postToBooksFactory(prisma: PrismaClient) {
  return async function postToBooks(
    books: readonly string[],
    base: EntryShape
  ): Promise<{ bookCode: string; id: string; entryNumber: string }[]> {
    const results: { bookCode: string; id: string; entryNumber: string }[] = [];
    for (const bookCode of books) {
      const input = Object.assign({}, base, { entityCode: ENTITY_CODE, bookCode });
      const r = await postJournalEntry(prisma, input);
      results.push({ bookCode, id: r.id, entryNumber: r.entryNumber });
    }
    return results;
  };
}

// ---- Master data ----------------------------------------------------

async function seedMasterData(prisma: PrismaClient) {
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
  await prisma.currency.upsert({
    where: { code: "GBP" },
    create: { code: "GBP", name: "Pound Sterling", decimals: 2, symbol: "£" },
    update: {},
  });

  // FX rate baseline for the v0.8 FX translation arc (Phase 1.5).
  // One asOf date covering all of 2026 demo activity — operators with
  // real daily rates would seed many more rows. Rates picked to
  // approximate 2026 market conditions:
  //   1 GBP = 1.27 USD  (UK pound to dollar)
  //   1 EUR = 1.05 USD  (euro to dollar)
  // BOTH DIRECTIONS seeded so the importer's straight lookup (no
  // auto-inversion per the design) succeeds whichever way the
  // transaction flows. See docs/fx-translation-design.md.
  const fxRates = [
    { from: "GBP", to: "USD", rate: "1.2700" },
    { from: "USD", to: "GBP", rate: "0.7874" }, // = 1/1.27 to 4 dp
    { from: "EUR", to: "USD", rate: "1.0500" },
    { from: "USD", to: "EUR", rate: "0.9524" }, // = 1/1.05 to 4 dp
  ];
  const fxAsOf = new Date("2026-01-01");
  for (const r of fxRates) {
    // Composite unique on (from, to, asOf, rateType) — upsert idempotent.
    await prisma.fxRate.upsert({
      where: {
        fromCurrencyId_toCurrencyId_asOf_rateType: {
          fromCurrencyId: r.from,
          toCurrencyId: r.to,
          asOf: fxAsOf,
          rateType: "SPOT",
        },
      },
      create: {
        fromCurrencyId: r.from,
        toCurrencyId: r.to,
        asOf: fxAsOf,
        rate: r.rate,
        rateType: "SPOT",
      },
      update: { rate: r.rate },
    });
  }

  // Multi-tenancy: every entity belongs to a Tenant. Seeds belong to
  // the migration-created "default" tenant (the single-tenant fallback
  // for non-multi-tenant deployments).
  const tenantId = await getDefaultTenantId(prisma);
  // Phase 4b: legalEntity.code unique per [tenantId, code]; composite upsert.
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY_CODE } },
    create: {
      tenantId,
      code: ENTITY_CODE,
      name: "Northwind Cloud, Inc.",
      functionalCurrencyId: "USD",
    },
    update: { tenantId }, // backfill for any pre-migration row
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
      tenantId: entity.tenantId,
      entityId: entity.id,
      code: FISCAL_CALENDAR_CODE,
      name: "Standard 2026 Calendar",
      periodFrequency: "MONTHLY",
    },
    update: { tenantId: entity.tenantId },
  });

  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        tenantId: entity.tenantId,
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: { tenantId: entity.tenantId },
    });
  }
}

async function seedAccounts(prisma: PrismaClient) {
  // Shared-chart accounts (entityId=null). Prisma 5.22 rejects null in
  // compound unique-key upsert, so use findFirst + create pattern.
  const tenantId = await getDefaultTenantId(prisma);
  for (const acct of CHART_OF_ACCOUNTS) {
    const existing = await prisma.account.findFirst({
      where: { entityId: null, code: acct.code },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.account.create({
      data: {
        tenantId,
        code: acct.code,
        name: acct.name,
        type: acct.type,
        normalBalance: acct.normalBalance,
        isContra: acct.isContra ?? false,
        isControlAccount: acct.isControlAccount ?? false,
        isBank: acct.isBank ?? false,
        subtype: acct.subtype,
      },
    });
  }
}

async function seedParties(prisma: PrismaClient) {
  // Phase 4b: entity code unique per [tenantId, code]; findFirst.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: ENTITY_CODE },
    select: { id: true, tenantId: true },
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
        tenantId: entity.tenantId,
        entityId: entity.id,
        code: p.code,
        displayName: p.displayName,
      },
      update: { tenantId: entity.tenantId },
    });
    await prisma.partyRole.upsert({
      where: { partyId_role: { partyId: party.id, role: p.role } },
      create: { tenantId: entity.tenantId, partyId: party.id, role: p.role },
      update: { tenantId: entity.tenantId },
    });
  }
}

// ---- Sub-ledger setup ----------------------------------------------

async function setupFixedAssets(prisma: PrismaClient) {
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
}

async function setupRevenueContract(prisma: PrismaClient) {
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
}

async function setupLease(prisma: PrismaClient) {
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
}

// ---- Transactions --------------------------------------------------

async function seedFoundingEntries(prisma: PrismaClient) {
  const postToBooks = postToBooksFactory(prisma);

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

async function seedRecurringMonthlyEntries(prisma: PrismaClient) {
  const postToBooks = postToBooksFactory(prisma);

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

async function seedAcmeArCycle(prisma: PrismaClient) {
  const postToBooks = postToBooksFactory(prisma);

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

async function seedSmithCoApCycle(prisma: PrismaClient) {
  const postToBooks = postToBooksFactory(prisma);

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

async function seedGlobexPrepayAndRecognition(prisma: PrismaClient) {
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

async function runMonthEndRunners(prisma: PrismaClient) {
  for (const m of MONTH_ENDS) {
    const throughDate = new Date(m.date);
    for (const bookCode of PARALLEL_BOOKS) {
      await runDepreciation(prisma, {
        entityCode: ENTITY_CODE,
        bookCode,
        throughDate,
        source: "SEED",
      });
      if ((ACCRUAL_BOOKS as readonly string[]).includes(bookCode)) {
        await runStraightLineRecognition(prisma, {
          entityCode: ENTITY_CODE,
          bookCode,
          throughDate,
          source: "SEED",
        });
      }
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

// ---- Public entry points -------------------------------------------

export async function seedNorthwind(prisma: PrismaClient): Promise<void> {
  // Make the seed re-runnable: wipe Northwind's per-entity rows that
  // would collide with idempotent creates. Tests in v1.x sometimes
  // partial-wipe Northwind (delete JEs but leave fixed_asset /
  // revenue_contract / lease) — re-seeding then trips P2002 on the
  // (entityId, code) unique constraint. Clearing the same set here
  // makes db:seed a true reset for NORTHWIND.
  // Phase 4b: entity code unique per [tenantId, code]; findFirst.
  const existing = await prisma.legalEntity.findFirst({
    where: { code: ENTITY_CODE },
    select: { id: true },
  });
  if (existing) {
    const eid = existing.id;
    // Order: dependents before parents (no cascade in the schema).
    await prisma.arApplication.deleteMany({ where: { openItem: { entityId: eid } } });
    await prisma.apApplication.deleteMany({ where: { openItem: { entityId: eid } } });
    await prisma.arOpenItem.deleteMany({ where: { entityId: eid } });
    await prisma.apOpenItem.deleteMany({ where: { entityId: eid } });
    await prisma.fixedAssetBookAttributes.deleteMany({
      where: { asset: { entityId: eid } },
    });
    await prisma.fixedAsset.deleteMany({ where: { entityId: eid } });
    await prisma.leaseBookAttributes.deleteMany({
      where: { lease: { entityId: eid } },
    });
    await prisma.lease.deleteMany({ where: { entityId: eid } });
    await prisma.revenueContractBookAttributes.deleteMany({
      where: { contract: { entityId: eid } },
    });
    await prisma.performanceObligation.deleteMany({
      where: { contract: { entityId: eid } },
    });
    await prisma.revenueContract.deleteMany({ where: { entityId: eid } });
    await prisma.journalLine.deleteMany({
      where: { entry: { entityId: eid } },
    });
    await prisma.journalEntry.deleteMany({ where: { entityId: eid } });
    await prisma.periodClose.deleteMany({ where: { entityId: eid } });
  }

  await seedMasterData(prisma);
  await seedAccounts(prisma);
  await seedParties(prisma);
  await seedTestUsersAndQueues(prisma);
  // Rules must be seeded BEFORE the AR cycle so they fire on each
  // ON_INSERT during AR item creation.
  await seedReassignmentRules(prisma);
  await setupFixedAssets(prisma);
  await setupRevenueContract(prisma);
  await setupLease(prisma);
  await seedFoundingEntries(prisma);
  await seedRecurringMonthlyEntries(prisma);
  await seedAcmeArCycle(prisma);
  await seedGlobexUnpaidArInvoice(prisma);
  await seedSmithCoApCycle(prisma);
  await seedGlobexPrepayAndRecognition(prisma);
  await runMonthEndRunners(prisma);
}

// Test users + queues for the v1.5 ownership UI. Idempotent — upserts by
// email / code. Production replaces this with a real user-provisioning
// flow (NextAuth JIT, WorkOS SSO, etc.).
//
// The four roles here cover the typical small-firm accounting org:
//   - Controller: full authority, can close periods, approves everything
//   - GL Accountant: posts JEs, runs reports
//   - AR Clerk: works open AR items, applies payments, collections
//   - External Auditor: read-only with time-bounded access (modeled by
//     a deactivation date set in a future commit when the role-grants
//     subsystem lands; for now the user just exists)
//
// Queues represent functional teams that records can be assigned to. Used
// by reassignment rules ("escalate to senior collectors" → senior queue).
export async function seedTestUsersAndQueues(
  prisma: PrismaClient
): Promise<void> {
  // ─── Users ────────────────────────────────────────────────────────────────
  const userSpecs = [
    { email: "controller@northwind.test", displayName: "Carla Controller" },
    { email: "gl@northwind.test", displayName: "Greg GL Accountant" },
    { email: "ar-clerk@northwind.test", displayName: "Anna AR Clerk" },
    { email: "auditor@deloitte.test", displayName: "Devon Auditor (Deloitte)" },
  ];
  for (const spec of userSpecs) {
    await prisma.user.upsert({
      where: { email: spec.email },
      create: spec,
      update: { displayName: spec.displayName, isActive: true },
    });
  }

  // ─── Queues ───────────────────────────────────────────────────────────────
  const queueSpecs = [
    {
      code: "AR_COLLECTIONS",
      name: "AR Collections",
      description: "Standard AR collection queue — 0–60 days overdue",
      isUnassignedFallback: false,
    },
    {
      code: "AR_SENIOR_COLLECTORS",
      name: "AR Senior Collectors",
      description: "Escalation queue — 60+ days overdue, senior staff only",
      isUnassignedFallback: false,
    },
    {
      code: "AR_UNASSIGNED",
      name: "AR Unassigned",
      description: "Fallback queue for orphaned AR items",
      isUnassignedFallback: true,
    },
    {
      code: "GL_APPROVAL",
      name: "GL Approval",
      description: "JEs awaiting controller sign-off",
      isUnassignedFallback: false,
    },
    {
      code: "GL_UNASSIGNED",
      name: "GL Unassigned",
      description: "Fallback queue for orphaned JE records",
      isUnassignedFallback: true,
    },
  ];
  const tenantIdForQueues = await getDefaultTenantId(prisma);
  for (const spec of queueSpecs) {
    // Phase 4b: queue.code unique per [tenantId, code]; composite upsert.
    await prisma.queue.upsert({
      where: { tenantId_code: { tenantId: tenantIdForQueues, code: spec.code } },
      create: { tenantId: tenantIdForQueues, ...spec },
      update: {
        tenantId: tenantIdForQueues,
        name: spec.name,
        description: spec.description,
        isUnassignedFallback: spec.isUnassignedFallback,
        isActive: true,
        deletedAt: null,
      },
    });
  }

  // ─── Queue memberships ────────────────────────────────────────────────────
  // AR Clerk works the standard collections queue.
  // Controller is in the senior queue (escalations land on their desk).
  // GL Accountant is NOT in any AR queue.
  const memberships = [
    { userEmail: "ar-clerk@northwind.test", queueCode: "AR_COLLECTIONS" },
    { userEmail: "controller@northwind.test", queueCode: "AR_SENIOR_COLLECTORS" },
    { userEmail: "controller@northwind.test", queueCode: "GL_APPROVAL" },
    { userEmail: "gl@northwind.test", queueCode: "GL_APPROVAL" },
  ];
  for (const m of memberships) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: m.userEmail },
      select: { id: true },
    });
    // Phase 4b: queue.code unique per [tenantId, code]; findFirst.
    const queue = await prisma.queue.findFirstOrThrow({
      where: { code: m.queueCode },
      select: { id: true },
    });
    await prisma.queueMember.upsert({
      where: { queueId_userId: { queueId: queue.id, userId: user.id } },
      create: { queueId: queue.id, userId: user.id },
      update: {},
    });
  }
}

// Two example reassignment rules for AR open items. Demonstrates the
// cascade-by-priority semantics:
//
//   Priority 100 — large-balance escalation: items where currentBalance
//     > $10,000 route to AR_SENIOR_COLLECTORS. Senior staff handle the
//     significant exposures.
//
//   Priority 999 — catch-all default: everything else routes to
//     AR_COLLECTIONS (the standard team queue).
//
// First-match-wins: the engine evaluates rules in priority order; a
// matching rule's target is used and subsequent rules are skipped.
//
// To see both rules fire in the demo seed: Acme's monthly $5K invoices
// land in AR_COLLECTIONS (catch-all only), and Globex's single $25K
// invoice (seeded below) escalates to AR_SENIOR_COLLECTORS.
//
// Idempotent via the unique (ruleId, ruleVersion) constraint.
export async function seedReassignmentRules(
  prisma: PrismaClient
): Promise<void> {
  // Phase 4b: queue.code unique per [tenantId, code]; findFirst.
  const arSenior = await prisma.queue.findFirstOrThrow({
    where: { code: "AR_SENIOR_COLLECTORS" },
    select: { id: true },
  });
  const arCollections = await prisma.queue.findFirstOrThrow({
    where: { code: "AR_COLLECTIONS" },
    select: { id: true },
  });
  const glApproval = await prisma.queue.findFirstOrThrow({
    where: { code: "GL_APPROVAL" },
    select: { id: true },
  });
  const glUnassigned = await prisma.queue.findFirstOrThrow({
    where: { code: "GL_UNASSIGNED" },
    select: { id: true },
  });

  const specs = [
    // ─── AR rules (from v1.6) ────────────────────────────────────────────
    {
      ruleId: "ar-large-balance-to-senior",
      ruleVersion: 1,
      recordType: "ArOpenItem",
      trigger: "ON_INSERT" as const,
      priority: 100,
      ruleType: "DECLARATIVE" as const,
      criteriaJson: {
        field: "currentBalance",
        op: "GT",
        value: 10000,
      },
      targetType: "QUEUE" as const,
      targetId: arSenior.id,
      isActive: true,
      authoredBy: "seed",
    },
    {
      ruleId: "ar-default-routing",
      ruleVersion: 1,
      recordType: "ArOpenItem",
      trigger: "ON_INSERT" as const,
      priority: 999,
      ruleType: "DECLARATIVE" as const,
      criteriaJson: { op: "AND", clauses: [] },
      targetType: "QUEUE" as const,
      targetId: arCollections.id,
      isActive: true,
      authoredBy: "seed",
    },
    // ─── JE rules (new in v1.9) ──────────────────────────────────────────
    // Large-amount JEs route to the controller approval queue. The
    // "totalDebits" field is computed by postJournalEntry at fire time
    // (sum of all line debits) — used to gate big entries on review.
    {
      ruleId: "je-large-amount-to-controller",
      ruleVersion: 1,
      recordType: "JournalEntry",
      trigger: "ON_INSERT" as const,
      priority: 100,
      ruleType: "DECLARATIVE" as const,
      criteriaJson: {
        field: "totalDebits",
        op: "GT",
        value: 50000,
      },
      targetType: "QUEUE" as const,
      targetId: glApproval.id,
      isActive: true,
      authoredBy: "seed",
    },
    // Catch-all: any JE that didn't match a higher-priority rule lands
    // in GL_UNASSIGNED. This means the engine NEVER leaves a JE owner-
    // less when ownerUserId was set — there's always somewhere for the
    // entry to land for human review.
    {
      ruleId: "je-default-routing",
      ruleVersion: 1,
      recordType: "JournalEntry",
      trigger: "ON_INSERT" as const,
      priority: 999,
      ruleType: "DECLARATIVE" as const,
      criteriaJson: { op: "AND", clauses: [] },
      targetType: "QUEUE" as const,
      targetId: glUnassigned.id,
      isActive: true,
      authoredBy: "seed",
    },
    // ─── AP rules (new in v1.9) ──────────────────────────────────────────
    // No AP-specific queues exist yet; AP items route to GL_UNASSIGNED as
    // a starting point. Real firms add an AP_INVOICES + AP_APPROVAL pair.
    {
      ruleId: "ap-default-routing",
      ruleVersion: 1,
      recordType: "ApOpenItem",
      trigger: "ON_INSERT" as const,
      priority: 999,
      ruleType: "DECLARATIVE" as const,
      criteriaJson: { op: "AND", clauses: [] },
      targetType: "QUEUE" as const,
      targetId: glUnassigned.id,
      isActive: true,
      authoredBy: "seed",
    },
  ];

  const tenantIdForRules = await getDefaultTenantId(prisma);
  for (const spec of specs) {
    await prisma.reassignmentRule.upsert({
      where: {
        ruleId_ruleVersion: { ruleId: spec.ruleId, ruleVersion: spec.ruleVersion },
      },
      create: { tenantId: tenantIdForRules, ...spec },
      update: {
        tenantId: tenantIdForRules,
        priority: spec.priority,
        criteriaJson: spec.criteriaJson,
        targetType: spec.targetType,
        targetId: spec.targetId,
        isActive: spec.isActive,
      },
    });
  }
}

// One large-balance AR invoice that demonstrates the priority-100 rule
// firing. Globex owes $25K from Q2 services; the rule escalates this
// to AR_SENIOR_COLLECTORS automatically on insert. Acme's $5K items
// from seedAcmeArCycle stay in AR_COLLECTIONS via the catch-all.
//
// Posted as a SEED entry across all parallel books (consistent with
// the multi-book discipline). Not paid in the seed window; remains
// OPEN through demo lifecycle.
async function seedGlobexUnpaidArInvoice(prisma: PrismaClient): Promise<void> {
  const postToBooks = postToBooksFactory(prisma);
  const docDate = new Date("2026-06-30");
  const dueDate = new Date("2026-07-30");
  const refNum = "INV-GLOBEX-2026-Q2";

  const results = await postToBooks(PARALLEL_BOOKS, {
    documentDate: docDate,
    memo: "Q2 services invoice — Globex Corporation",
    source: "SEED",
    sourceRecordType: "Invoice",
    sourceRecordId: refNum,
    lines: [
      { accountCode: "1200", debit: 25_000, partyCode: "GLOBEX", description: "Globex Q2 services AR" },
      { accountCode: "4000", credit: 25_000, description: "Globex Q2 services revenue" },
    ],
  });

  for (const r of results) {
    await openArItem(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: r.bookCode,
      partyCode: "GLOBEX",
      openedByEntryId: r.id,
      referenceNumber: refNum,
      openedDate: docDate,
      dueDate,
      amount: 25_000,
      currencyCode: "USD",
      controlAccountCode: "1200",
      sourceRecordType: "Invoice",
      sourceRecordId: refNum,
    });
  }
}

// Clears every NORTHWIND-scoped transactional + sub-ledger row, leaving
// currencies / books / calendar / periods (the master skeleton) in place
// so `seedNorthwind` can re-run idempotently against them.
//
// Deletion order matters because of FK relations. AR/AP applications
// reference open items reference journal entries; sub-ledger records
// reference entities; etc.
export async function resetNorthwindData(prisma: PrismaClient): Promise<void> {
  // Phase 4b: entity code unique per [tenantId, code]; findFirst.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: ENTITY_CODE },
    select: { id: true },
  });
  if (!entity) return;

  // AR / AP application audit trails (children of open items).
  await prisma.arApplication.deleteMany({
    where: { openItem: { entityId: entity.id } },
  });
  await prisma.apApplication.deleteMany({
    where: { openItem: { entityId: entity.id } },
  });

  // AR / AP open items themselves.
  await prisma.arOpenItem.deleteMany({ where: { entityId: entity.id } });
  await prisma.apOpenItem.deleteMany({ where: { entityId: entity.id } });

  // Journal entries (lines cascade via onDelete: Cascade).
  await prisma.journalEntry.deleteMany({ where: { entityId: entity.id } });

  // Sub-ledger detail records.
  await prisma.fixedAssetBookAttributes.deleteMany({
    where: { asset: { entityId: entity.id } },
  });
  await prisma.fixedAsset.deleteMany({ where: { entityId: entity.id } });

  await prisma.leaseBookAttributes.deleteMany({
    where: { lease: { entityId: entity.id } },
  });
  await prisma.lease.deleteMany({ where: { entityId: entity.id } });

  await prisma.revenueContractBookAttributes.deleteMany({
    where: { contract: { entityId: entity.id } },
  });
  await prisma.performanceObligation.deleteMany({
    where: { contract: { entityId: entity.id } },
  });
  await prisma.revenueContract.deleteMany({ where: { entityId: entity.id } });

  // Parties + items scoped to NORTHWIND (imported parties under other
  // entities like QBO_DEMO are untouched).
  await prisma.partyRole.deleteMany({
    where: { party: { entityId: entity.id } },
  });
  await prisma.party.deleteMany({ where: { entityId: entity.id } });
  await prisma.item.deleteMany({ where: { entityId: entity.id } });

  // Period close locks.
  await prisma.periodClose.deleteMany({ where: { entityId: entity.id } });

  // Ownership audit log + reassignment rules. Users + queues survive
  // resets because they're org-level, not entity-scoped.
  await prisma.recordEvent.deleteMany({});
  await prisma.reassignmentRule.deleteMany({});
}

export async function resetAndReseedNorthwind(prisma: PrismaClient): Promise<{
  cleared: boolean;
  entriesAfter: number;
}> {
  await resetNorthwindData(prisma);
  await seedNorthwind(prisma);
  const entriesAfter = await prisma.journalEntry.count({
    where: { entity: { code: ENTITY_CODE } },
  });
  return { cleared: true, entriesAfter };
}
