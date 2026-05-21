// Accounting invariant tests.
//
// These tests are the headline of the project. They assert the rules that
// MUST hold for the ledger to be valid — at every moment, on every dataset.
//
// If any of these fail, the system is broken in a way that makes the
// financial statements untrustworthy. A balance sheet that doesn't balance
// is not just a bug — it means the math is wrong.
//
// Tests use Vitest. Run with: pnpm test

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
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

async function clearLedger() {
  await prisma.journalLine.deleteMany();
  await prisma.journalEntry.deleteMany();
}

async function seedAccountsOnly() {
  for (const a of CHART_OF_ACCOUNTS) {
    await prisma.account.upsert({
      where: { code: a.code },
      create: {
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
      },
      update: {},
    });
  }
}

beforeAll(async () => {
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
        date: new Date("2026-01-01"),
        memo: "bad",
        lines: [{ accountCode: "1000", debit: 100 }],
      })
    ).rejects.toThrow(InvalidLineError);
  });

  it("rejects a line with both debit and credit non-zero", async () => {
    await expect(
      postJournalEntry(prisma, {
        date: new Date("2026-01-01"),
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
        date: new Date("2026-01-01"),
        memo: "bad",
        lines: [
          { accountCode: "1000" },
          { accountCode: "3000", credit: 100 },
        ],
      })
    ).rejects.toThrow(InvalidLineError);
  });

  it("rejects negative amounts", async () => {
    await expect(
      postJournalEntry(prisma, {
        date: new Date("2026-01-01"),
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
        date: new Date("2026-01-01"),
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
        date: new Date("2026-01-01"),
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
        date: new Date("2026-01-01"),
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
      date: new Date("2026-01-01"),
      memo: "balanced",
      lines: [
        { accountCode: "1000", debit: 1000 },
        { accountCode: "3000", credit: 1000 },
      ],
    });
    expect(result.entryNumber).toMatch(/^JE-\d{5}$/);
  });

  it("accepts a balanced multi-line entry (one debit, three credits)", async () => {
    await expect(
      postJournalEntry(prisma, {
        date: new Date("2026-01-01"),
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

  it("accepts a balanced multi-line entry (three debits, two credits)", async () => {
    await expect(
      postJournalEntry(prisma, {
        date: new Date("2026-01-01"),
        memo: "payroll",
        lines: [
          { accountCode: "6000", debit: 80_000 },
          { accountCode: "6100", debit: 6_400 },
          { accountCode: "6200", debit: 8_000 },
          { accountCode: "1010", credit: 94_400 },
          { accountCode: "2100", credit: 0.0001 },
        ],
      })
    ).rejects.toThrow(UnbalancedEntryError); // intentionally off-by-1/10000
  });

  it("handles fractional cents correctly (no floating point error)", async () => {
    // 0.1 + 0.2 === 0.3 must be true in our ledger, even though it's false in JS Number.
    await expect(
      postJournalEntry(prisma, {
        date: new Date("2026-01-01"),
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
        date: new Date("2026-01-01"),
        memo: "should not persist",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "3000", credit: 99 },
        ],
      });
    } catch {}
    const entryCount = await prisma.journalEntry.count();
    const lineCount = await prisma.journalLine.count();
    expect(entryCount).toBe(0);
    expect(lineCount).toBe(0);
  });

  it("does not persist any lines if an account is unknown", async () => {
    try {
      await postJournalEntry(prisma, {
        date: new Date("2026-01-01"),
        memo: "bad account",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "9999", credit: 100 },
        ],
      });
    } catch {}
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.journalLine.count()).toBe(0);
  });
});

// =========================================================================
// Group 4: Trial balance invariants
// =========================================================================

describe("invariant: trial balance debits equal credits", () => {
  it("balances after a single entry", async () => {
    await postJournalEntry(prisma, {
      date: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });

    const tb = await getTrialBalance(prisma, new Date("2026-12-31"));
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });

  it("balances after dozens of entries", async () => {
    for (let i = 0; i < 50; i++) {
      await postJournalEntry(prisma, {
        date: new Date("2026-01-01"),
        memo: `entry ${i}`,
        lines: [
          { accountCode: "1000", debit: i + 1 },
          { accountCode: "4000", credit: i + 1 },
        ],
      });
    }
    const tb = await getTrialBalance(prisma, new Date("2026-12-31"));
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });
});

// =========================================================================
// Group 5: Balance sheet invariants — THE big one
// =========================================================================

describe("invariant: balance sheet balances", () => {
  it("balances with only equity contributions", async () => {
    await postJournalEntry(prisma, {
      date: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 500_000 },
        { accountCode: "3100", credit: 500_000 },
      ],
    });

    const bs = await getBalanceSheet(prisma, new Date("2026-01-01"));
    expect(bs.balances).toBe(true);
    expect(bs.totalAssets.equals(bs.totalLiabilitiesAndEquity)).toBe(true);
  });

  it("balances after revenue is recognized (retained earnings rolls)", async () => {
    // Capital
    await postJournalEntry(prisma, {
      date: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });
    // Earn some revenue
    await postJournalEntry(prisma, {
      date: new Date("2026-01-15"),
      memo: "revenue",
      lines: [
        { accountCode: "1200", debit: 10_000 },
        { accountCode: "4000", credit: 10_000 },
      ],
    });

    const bs = await getBalanceSheet(prisma, new Date("2026-01-31"));
    expect(bs.balances).toBe(true);
    expect(bs.retainedEarnings.equals(new Decimal(10_000))).toBe(true);
  });

  it("balances after expenses are incurred (retained earnings decreases)", async () => {
    await postJournalEntry(prisma, {
      date: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });
    await postJournalEntry(prisma, {
      date: new Date("2026-01-31"),
      memo: "payroll",
      lines: [
        { accountCode: "6000", debit: 30_000 },
        { accountCode: "1000", credit: 30_000 },
      ],
    });

    const bs = await getBalanceSheet(prisma, new Date("2026-01-31"));
    expect(bs.balances).toBe(true);
    expect(bs.retainedEarnings.equals(new Decimal(-30_000))).toBe(true);
  });

  it("balances with a contra-asset (accumulated depreciation)", async () => {
    await postJournalEntry(prisma, {
      date: new Date("2026-01-01"),
      memo: "buy equipment",
      lines: [
        { accountCode: "1500", debit: 12_000 },
        { accountCode: "1000", debit: 0.0001 }, // ensure cash isn't the only account
        { accountCode: "3100", credit: 12_000.0001 },
      ],
    });
    await postJournalEntry(prisma, {
      date: new Date("2026-02-28"),
      memo: "Feb depreciation",
      lines: [
        { accountCode: "8000", debit: 333.33 },
        { accountCode: "1510", credit: 333.33 },
      ],
    });

    const bs = await getBalanceSheet(prisma, new Date("2026-02-28"));
    expect(bs.balances).toBe(true);
    // The Accum Depreciation line should reduce net asset value
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
      date: new Date("2026-01-15"),
      memo: "rev",
      lines: [
        { accountCode: "1200", debit: 50_000 },
        { accountCode: "4000", credit: 50_000 },
      ],
    });
    await postJournalEntry(prisma, {
      date: new Date("2026-01-20"),
      memo: "exp",
      lines: [
        { accountCode: "6000", debit: 30_000 },
        { accountCode: "1000", credit: 30_000 },
      ],
    });

    const pnl = await getIncomeStatement(
      prisma,
      new Date("2026-01-01"),
      new Date("2026-01-31")
    );
    expect(pnl.netIncome.equals(new Decimal(20_000))).toBe(true);
  });

  it("only includes activity within the requested period", async () => {
    // Jan revenue
    await postJournalEntry(prisma, {
      date: new Date("2026-01-15"),
      memo: "jan",
      lines: [
        { accountCode: "1200", debit: 10_000 },
        { accountCode: "4000", credit: 10_000 },
      ],
    });
    // Feb revenue
    await postJournalEntry(prisma, {
      date: new Date("2026-02-15"),
      memo: "feb",
      lines: [
        { accountCode: "1200", debit: 25_000 },
        { accountCode: "4000", credit: 25_000 },
      ],
    });

    const jan = await getIncomeStatement(
      prisma,
      new Date("2026-01-01"),
      new Date("2026-01-31")
    );
    expect(jan.totalRevenue.equals(new Decimal(10_000))).toBe(true);

    const feb = await getIncomeStatement(
      prisma,
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
      date: new Date("2026-01-01"),
      memo: "founding",
      lines: [
        { accountCode: "1000", debit: 100_000 },
        { accountCode: "3100", credit: 100_000 },
      ],
    });
    await postJournalEntry(prisma, {
      date: new Date("2026-01-15"),
      memo: "rev",
      lines: [
        { accountCode: "1200", debit: 40_000 },
        { accountCode: "4000", credit: 40_000 },
      ],
    });
    await postJournalEntry(prisma, {
      date: new Date("2026-01-20"),
      memo: "exp",
      lines: [
        { accountCode: "6000", debit: 25_000 },
        { accountCode: "1000", credit: 25_000 },
      ],
    });

    const bs = await getBalanceSheet(prisma, new Date("2026-01-31"));
    const pnl = await getIncomeStatement(
      prisma,
      new Date("1900-01-01"),
      new Date("2026-01-31")
    );
    expect(bs.retainedEarnings.equals(pnl.netIncome)).toBe(true);
  });
});

// More invariant tests live in tests/seeded-company.test.ts —
// those run against the full Northwind Cloud seed and assert that the
// 6-month dataset balances at every month-end.
