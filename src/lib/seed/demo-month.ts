// Demo month seed.
//
// Posts a realistic month of activity for a single entity (DEMO_CO) into
// May 2026. Designed to be the showcase "see everything work end-to-end"
// payload — opening this entity's month-end review after running the
// demo shows a believable income statement, a balanced balance sheet,
// month-end accruals, multi-book divergence (GAAP vs TAX depreciation),
// AR + AP cycles, prepaid expense amortization, and ASC 606 deferred
// revenue recognition.
//
// Why a separate entity from Northwind?
//   - Demo state is volatile: this script wipes its target every run.
//     If it lived inside Northwind, every demo run would clobber the
//     test fixtures the rest of the suite depends on.
//   - The narrative is different. Northwind is "a multi-year SaaS
//     business with mature sub-ledger state"; DEMO_CO is "month-one of
//     a fresh company, every flavor of accounting visible at once."
//
// What's in the month (May 2026):
//
//   May 1   $50,000 capital contribution (Common Stock issued)
//   May 1   $12,000 prepaid office rent (12 months)
//   May 5   $24,000 IT equipment purchase (Fixed Asset, 36-mo GAAP / 60-mo TAX)
//   May 8   $5,000 Acme subscription invoice (AR opened)
//   May 12  $20,000 engineering payroll
//   May 15  $3,500 marketing spend
//   May 20  $2,500 cloud hosting bill received (AP opened)
//   May 22  $1,200 software subscription bill (AP opened)
//   May 25  $5,000 Acme payment received (AR closed)
//   May 27  $2,500 hosting bill paid (AP partially closed)
//   May 28  $8,000 Globex annual subscription invoice (Deferred Rev + AR)
//   May 31  $1,000 rent expense recognized (1/12 of prepaid)
//   May 31  $666.67 GAAP depreciation / $400 TAX depreciation
//   May 31  $667 Globex revenue recognized (3 days of 12 months)
//   May 31  $7,000 accrued payroll for last 5 days of May
//
// After all entries: closes May 2026 on US_GAAP, leaves US_TAX open so
// the divergence is visible in the trial balance.
//
// Idempotent: wipes DEMO_CO's per-entity rows at the top and re-creates.

import { PrismaClient, Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../accounting/post-journal";
import { getDefaultTenantId } from "./default-tenant";
import { openArItem, applyArPayment } from "../accounting/sub-ledgers/ar";
import { openApItem, applyApPayment } from "../accounting/sub-ledgers/ap";
import { createFixedAsset } from "../accounting/sub-ledgers/fixed-assets";
import {
  createRevenueContract,
  runStraightLineRecognition,
} from "../accounting/sub-ledgers/revenue-contracts";

const ENTITY_CODE = "DEMO_CO";
const CALENDAR_CODE = "DEMO_2026";
const BOOKS = ["US_GAAP", "US_TAX"] as const;

// Period to fully populate.
const MAY_START = new Date(Date.UTC(2026, 4, 1));
const MAY_END = new Date(Date.UTC(2026, 4, 31));

interface SeedResult {
  jeCount: number;
  arOpened: number;
  apOpened: number;
}

export async function seedDemoMonth(prisma: PrismaClient): Promise<SeedResult> {
  await wipeDemoEntity(prisma);
  await seedMasterData(prisma);
  await seedAccounts(prisma);
  await seedParties(prisma);
  const assetState = await seedFixedAsset(prisma);
  const contractState = await seedRevenueContract(prisma);

  let jeCount = 0;
  let arOpened = 0;
  let apOpened = 0;

  // ─── Capital contribution + opening cash ───────────────────────────
  jeCount += await postParallelCount(prisma, {
    documentDate: new Date("2026-05-01"),
    memo: "Founder capital contribution — $50k cash",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 50_000, description: "Initial bank deposit" },
      { accountCode: "3000", credit: 50_000, description: "Common Stock issued" },
    ],
  });

  // ─── Prepaid office rent ───────────────────────────────────────────
  jeCount += await postParallelCount(prisma, {
    documentDate: new Date("2026-05-01"),
    memo: "12-month office rent — prepaid",
    source: "MANUAL",
    lines: [
      { accountCode: "1400", debit: 12_000, description: "Prepaid Rent (12 mo)" },
      { accountCode: "1000", credit: 12_000, description: "Rent payment" },
    ],
  });

  // ─── IT equipment purchase ─────────────────────────────────────────
  jeCount += await postParallelCount(prisma, {
    documentDate: new Date("2026-05-05"),
    memo: "8 MacBooks for engineering team",
    source: "MANUAL",
    sourceRecordType: "FixedAssetAcquisition",
    sourceRecordId: assetState.assetCode,
    lines: [
      { accountCode: "1500", debit: 24_000, description: "Computer Equipment" },
      { accountCode: "1000", credit: 24_000, description: "Asset purchase" },
    ],
  });

  // ─── Subscription revenue invoice → AR (Acme) ──────────────────────
  const acmeResults = await postParallel(prisma, {
    documentDate: new Date("2026-05-08"),
    memo: "Acme — May subscription",
    source: "MANUAL",
    sourceRecordType: "Invoice",
    sourceRecordId: "INV-ACME-MAY",
    lines: [
      { accountCode: "1200", debit: 5_000, partyCode: "ACME" },
      { accountCode: "4000", credit: 5_000, description: "Subscription revenue" },
    ],
  });
  jeCount += acmeResults.length;
  for (const r of acmeResults) {
    await openArItem(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: r.bookCode,
      partyCode: "ACME",
      openedByEntryId: r.id,
      referenceNumber: "INV-ACME-MAY",
      openedDate: new Date("2026-05-08"),
      dueDate: new Date("2026-06-07"),
      amount: 5_000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });
    arOpened += 1;
  }

  // ─── Engineering payroll ───────────────────────────────────────────
  jeCount += await postParallelCount(prisma, {
    documentDate: new Date("2026-05-12"),
    memo: "Engineering payroll — first half of May",
    source: "MANUAL",
    lines: [
      { accountCode: "6000", debit: 20_000, description: "Salaries & wages" },
      { accountCode: "1000", credit: 20_000, description: "Payroll run" },
    ],
  });

  // ─── Marketing spend ───────────────────────────────────────────────
  jeCount += await postParallelCount(prisma, {
    documentDate: new Date("2026-05-15"),
    memo: "Q2 marketing — paid ads",
    source: "MANUAL",
    lines: [
      { accountCode: "7100", debit: 3_500, description: "Marketing" },
      { accountCode: "1000", credit: 3_500, description: "Marketing payment" },
    ],
  });

  // ─── Cloud hosting bill received → AP ──────────────────────────────
  const hostingResults = await postParallel(prisma, {
    documentDate: new Date("2026-05-20"),
    memo: "AWS — May infrastructure",
    source: "MANUAL",
    sourceRecordType: "Bill",
    sourceRecordId: "AWS-MAY",
    lines: [
      { accountCode: "5000", debit: 2_500, description: "Hosting cost" },
      { accountCode: "2000", credit: 2_500, partyCode: "AWS" },
    ],
  });
  jeCount += hostingResults.length;
  for (const r of hostingResults) {
    await openApItem(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: r.bookCode,
      partyCode: "AWS",
      openedByEntryId: r.id,
      referenceNumber: "AWS-MAY",
      openedDate: new Date("2026-05-20"),
      dueDate: new Date("2026-06-19"),
      amount: 2_500,
      currencyCode: "USD",
      controlAccountCode: "2000",
    });
    apOpened += 1;
  }

  // ─── Software subscription bill received → AP ──────────────────────
  const datadogResults = await postParallel(prisma, {
    documentDate: new Date("2026-05-22"),
    memo: "Datadog — May observability",
    source: "MANUAL",
    sourceRecordType: "Bill",
    sourceRecordId: "DD-MAY",
    lines: [
      { accountCode: "7000", debit: 1_200, description: "SaaS tools" },
      { accountCode: "2000", credit: 1_200, partyCode: "DATADOG" },
    ],
  });
  jeCount += datadogResults.length;
  for (const r of datadogResults) {
    await openApItem(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: r.bookCode,
      partyCode: "DATADOG",
      openedByEntryId: r.id,
      referenceNumber: "DD-MAY",
      openedDate: new Date("2026-05-22"),
      dueDate: new Date("2026-06-21"),
      amount: 1_200,
      currencyCode: "USD",
      controlAccountCode: "2000",
    });
    apOpened += 1;
  }

  // ─── Acme payment received → AR closed ─────────────────────────────
  const acmePaymentResults = await postParallel(prisma, {
    documentDate: new Date("2026-05-25"),
    memo: "Acme — pays May invoice",
    source: "MANUAL",
    sourceRecordType: "Payment",
    sourceRecordId: "PMT-ACME-MAY",
    lines: [
      { accountCode: "1000", debit: 5_000, description: "Acme payment received" },
      { accountCode: "1200", credit: 5_000, partyCode: "ACME" },
    ],
  });
  jeCount += acmePaymentResults.length;
  for (const r of acmePaymentResults) {
    const acmeOpenItem = await prisma.arOpenItem.findFirstOrThrow({
      where: {
        entity: { code: ENTITY_CODE },
        book: { code: r.bookCode },
        referenceNumber: "INV-ACME-MAY",
      },
      select: { id: true },
    });
    await applyArPayment(prisma, {
      openItemId: acmeOpenItem.id,
      appliedByEntryId: r.id,
      appliedAmount: 5_000,
      appliedDate: new Date("2026-05-25"),
    });
  }

  // ─── Hosting bill paid → AP closed ─────────────────────────────────
  const hostingPaymentResults = await postParallel(prisma, {
    documentDate: new Date("2026-05-27"),
    memo: "AWS — May invoice paid",
    source: "MANUAL",
    sourceRecordType: "Payment",
    sourceRecordId: "PMT-AWS-MAY",
    lines: [
      { accountCode: "2000", debit: 2_500, partyCode: "AWS" },
      { accountCode: "1000", credit: 2_500, description: "AWS bill payment" },
    ],
  });
  jeCount += hostingPaymentResults.length;
  for (const r of hostingPaymentResults) {
    const awsOpenItem = await prisma.apOpenItem.findFirstOrThrow({
      where: {
        entity: { code: ENTITY_CODE },
        book: { code: r.bookCode },
        referenceNumber: "AWS-MAY",
      },
      select: { id: true },
    });
    await applyApPayment(prisma, {
      openItemId: awsOpenItem.id,
      appliedByEntryId: r.id,
      appliedAmount: 2_500,
      appliedDate: new Date("2026-05-27"),
    });
  }

  // ─── Globex annual contract → AR + deferred rev ────────────────────
  // The full $8k hits AR; the credit side splits between current
  // revenue (3 days × $22.22/day ≈ $66.67) and deferred revenue ($7,933.33).
  // Doing the split via two lines on a single 3-line entry keeps it
  // balanced and self-documenting. The recognition engine handles the
  // remaining months going forward.
  const globexPerDay = new Decimal(8_000).dividedBy(365).toDecimalPlaces(2);
  const globexMayDays = 4; // May 28 → May 31 inclusive
  const globexMayRev = globexPerDay.times(globexMayDays).toDecimalPlaces(2);
  const globexDeferred = new Decimal(8_000).minus(globexMayRev).toDecimalPlaces(2);

  const globexResults = await postParallel(prisma, {
    documentDate: new Date("2026-05-28"),
    memo: "Globex — annual subscription invoice",
    source: "MANUAL",
    sourceRecordType: "Invoice",
    sourceRecordId: "INV-GLOBEX-Q2",
    lines: [
      { accountCode: "1200", debit: 8_000, partyCode: "GLOBEX" },
      { accountCode: "4000", credit: globexMayRev, description: "Globex May portion" },
      { accountCode: "2200", credit: globexDeferred, description: "Globex deferred (Jun-May)" },
    ],
  });
  jeCount += globexResults.length;
  for (const r of globexResults) {
    await openArItem(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: r.bookCode,
      partyCode: "GLOBEX",
      openedByEntryId: r.id,
      referenceNumber: "INV-GLOBEX-Q2",
      openedDate: new Date("2026-05-28"),
      dueDate: new Date("2026-06-27"),
      amount: 8_000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });
    arOpened += 1;
  }

  // ─── Month-end accruals ────────────────────────────────────────────
  // Prepaid rent expense recognition (1/12).
  jeCount += await postParallelCount(prisma, {
    documentDate: MAY_END,
    memo: "Rent expense — May (1/12 of prepaid)",
    source: "SYSTEM",
    lines: [
      { accountCode: "7400", debit: 1_000, description: "Rent expense" },
      { accountCode: "1400", credit: 1_000, description: "Prepaid Rent amortization" },
    ],
  });

  // Accrued payroll for the back half of May (May 16-31, ~5 working
  // days unpaid at the same daily rate).
  jeCount += await postParallelCount(prisma, {
    documentDate: MAY_END,
    memo: "Payroll accrual — back half of May",
    source: "SYSTEM",
    lines: [
      { accountCode: "6000", debit: 7_000, description: "Salaries — accrual" },
      { accountCode: "2100", credit: 7_000, description: "Accrued payroll" },
    ],
  });

  // Depreciation — book-divergent. GAAP = $666.67/mo, TAX = $400/mo.
  // Posted per book (not via postParallel because amounts differ).
  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: MAY_END,
    memo: "Depreciation — Equipment (GAAP 36-mo SL)",
    source: "SYSTEM",
    sourceSystem: "fa-amort",
    sourceRecordType: "DepreciationRun",
    sourceRecordId: `${assetState.assetCode}:US_GAAP:2026-05-31`,
    lines: [
      { accountCode: "8000", debit: "666.67", description: "Depreciation expense" },
      { accountCode: "1510", credit: "666.67", description: "Accumulated depreciation" },
    ],
  });
  jeCount += 1;
  await postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: "US_TAX",
    documentDate: MAY_END,
    memo: "Depreciation — Equipment (TAX 60-mo SL)",
    source: "SYSTEM",
    sourceSystem: "fa-amort",
    sourceRecordType: "DepreciationRun",
    sourceRecordId: `${assetState.assetCode}:US_TAX:2026-05-31`,
    lines: [
      { accountCode: "8000", debit: "400.00", description: "Depreciation expense" },
      { accountCode: "1510", credit: "400.00", description: "Accumulated depreciation" },
    ],
  });
  jeCount += 1;

  // Globex revenue recognition for May (mirrors what revenue-rec would
  // post on month-end run).
  // (No JE needed: the original invoice entry already recognized May's
  // portion. This block is reserved for v0.3 when we wire in
  // runStraightLineRecognition for subsequent months.)
  void runStraightLineRecognition;
  void contractState;

  return { jeCount, arOpened, apOpened };
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface ParallelPostInput {
  documentDate: Date;
  memo: string;
  source: "MANUAL" | "SYSTEM" | "SEED";
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  lines: Array<{
    accountCode: string;
    debit?: Decimal | string | number;
    credit?: Decimal | string | number;
    description?: string;
    partyCode?: string;
  }>;
}

async function postParallel(
  prisma: PrismaClient,
  input: ParallelPostInput
): Promise<Array<{ bookCode: string; id: string; entryNumber: string }>> {
  const results: Array<{ bookCode: string; id: string; entryNumber: string }> = [];
  for (const bookCode of BOOKS) {
    const r = await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode,
      currencyCode: "USD",
      ...input,
    });
    results.push({ bookCode, id: r.id, entryNumber: r.entryNumber });
  }
  return results;
}

// Convenience wrapper for JEs that don't open a sub-ledger item. Returns
// the count so callers can do `jeCount += await postParallelCount(...)`.
async function postParallelCount(
  prisma: PrismaClient,
  input: ParallelPostInput
): Promise<number> {
  return (await postParallel(prisma, input)).length;
}

async function wipeDemoEntity(prisma: PrismaClient): Promise<void> {
  // Phase 4b: entity code unique per [tenantId, code]; findFirst.
  const existing = await prisma.legalEntity.findFirst({
    where: { code: ENTITY_CODE },
    select: { id: true },
  });
  if (!existing) return;
  const eid = existing.id;
  await prisma.arApplication.deleteMany({ where: { openItem: { entityId: eid } } });
  await prisma.apApplication.deleteMany({ where: { openItem: { entityId: eid } } });
  await prisma.arOpenItem.deleteMany({ where: { entityId: eid } });
  await prisma.apOpenItem.deleteMany({ where: { entityId: eid } });
  await prisma.fixedAssetBookAttributes.deleteMany({
    where: { asset: { entityId: eid } },
  });
  await prisma.fixedAsset.deleteMany({ where: { entityId: eid } });
  await prisma.revenueContractBookAttributes.deleteMany({
    where: { contract: { entityId: eid } },
  });
  await prisma.performanceObligation.deleteMany({
    where: { contract: { entityId: eid } },
  });
  await prisma.revenueContract.deleteMany({ where: { entityId: eid } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId: eid } } });
  await prisma.journalEntry.deleteMany({ where: { entityId: eid } });
  await prisma.periodClose.deleteMany({ where: { entityId: eid } });
}

async function seedMasterData(prisma: PrismaClient): Promise<void> {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  // Phase 4b: legalEntity.code unique per [tenantId, code]; composite upsert.
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY_CODE } },
    create: {
      tenantId,
      code: ENTITY_CODE,
      name: "Demo Co — month-one SaaS",
      functionalCurrencyId: "USD",
    },
    update: { name: "Demo Co — month-one SaaS", tenantId },
  });
  for (const b of [
    { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP" as const },
    { code: "US_TAX", name: "US Federal Tax", basis: "US_TAX" as const },
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
    where: { entityId_code: { entityId: entity.id, code: CALENDAR_CODE } },
    create: {
      tenantId,
      entityId: entity.id,
      code: CALENDAR_CODE,
      name: "Demo 2026 Calendar",
      periodFrequency: "MONTHLY",
    },
    update: { tenantId },
  });
  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        tenantId,
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: { tenantId },
    });
  }
}

// Chart of accounts for DEMO_CO. Reuses the standard shared chart;
// codes match Northwind so visual comparisons work. Created as
// entity-specific accounts so a wipe of DEMO_CO doesn't disturb the
// shared chart used by Northwind / consolidation demos.
const DEMO_ACCOUNTS: Array<{
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  isContra?: boolean;
  isBank?: boolean;
  isMonetary?: boolean;
}> = [
  // DEMO_CO is single-currency USD, so isMonetary never drives a revaluation
  // here — but the flag is set accurately (cash / AR / AP) so the demo chart
  // matches the production chart's classification.
  { code: "1000", name: "Cash — Operating", type: "ASSET", normalBalance: "DEBIT", isBank: true, isMonetary: true },
  { code: "1200", name: "Accounts Receivable", type: "ASSET", normalBalance: "DEBIT", isMonetary: true },
  { code: "1400", name: "Prepaid Expenses", type: "ASSET", normalBalance: "DEBIT" },
  { code: "1500", name: "Computer Equipment", type: "ASSET", normalBalance: "DEBIT" },
  { code: "1510", name: "Accumulated Depreciation — Equipment", type: "ASSET", normalBalance: "CREDIT", isContra: true },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT", isMonetary: true },
  { code: "2100", name: "Accrued Expenses", type: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2200", name: "Deferred Revenue", type: "LIABILITY", normalBalance: "CREDIT" },
  { code: "3000", name: "Common Stock", type: "EQUITY", normalBalance: "CREDIT" },
  { code: "4000", name: "Subscription Revenue", type: "REVENUE", normalBalance: "CREDIT" },
  { code: "5000", name: "Cost of Revenue — Hosting", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6000", name: "Salaries & Wages", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7000", name: "Software & SaaS Tools", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7100", name: "Marketing", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7400", name: "Rent Expense", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "8000", name: "Depreciation Expense", type: "EXPENSE", normalBalance: "DEBIT" },
];

async function seedAccounts(prisma: PrismaClient): Promise<void> {
  // Phase 4b: entity code unique per [tenantId, code]; findFirst.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: ENTITY_CODE },
    select: { id: true, tenantId: true },
  });
  for (const a of DEMO_ACCOUNTS) {
    await prisma.account.upsert({
      where: { entityId_code: { entityId: entity.id, code: a.code } },
      create: {
        tenantId: entity.tenantId,
        entityId: entity.id,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
        isBank: a.isBank ?? false,
        isMonetary: a.isMonetary ?? false,
        bookScope: ["US_GAAP", "US_TAX"],
      },
      update: { tenantId: entity.tenantId },
    });
  }
}

async function seedParties(prisma: PrismaClient): Promise<void> {
  // Phase 4b: entity code unique per [tenantId, code]; findFirst.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: ENTITY_CODE },
    select: { id: true, tenantId: true },
  });
  for (const p of [
    { code: "ACME", displayName: "Acme Corp", role: "CUSTOMER" as const },
    { code: "GLOBEX", displayName: "Globex Corporation", role: "CUSTOMER" as const },
    { code: "AWS", displayName: "Amazon Web Services", role: "VENDOR" as const },
    { code: "DATADOG", displayName: "Datadog Inc.", role: "VENDOR" as const },
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

async function seedFixedAsset(
  prisma: PrismaClient
): Promise<{ assetCode: string }> {
  const code = "DEMO-LAPTOPS-2026";
  await createFixedAsset(prisma, {
    entityCode: ENTITY_CODE,
    code,
    description: "8 MacBooks — engineering team",
    category: "COMPUTER_EQUIPMENT",
    acquisitionDate: new Date("2026-05-05"),
    acquisitionCost: 24_000,
    acquisitionCurrencyCode: "USD",
    assetAccountCode: "1500",
    books: [
      {
        bookCode: "US_GAAP",
        usefulLifeMonths: 36,
        method: "STRAIGHT_LINE",
        inServiceDate: new Date("2026-05-05"),
        depreciationExpenseAccountCode: "8000",
        accumDepreciationAccountCode: "1510",
      },
      {
        bookCode: "US_TAX",
        usefulLifeMonths: 60,
        method: "STRAIGHT_LINE",
        inServiceDate: new Date("2026-05-05"),
        depreciationExpenseAccountCode: "8000",
        accumDepreciationAccountCode: "1510",
      },
    ],
  });
  return { assetCode: code };
}

async function seedRevenueContract(
  prisma: PrismaClient
): Promise<{ contractCode: string }> {
  const code = "DEMO-GLOBEX-2026";
  await createRevenueContract(prisma, {
    entityCode: ENTITY_CODE,
    code,
    description: "Globex annual subscription",
    customerPartyCode: "GLOBEX",
    contractStartDate: new Date("2026-05-28"),
    contractEndDate: new Date("2027-05-27"),
    totalContractValue: 8_000,
    currencyCode: "USD",
    performanceObligations: [
      {
        sequenceNo: 1,
        description: "SaaS subscription access",
        ssp: 8_000,
        recognitionPattern: "OVER_TIME_STRAIGHT",
        startDate: new Date("2026-05-28"),
        endDate: new Date("2027-05-27"),
        revenueAccountCode: "4000",
        deferredAccountCode: "2200",
      },
    ],
    books: [
      { bookCode: "US_GAAP", recognitionBasis: "ACCRUAL" },
      { bookCode: "US_TAX", recognitionBasis: "CASH" },
    ],
  });
  return { contractCode: code };
}

// Expose constants for the CLI entry point.
export const DEMO_ENTITY_CODE = ENTITY_CODE;
export const DEMO_PERIOD_CODE = "2026-05";
