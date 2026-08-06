// Accounting invariant tests.
//
// These tests are the headline of the project. They assert the rules that
// MUST hold for the ledger to be valid — at every moment, on every dataset.
//
// If any of these fail, the system is broken in a way that makes the
// financial statements untrustworthy. A balance sheet that doesn't balance
// is not just a bug — it means the math is wrong.
//
// This file covers the v1 universal-schema posting boundary. Multi-book
// parallel posting and sub-ledger invariants arrive with the next batch.
//
// Tests use Vitest. Run with: pnpm test

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { Decimal } from "@/lib/utils/decimal";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import {
  getTrialBalance,
  getBalanceSheet,
  getIncomeStatement,
} from "../src/lib/accounting/reports";
import {
  UnbalancedEntryError,
  InvalidLineError,
  UnknownAccountError,
} from "../src/lib/accounting/types";
import { CHART_OF_ACCOUNTS } from "../src/lib/db/chart-of-accounts";

const prisma = new PrismaClient();

const ENTITY_CODE = "TEST_CO";
const SCOPE = { entityCode: ENTITY_CODE, bookCode: "US_GAAP" };

async function clearLedger() {
  // Scope to TEST_CO only — never wipe Northwind / other seeded entities.
  // Order matters: sub-ledger rows that FK back to JEs (AR/AP open items
  // via openedByEntryId, applications via appliedByEntryId, AR/AP
  // applications, period closes, journal lines) must be deleted before
  // their parent JEs. Same discipline as the consolidation test's
  // clearAll().
  const testEntity = await prisma.legalEntity.findFirst({
    where: { code: ENTITY_CODE },
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
    where: { tenantId_code: { tenantId, code: ENTITY_CODE } },
    create: { tenantId, code: ENTITY_CODE, name: "Test Co.", functionalCurrencyId: "USD" },
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
      name: "Standard 2026",
      periodFrequency: "MONTHLY",
    },
    update: {},
  });

  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        tenantId: tenantId,
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: {},
    });
  }
}

async function seedAccountsOnly() {
  // Prisma 5.22 rejects null in compound unique-key upsert. Use
  // findFirst + create to upsert shared-chart accounts (entityId=null).
  const tenantId = await getDefaultTenantId(prisma);
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
        isMonetary: a.isMonetary ?? false,
        subtype: a.subtype,
      },
    });
  }
}

beforeAll(async () => {
  await seedMasterData();
  await seedAccountsOnly();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearLedger();
});

// =========================================================================
// Group 1: postJournalEntry — input validation
// =========================================================================

describe("postJournalEntry: input validation", () => {
  it("rejects an entry with fewer than 2 lines", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "bad",
        lines: [{ accountCode: "1000", debit: 100 }],
      })
    ).rejects.toThrow(InvalidLineError);
  });

  it("rejects a line with both debit and credit non-zero", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "bad",
        lines: [
          { accountCode: "1000", debit: 100, credit: 50 },
          { accountCode: "3000", credit: 50 },
        ],
      })
    ).rejects.toThrow(InvalidLineError);
  });

  it("rejects a line with both debit and credit zero", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "bad",
        lines: [{ accountCode: "1000" }, { accountCode: "3000", credit: 100 }],
      })
    ).rejects.toThrow(InvalidLineError);
  });

  it("rejects negative amounts", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "bad",
        lines: [
          { accountCode: "1000", debit: -100 },
          { accountCode: "3000", credit: 100 },
        ],
      })
    ).rejects.toThrow(InvalidLineError);
  });

  it("rejects unknown account codes", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "bad",
        lines: [
          { accountCode: "9999", debit: 100 },
          { accountCode: "3000", credit: 100 },
        ],
      })
    ).rejects.toThrow(UnknownAccountError);
  });
});

// =========================================================================
// Group 2: The headline invariant — debits = credits
// =========================================================================

describe("invariant: debits equal credits", () => {
  it("rejects an entry where debits > credits", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "unbalanced",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "3000", credit: 90 },
        ],
      })
    ).rejects.toThrow(UnbalancedEntryError);
  });

  it("rejects an entry where credits > debits", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "unbalanced",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "3000", credit: 100.01 },
        ],
      })
    ).rejects.toThrow(UnbalancedEntryError);
  });

  it("accepts a balanced two-line entry", async () => {
    const result = await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-01"),
      memo: "balanced",
      lines: [
        { accountCode: "1000", debit: 1000 },
        { accountCode: "3000", credit: 1000 },
      ],
    });
    expect(result.entryNumber).toMatch(/^TEST_CO-US_GAAP-\d{5}$/);
  });

  it("accepts a balanced multi-line entry (one debit, three credits)", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "split credit",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "2000", credit: 40 },
          { accountCode: "2100", credit: 35 },
          { accountCode: "3000", credit: 25 },
        ],
      })
    ).resolves.toBeDefined();
  });

  it("rejects a balanced-looking multi-line entry that is off by 1/10000", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "payroll",
        lines: [
          { accountCode: "6000", debit: 80_000 },
          { accountCode: "6100", debit: 6_400 },
          { accountCode: "6200", debit: 8_000 },
          { accountCode: "1010", credit: 94_400 },
          { accountCode: "2100", credit: 0.0001 },
        ],
      })
    ).rejects.toThrow(UnbalancedEntryError);
  });

  it("handles fractional cents correctly (no floating point error)", async () => {
    await expect(
      postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "fractional",
        lines: [
          { accountCode: "1000", debit: "0.1" },
          { accountCode: "1010", debit: "0.2" },
          { accountCode: "3000", credit: "0.3" },
        ],
      })
    ).resolves.toBeDefined();
  });
});

// =========================================================================
// Group 3: Atomicity — partial entries are impossible
// =========================================================================

describe("invariant: posting is atomic", () => {
  it("does not persist any lines if validation fails", async () => {
    try {
      await postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "should not persist",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "3000", credit: 99 },
        ],
      });
    } catch {}
    // Scope to TEST_CO — other entities (Northwind seed, other suites)
    // legitimately have entries; we only care about whether THIS failed
    // post wrote anything for TEST_CO.
    const entryCount = await prisma.journalEntry.count({
      where: { entity: { code: ENTITY_CODE } },
    });
    const lineCount = await prisma.journalLine.count({
      where: { entry: { entity: { code: ENTITY_CODE } } },
    });
    expect(entryCount).toBe(0);
    expect(lineCount).toBe(0);
  });

  it("does not persist any lines if an account is unknown", async () => {
    try {
      await postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: "bad account",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "9999", credit: 100 },
        ],
      });
    } catch {}
    expect(
      await prisma.journalEntry.count({
        where: { entity: { code: ENTITY_CODE } },
      })
    ).toBe(0);
    expect(
      await prisma.journalLine.count({
        where: { entry: { entity: { code: ENTITY_CODE } } },
      })
    ).toBe(0);
  });
});

// =========================================================================
// Group 4: Trial balance invariants
// =========================================================================

describe("invariant: trial balance debits equal credits", () => {
  it("balances after a single entry", async () => {
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });

    const tb = await getTrialBalance(prisma, SCOPE, new Date("2026-12-31"));
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });

  it("balances after dozens of entries", async () => {
    for (let i = 0; i < 50; i++) {
      await postJournalEntry(prisma, {
        ...SCOPE,
        documentDate: new Date("2026-01-01"),
        memo: `entry ${i}`,
        lines: [
          { accountCode: "1000", debit: i + 1 },
          { accountCode: "4000", credit: i + 1 },
        ],
      });
    }
    const tb = await getTrialBalance(prisma, SCOPE, new Date("2026-12-31"));
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });
});

// =========================================================================
// Group 5: Balance sheet invariants — THE big one
// =========================================================================

describe("invariant: balance sheet balances", () => {
  it("balances with only equity contributions", async () => {
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 500_000 },
        { accountCode: "3100", credit: 500_000 },
      ],
    });

    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-01-01"));
    expect(bs.balances).toBe(true);
    expect(bs.totalAssets.equals(bs.totalLiabilitiesAndEquity)).toBe(true);
  });

  it("balances after revenue is recognized (retained earnings rolls)", async () => {
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-15"),
      memo: "revenue",
      lines: [
        { accountCode: "1200", debit: 10_000 },
        { accountCode: "4000", credit: 10_000 },
      ],
    });

    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-01-31"));
    expect(bs.balances).toBe(true);
    expect(bs.retainedEarnings.equals(new Decimal(10_000))).toBe(true);
  });

  it("balances after expenses are incurred (retained earnings decreases)", async () => {
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-31"),
      memo: "payroll",
      lines: [
        { accountCode: "6000", debit: 30_000 },
        { accountCode: "1000", credit: 30_000 },
      ],
    });

    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-01-31"));
    expect(bs.balances).toBe(true);
    expect(bs.retainedEarnings.equals(new Decimal(-30_000))).toBe(true);
  });

  it("balances with a contra-asset (accumulated depreciation)", async () => {
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-01"),
      memo: "buy equipment",
      lines: [
        { accountCode: "1500", debit: 12_000 },
        { accountCode: "1000", debit: 0.0001 },
        { accountCode: "3100", credit: 12_000.0001 },
      ],
    });
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-02-28"),
      memo: "Feb depreciation",
      lines: [
        { accountCode: "8000", debit: 333.33 },
        { accountCode: "1510", credit: 333.33 },
      ],
    });

    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-02-28"));
    expect(bs.balances).toBe(true);
    const accumDep = bs.assets.find((a) => a.code === "1510");
    expect(accumDep).toBeDefined();
    expect(accumDep!.amount.equals(new Decimal(-333.33))).toBe(true);
  });
});

// =========================================================================
// Group 6: Income statement invariants
// =========================================================================

describe("income statement", () => {
  it("computes net income as revenue minus expenses", async () => {
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-15"),
      memo: "rev",
      lines: [
        { accountCode: "1200", debit: 50_000 },
        { accountCode: "4000", credit: 50_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-20"),
      memo: "exp",
      lines: [
        { accountCode: "6000", debit: 30_000 },
        { accountCode: "1000", credit: 30_000 },
      ],
    });

    const pnl = await getIncomeStatement(
      prisma,
      SCOPE,
      new Date("2026-01-01"),
      new Date("2026-01-31")
    );
    expect(pnl.netIncome.equals(new Decimal(20_000))).toBe(true);
  });

  it("only includes activity within the requested period", async () => {
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-15"),
      memo: "jan",
      lines: [
        { accountCode: "1200", debit: 10_000 },
        { accountCode: "4000", credit: 10_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-02-15"),
      memo: "feb",
      lines: [
        { accountCode: "1200", debit: 25_000 },
        { accountCode: "4000", credit: 25_000 },
      ],
    });

    const jan = await getIncomeStatement(
      prisma,
      SCOPE,
      new Date("2026-01-01"),
      new Date("2026-01-31")
    );
    expect(jan.totalRevenue.equals(new Decimal(10_000))).toBe(true);

    const feb = await getIncomeStatement(
      prisma,
      SCOPE,
      new Date("2026-02-01"),
      new Date("2026-02-28")
    );
    expect(feb.totalRevenue.equals(new Decimal(25_000))).toBe(true);
  });
});

// =========================================================================
// Group 7: Cross-statement reconciliation
// =========================================================================

describe("cross-statement invariants", () => {
  it("retained earnings on BS equals cumulative net income from IS", async () => {
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-15"),
      memo: "rev",
      lines: [
        { accountCode: "1200", debit: 40_000 },
        { accountCode: "4000", credit: 40_000 },
      ],
    });
    await postJournalEntry(prisma, {
      ...SCOPE,
      documentDate: new Date("2026-01-20"),
      memo: "exp",
      lines: [
        { accountCode: "6000", debit: 25_000 },
        { accountCode: "1000", credit: 25_000 },
      ],
    });

    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-01-31"));
    const pnl = await getIncomeStatement(
      prisma,
      SCOPE,
      new Date("1900-01-01"),
      new Date("2026-01-31")
    );
    expect(bs.retainedEarnings.equals(pnl.netIncome)).toBe(true);
  });
});

// =========================================================================
// Group 8: Multi-book isolation (new in v1)
// =========================================================================

describe("invariant: multi-book isolation", () => {
  it("an entry posted to US_GAAP does not appear in US_TAX reports", async () => {
    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-01-01"),
      memo: "GAAP-only",
      lines: [
        { accountCode: "1000", debit: 1_000 },
        { accountCode: "4000", credit: 1_000 },
      ],
    });

    const gaapTb = await getTrialBalance(
      prisma,
      { entityCode: ENTITY_CODE, bookCode: "US_GAAP" },
      new Date("2026-12-31")
    );
    const taxTb = await getTrialBalance(
      prisma,
      { entityCode: ENTITY_CODE, bookCode: "US_TAX" },
      new Date("2026-12-31")
    );

    expect(gaapTb.totalDebit.equals(new Decimal(1_000))).toBe(true);
    expect(taxTb.totalDebit.equals(new Decimal(0))).toBe(true);
  });

  it("both books balance independently with divergent activity", async () => {
    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-01-01"),
      memo: "GAAP capitalization",
      lines: [
        { accountCode: "1000", debit: 5_000 },
        { accountCode: "3100", credit: 5_000 },
      ],
    });
    await postJournalEntry(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_TAX",
      documentDate: new Date("2026-01-01"),
      memo: "Tax capitalization (different number)",
      lines: [
        { accountCode: "1000", debit: 4_500 },
        { accountCode: "3100", credit: 4_500 },
      ],
    });

    const gaap = await getBalanceSheet(
      prisma,
      { entityCode: ENTITY_CODE, bookCode: "US_GAAP" },
      new Date("2026-01-31")
    );
    const tax = await getBalanceSheet(
      prisma,
      { entityCode: ENTITY_CODE, bookCode: "US_TAX" },
      new Date("2026-01-31")
    );
    expect(gaap.balances).toBe(true);
    expect(tax.balances).toBe(true);
    expect(gaap.totalAssets.equals(new Decimal(5_000))).toBe(true);
    expect(tax.totalAssets.equals(new Decimal(4_500))).toBe(true);
  });
});

// More invariant tests live in tests/seeded-company.test.ts —
// those run against the full Northwind Cloud seed and assert that the
// 6-month dataset balances at every month-end.
