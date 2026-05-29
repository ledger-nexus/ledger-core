// Invariant tests for v0.4 features:
//   - Fixed asset disposal with gain/loss recognition
//   - Bad debt write-off posting a paired JE
//   - Full ASC 842 lease commencement + monthly amortization
//   - Posting-rules engine end-to-end
//
// Run with: pnpm test (or: pnpm test tests/v0-4-features.test.ts)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { getBalanceSheet, getIncomeStatement } from "../src/lib/accounting/reports";
import {
  openArItem,
  openArBalance,
  writeOffArItem,
  estimateBadDebtAllowance,
} from "../src/lib/accounting/sub-ledgers/ar";
import {
  createFixedAsset,
  runDepreciation,
  disposeFixedAsset,
  netBookValue,
} from "../src/lib/accounting/sub-ledgers/fixed-assets";
import { createLease, runLeaseAccounting } from "../src/lib/accounting/sub-ledgers/leases";
import {
  registerUniformRule,
  postWithRules,
  RuleTemplate,
} from "../src/lib/accounting/posting-rules";
import { CHART_OF_ACCOUNTS } from "../src/lib/db/chart-of-accounts";

const prisma = new PrismaClient();
const ENTITY = "V04_TEST";
const GAAP = { entityCode: ENTITY, bookCode: "US_GAAP" };
const TAX = { entityCode: ENTITY, bookCode: "US_TAX" };

async function clearAll() {
  // Scope to V04_TEST only — preserves seed data + other tests' state.
  const testEntity = await prisma.legalEntity.findFirst({
    where: { code: ENTITY },
    select: { id: true },
  });
  if (!testEntity) return;
  const entityId = testEntity.id;
  await prisma.arApplication.deleteMany({
    where: { openItem: { entityId } },
  });
  await prisma.apApplication.deleteMany({
    where: { openItem: { entityId } },
  });
  await prisma.arOpenItem.deleteMany({ where: { entityId } });
  await prisma.apOpenItem.deleteMany({ where: { entityId } });
  await prisma.fixedAssetBookAttributes.deleteMany({
    where: { asset: { entityId } },
  });
  await prisma.fixedAsset.deleteMany({ where: { entityId } });
  await prisma.leaseBookAttributes.deleteMany({
    where: { lease: { entityId } },
  });
  await prisma.lease.deleteMany({ where: { entityId } });
  await prisma.revenueContractBookAttributes.deleteMany({
    where: { contract: { entityId } },
  });
  await prisma.performanceObligation.deleteMany({
    where: { contract: { entityId } },
  });
  await prisma.revenueContract.deleteMany({ where: { entityId } });
  // PostingRule is keyed by (sourceEventType, bookId) — not entity-scoped.
  // Test fixtures register rules against the shared US_GAAP / US_TAX books,
  // so we leave them in place; the upsert path in seedMasterData reuses
  // them. If a test ever needed entity-scoped postings, it'd register
  // a separate test-only book.
  await prisma.journalLine.deleteMany({
    where: { entry: { entityId } },
  });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
}

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY } },
    create: { tenantId, code: ENTITY, name: "v0.4 Test Co.", functionalCurrencyId: "USD" },
    update: { tenantId },
  });
  for (const b of [
    { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP" as const },
    { code: "US_TAX", name: "US Federal Tax", basis: "US_TAX" as const },
    { code: "IFRS", name: "IFRS", basis: "IFRS" as const },
  ]) {
    await prisma.book.upsert({
      where: { code: b.code },
      create: { code: b.code, name: b.name, basis: b.basis, reportingCurrencyId: "USD" },
      update: {},
    });
  }
  const calendar = await prisma.fiscalCalendar.upsert({
    where: { entityId_code: { entityId: entity.id, code: "STANDARD_2026" } },
    create: {
      tenantId: tenantId,
      entityId: entity.id,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    update: {},
  });
  for (let m = 1; m <= 24; m++) {
    const year = 2026 + Math.floor((m - 1) / 12);
    const monthInYear = ((m - 1) % 12) + 1;
    const code = `${year}-${String(monthInYear).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        tenantId: tenantId,
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(year, monthInYear - 1, 1)),
        endsOn: new Date(Date.UTC(year, monthInYear, 0)),
      },
      update: {},
    });
  }
  // Prisma 5.22 rejects null in compound unique-key upsert. Use
  // findFirst + create to upsert shared-chart accounts (entityId=null).
  // Tenant-scope the findFirst (PG NULL≠NULL — see sub-ledgers.test.ts).
  for (const a of CHART_OF_ACCOUNTS) {
    const existing = await prisma.account.findFirst({
      where: { tenantId, entityId: null, code: a.code },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.account.create({
      data: {
        tenantId: tenantId,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
        isControlAccount: a.isControlAccount ?? false,
        isBank: a.isBank ?? false,
        subtype: a.subtype,
      },
    });
  }
  for (const p of [
    { code: "TEST_CUSTOMER", displayName: "Test Customer", role: "CUSTOMER" as const },
    { code: "TEST_VENDOR", displayName: "Test Vendor", role: "VENDOR" as const },
    { code: "TEST_LESSOR", displayName: "Test Lessor", role: "VENDOR" as const },
  ]) {
    const party = await prisma.party.upsert({
      where: { entityId_code: { entityId: entity.id, code: p.code } },
      create: { tenantId, entityId: entity.id, code: p.code, displayName: p.displayName },
      update: { tenantId },
    });
    await prisma.partyRole.upsert({
      where: { partyId_role: { partyId: party.id, role: p.role } },
      create: { tenantId, partyId: party.id, role: p.role },
      update: { tenantId },
    });
  }
}

beforeAll(async () => {
  await seedMasterData();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearAll();
});

// =========================================================================
// Fixed asset disposal
// =========================================================================

describe("fixed asset disposal", () => {
  it("disposing at NBV: zero gain/loss; asset gross + accum dep both clear from BS", async () => {
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-05"),
      memo: "buy",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 12_000 },
        { accountCode: "1000", credit: 12_000 },
      ],
    });
    await createFixedAsset(prisma, {
      entityCode: ENTITY,
      code: "DISPOSE_ME",
      description: "Test",
      acquisitionDate: new Date("2026-01-05"),
      acquisitionCost: 12_000,
      acquisitionCurrencyCode: "USD",
      assetAccountCode: "1500",
      books: [
        {
          bookCode: "US_GAAP",
          usefulLifeMonths: 12,
          method: "STRAIGHT_LINE",
          inServiceDate: new Date("2026-01-05"),
          depreciationExpenseAccountCode: "8000",
          accumDepreciationAccountCode: "1510",
        },
      ],
    });

    // After 6 months of depreciation: NBV = $12k - 6*$1k = $6k.
    // Dispose for $6k → zero gain/loss.
    const results = await disposeFixedAsset(prisma, {
      entityCode: ENTITY,
      assetCode: "DISPOSE_ME",
      disposalDate: new Date("2026-06-30"),
      disposalProceeds: 6_000,
      source: "SEED",
    });
    expect(results).toHaveLength(1);
    expect(results[0].nbvAtDisposal.toFixed(2)).toBe("6000.00");
    expect(results[0].gainLoss.toFixed(2)).toBe("0.00");

    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-07-01"));
    // Equipment 1500 should be zero (asset removed). Accum dep 1510 should be zero.
    const eq = bs.assets.find((a) => a.code === "1500");
    const ad = bs.assets.find((a) => a.code === "1510");
    expect(eq?.amount.toNumber() ?? 0).toBe(0);
    expect(ad?.amount.toNumber() ?? 0).toBe(0);
  });

  it("disposing above NBV creates a gain; below NBV creates a loss (per book)", async () => {
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-05"),
      memo: "buy",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 12_000 },
        { accountCode: "1000", credit: 12_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...TAX,
      documentDate: new Date("2026-01-05"),
      memo: "buy",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 12_000 },
        { accountCode: "1000", credit: 12_000 },
      ],
    });
    await createFixedAsset(prisma, {
      entityCode: ENTITY,
      code: "DISPOSE_GAIN",
      description: "Test",
      acquisitionDate: new Date("2026-01-05"),
      acquisitionCost: 12_000,
      acquisitionCurrencyCode: "USD",
      assetAccountCode: "1500",
      books: [
        {
          bookCode: "US_GAAP",
          usefulLifeMonths: 12,
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

    // Dispose at month 6 for $7,000.
    // GAAP: NBV = 12000 - 6*1000 = $6,000. Proceeds $7,000 → gain $1,000.
    // TAX:  NBV = 12000 - 6*200  = $10,800. Proceeds $7,000 → loss $3,800.
    const results = await disposeFixedAsset(prisma, {
      entityCode: ENTITY,
      assetCode: "DISPOSE_GAIN",
      disposalDate: new Date("2026-06-30"),
      disposalProceeds: 7_000,
      source: "SEED",
    });
    const gaap = results.find((r) => r.bookCode === "US_GAAP")!;
    const tax = results.find((r) => r.bookCode === "US_TAX")!;
    expect(gaap.gainLoss.toFixed(2)).toBe("1000.00");
    expect(tax.gainLoss.toFixed(2)).toBe("-3800.00");
  });

  it("disposing an already-DISPOSED asset throws", async () => {
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-05"),
      memo: "buy",
      source: "SEED",
      lines: [
        { accountCode: "1500", debit: 1_000 },
        { accountCode: "1000", credit: 1_000 },
      ],
    });
    await createFixedAsset(prisma, {
      entityCode: ENTITY,
      code: "DOUBLE_DISPOSE",
      description: "Test",
      acquisitionDate: new Date("2026-01-05"),
      acquisitionCost: 1_000,
      acquisitionCurrencyCode: "USD",
      assetAccountCode: "1500",
      books: [
        {
          bookCode: "US_GAAP",
          usefulLifeMonths: 12,
          method: "STRAIGHT_LINE",
          inServiceDate: new Date("2026-01-05"),
          depreciationExpenseAccountCode: "8000",
          accumDepreciationAccountCode: "1510",
        },
      ],
    });
    await disposeFixedAsset(prisma, {
      entityCode: ENTITY,
      assetCode: "DOUBLE_DISPOSE",
      disposalDate: new Date("2026-06-30"),
      disposalProceeds: 500,
      source: "SEED",
    });
    await expect(
      disposeFixedAsset(prisma, {
        entityCode: ENTITY,
        assetCode: "DOUBLE_DISPOSE",
        disposalDate: new Date("2026-07-30"),
        disposalProceeds: 0,
      })
    ).rejects.toThrow(/already DISPOSED/);
  });
});

// =========================================================================
// Bad debt write-off
// =========================================================================

describe("AR bad debt write-off", () => {
  it("write-off posts a paired JE (Dr Bad Debt, Cr AR) and zeros the open item", async () => {
    const invoice = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-15"),
      memo: "Invoice",
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 5_000, partyCode: "TEST_CUSTOMER" },
        { accountCode: "4000", credit: 5_000 },
      ],
    });
    const item = await openArItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "TEST_CUSTOMER",
      openedByEntryId: invoice.id,
      openedDate: new Date("2026-01-15"),
      amount: 5_000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });

    // Pre-write-off: AR control = $5k; open balance = $5k.
    const arBefore = await openArBalance(prisma, ENTITY, "US_GAAP");
    expect(arBefore.equals(new Decimal(5_000))).toBe(true);

    const result = await writeOffArItem(prisma, {
      openItemId: item.id,
      writeOffDate: new Date("2026-06-30"),
      source: "SEED",
    });
    expect(result.amount.equals(new Decimal(5_000))).toBe(true);

    // After: AR control = $0; open balance = $0; Bad debt expense = $5k.
    const arAfter = await openArBalance(prisma, ENTITY, "US_GAAP");
    expect(arAfter.equals(new Decimal(0))).toBe(true);

    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-12-31"));
    const arRow = bs.assets.find((a) => a.code === "1200");
    expect(arRow?.amount.toNumber() ?? 0).toBe(0);

    const pnl = await getIncomeStatement(prisma, GAAP, new Date("2026-01-01"), new Date("2026-12-31"));
    const badDebtRow = pnl.expenses.find((e) => e.code === "7500");
    expect(badDebtRow).toBeDefined();
    expect(badDebtRow!.amount.equals(new Decimal(5_000))).toBe(true);
  });

  it("write-off in WRITTEN_OFF state throws", async () => {
    const invoice = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-15"),
      memo: "Invoice",
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 1_000, partyCode: "TEST_CUSTOMER" },
        { accountCode: "4000", credit: 1_000 },
      ],
    });
    const item = await openArItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "TEST_CUSTOMER",
      openedByEntryId: invoice.id,
      openedDate: new Date("2026-01-15"),
      amount: 1_000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });
    await writeOffArItem(prisma, {
      openItemId: item.id,
      writeOffDate: new Date("2026-06-30"),
      source: "SEED",
    });
    await expect(
      writeOffArItem(prisma, {
        openItemId: item.id,
        writeOffDate: new Date("2026-07-01"),
      })
    ).rejects.toThrow(/Cannot write off AR item in WRITTEN_OFF/);
  });

  // ---- v0.5: Allowance method ----

  it("allowance method: estimate builds the allowance; write-off uses it (no double-counted expense)", async () => {
    // Period 1: estimate $1,500 of bad debt. Post Dr Bad Debt $1,500 / Cr Allowance $1,500.
    await estimateBadDebtAllowance(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      asOfDate: new Date("2026-03-31"),
      amount: 1_500,
      source: "SEED",
    });

    // Bad debt expense is on the books at $1,500.
    const pnlAfterEstimate = await getIncomeStatement(
      prisma,
      GAAP,
      new Date("2026-01-01"),
      new Date("2026-03-31")
    );
    const badDebtAfterEstimate = pnlAfterEstimate.expenses.find((e) => e.code === "7500");
    expect(badDebtAfterEstimate?.amount.toNumber() ?? 0).toBe(1_500);

    // Then a specific $500 invoice goes bad. Write off via the allowance method:
    // Dr Allowance $500 / Cr AR $500. Does NOT touch Bad Debt Expense.
    const invoice = await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-04-01"),
      memo: "Invoice that will go bad",
      source: "SEED",
      lines: [
        { accountCode: "1200", debit: 500, partyCode: "TEST_CUSTOMER" },
        { accountCode: "4000", credit: 500 },
      ],
    });
    const item = await openArItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "TEST_CUSTOMER",
      openedByEntryId: invoice.id,
      openedDate: new Date("2026-04-01"),
      amount: 500,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });
    const result = await writeOffArItem(prisma, {
      openItemId: item.id,
      writeOffDate: new Date("2026-06-30"),
      method: "ALLOWANCE",
      source: "SEED",
    });
    expect(result.method).toBe("ALLOWANCE");

    // Bad Debt Expense stays at $1,500 (the estimate); it does NOT increase
    // when we apply the allowance to a specific item.
    const pnlAfterWriteOff = await getIncomeStatement(
      prisma,
      GAAP,
      new Date("2026-01-01"),
      new Date("2026-12-31")
    );
    const badDebtAfterWriteOff = pnlAfterWriteOff.expenses.find((e) => e.code === "7500");
    expect(badDebtAfterWriteOff?.amount.toNumber() ?? 0).toBe(1_500);

    // Allowance (1210) decreased by $500 → from $1,500 credit to $1,000 credit.
    // It's a contra-asset, so it shows on the BS assets side as a negative.
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-12-31"));
    const allowance = bs.assets.find((a) => a.code === "1210");
    expect(allowance).toBeDefined();
    expect(allowance!.amount.toNumber()).toBe(-1_000); // contra: $1,500 estimated - $500 applied
  });

  it("allowance estimate must be positive", async () => {
    await expect(
      estimateBadDebtAllowance(prisma, {
        entityCode: ENTITY,
        bookCode: "US_GAAP",
        asOfDate: new Date("2026-03-31"),
        amount: -100,
        source: "SEED",
      })
    ).rejects.toThrow(/must be positive/);
  });
});

// =========================================================================
// Full ASC 842 lease accounting
// =========================================================================

describe("ASC 842 operating lease", () => {
  it("commencement posts ROU = PV of payments; subsequent months keep BS balanced", async () => {
    // 24-month lease, $5k/mo, 6% annual rate.
    // PV = 5000 × (1 - 1.005^-24) / 0.005 ≈ $112,814.
    await createLease(prisma, {
      entityCode: ENTITY,
      code: "TEST_LEASE",
      description: "Test office lease",
      lessorPartyCode: "TEST_LESSOR",
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
      ],
    });

    // Provide opening cash so the BS balances after rent payments.
    await postJournalEntry(prisma, {
      ...GAAP,
      documentDate: new Date("2026-01-01"),
      memo: "Funding",
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 200_000 },
        { accountCode: "3100", credit: 200_000 },
      ],
    });

    await runLeaseAccounting(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      throughDate: new Date("2026-03-31"),
      source: "SEED",
    });

    // After commencement + 1 month: ROU ≈ PV - month-1 amortization;
    // liability ≈ PV + month-1 interest - month-1 payment. BS balances.
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-03-31"));
    expect(bs.balances).toBe(true);
    const rou = bs.assets.find((a) => a.code === "1600");
    const liab = bs.liabilities.find((l) => l.code === "2600");
    expect(rou).toBeDefined();
    expect(liab).toBeDefined();
    // ROU and liability should both have decreased by ~$4,436 since commencement.
    // PV ≈ $112,814; after 1 month: rou ≈ $108,378; liab ≈ $108,378.
    expect(rou!.amount.toNumber()).toBeGreaterThan(100_000);
    expect(rou!.amount.toNumber()).toBeLessThan(115_000);
    // The two should be equal (or very close) after each period.
    expect(rou!.amount.minus(liab!.amount).abs().toNumber()).toBeLessThan(1);
  });

  it("TAX_CASH_BASIS posts only cash-payment expense — no ROU, no liability", async () => {
    await createLease(prisma, {
      entityCode: ENTITY,
      code: "TAX_LEASE",
      description: "Tax book lease",
      lessorPartyCode: "TEST_LESSOR",
      leaseStartDate: new Date("2026-03-01"),
      leaseEndDate: new Date("2028-02-29"),
      paymentFrequency: "MONTHLY",
      paymentAmount: 5_000,
      currencyCode: "USD",
      books: [
        {
          bookCode: "US_TAX",
          classification: "TAX_CASH_BASIS",
          expenseAccountCode: "7400",
        },
      ],
    });

    // Opening cash on TAX book.
    await postJournalEntry(prisma, {
      ...TAX,
      documentDate: new Date("2026-01-01"),
      memo: "Funding",
      source: "SEED",
      lines: [
        { accountCode: "1000", debit: 200_000 },
        { accountCode: "3100", credit: 200_000 },
      ],
    });

    await runLeaseAccounting(prisma, {
      entityCode: ENTITY,
      bookCode: "US_TAX",
      throughDate: new Date("2026-03-31"),
      source: "SEED",
    });

    const bs = await getBalanceSheet(prisma, TAX, new Date("2026-03-31"));
    const rou = bs.assets.find((a) => a.code === "1600");
    const liab = bs.liabilities.find((l) => l.code === "2600");
    expect(rou?.amount.toNumber() ?? 0).toBe(0);
    expect(liab?.amount.toNumber() ?? 0).toBe(0);

    const pnl = await getIncomeStatement(prisma, TAX, new Date("2026-01-01"), new Date("2026-03-31"));
    const leaseExp = pnl.expenses.find((e) => e.code === "7400");
    // 1 month of cash basis = $5,000.
    expect(leaseExp?.amount.toNumber() ?? 0).toBe(5_000);
  });
});

// =========================================================================
// Posting-rules engine
// =========================================================================

describe("posting-rules engine", () => {
  it("registers a uniform rule and posts the same JE to multiple books", async () => {
    const template: RuleTemplate = {
      memo: "Invoice ${$.invoiceNumber} — ${$.customerCode}",
      lines: [
        {
          accountCode: "1200",
          side: "DEBIT",
          amountExpr: "$.amount",
          partyCodeExpr: "$.customerCode",
          description: "AR — ${$.customerCode}",
        },
        {
          accountCode: "4000",
          side: "CREDIT",
          amountExpr: "$.amount",
          description: "Subscription revenue",
        },
      ],
    };
    await registerUniformRule(prisma, {
      sourceEventType: "TEST_INVOICE",
      books: ["US_GAAP", "US_TAX", "IFRS"],
      template,
    });

    const results = await postWithRules(prisma, {
      entityCode: ENTITY,
      sourceEventType: "TEST_INVOICE",
      payload: {
        amount: 1_500,
        customerCode: "TEST_CUSTOMER",
        invoiceNumber: "INV-001",
      },
      documentDate: new Date("2026-03-15"),
      source: "SEED",
      sourceRecordId: "INV-001",
    });
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.entryNumber).toMatch(/^V04_TEST-/);
      expect(r.ruleVersion).toBe(1);
    }

    // Each book got the same JE.
    const bs = await getBalanceSheet(prisma, GAAP, new Date("2026-06-30"));
    const arRow = bs.assets.find((a) => a.code === "1200");
    expect(arRow!.amount.equals(new Decimal(1_500))).toBe(true);
  });

  it("throws when no active rule is registered for an event/book pair", async () => {
    await expect(
      postWithRules(prisma, {
        entityCode: ENTITY,
        sourceEventType: "UNREGISTERED_EVENT",
        payload: { amount: 100 },
        documentDate: new Date("2026-03-15"),
        books: ["US_GAAP"],
      })
    ).rejects.toThrow(/No active posting rule for event/);
  });

  it("interpolation in memo + description resolves payload paths", async () => {
    await registerUniformRule(prisma, {
      sourceEventType: "TEST_INTERP",
      books: ["US_GAAP"],
      template: {
        memo: "Asset ${$.code} purchased for ${$.cost}",
        lines: [
          {
            accountCode: "1500",
            side: "DEBIT",
            amountExpr: "$.cost",
            description: "Capitalize ${$.code}",
          },
          {
            accountCode: "1000",
            side: "CREDIT",
            amountExpr: "$.cost",
            description: "Cash for ${$.code}",
          },
        ],
      },
    });
    await postWithRules(prisma, {
      entityCode: ENTITY,
      sourceEventType: "TEST_INTERP",
      payload: { code: "ASSET-001", cost: 5_000 },
      documentDate: new Date("2026-03-15"),
      books: ["US_GAAP"],
      source: "SEED",
    });

    const entries = await prisma.journalEntry.findMany({
      where: { sourceRecordType: "TEST_INTERP" },
      include: { lines: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].memo).toBe("Asset ASSET-001 purchased for 5000");
    expect(entries[0].lines.find((l) => l.description?.includes("Capitalize ASSET-001"))).toBeDefined();
  });
});
