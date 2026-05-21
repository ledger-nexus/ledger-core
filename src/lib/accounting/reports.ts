// Report generators.
//
// All three reports read directly from the JournalLine table on every request.
// No materialized views, no caching, no "rollup" tables. At portfolio scale
// (thousands of lines) this is plenty fast and dramatically simpler.
//
// Design principle: reports are pure functions of the ledger state on a given
// date. Given the same ledger and the same date, you get the same report —
// always. No "as of last sync" — always "as of right now".

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { AccountType, signFor } from "./types";

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  type: AccountType;
  debit: Decimal;   // sum of all debit lines on/before asOf
  credit: Decimal;  // sum of all credit lines on/before asOf
  // Net balance, expressed on the account's normal side.
  // For an Asset: debit - credit. For a Liability: credit - debit.
  balance: Decimal;
}

export async function getTrialBalance(
  prisma: PrismaClient,
  asOf: Date
): Promise<{ rows: TrialBalanceRow[]; totalDebit: Decimal; totalCredit: Decimal }> {
  const accounts = await prisma.account.findMany({
    where: { active: true },
    include: {
      lines: {
        where: { entry: { date: { lte: asOf } } },
        select: { debit: true, credit: true },
      },
    },
    orderBy: { code: "asc" },
  });

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  const rows = accounts.map((acct) => {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const line of acct.lines) {
      debit = debit.plus(new Decimal(line.debit.toString()));
      credit = credit.plus(new Decimal(line.credit.toString()));
    }

    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);

    // Balance expressed on the account's normal side.
    const normal = signFor(acct.type as AccountType, acct.isContra);
    const balance = normal === 1 ? debit.minus(credit) : credit.minus(debit);

    return {
      accountCode: acct.code,
      accountName: acct.name,
      type: acct.type as AccountType,
      debit,
      credit,
      balance,
    };
  });

  return { rows, totalDebit, totalCredit };
}

export interface IncomeStatement {
  periodStart: Date;
  periodEnd: Date;
  revenue: { code: string; name: string; amount: Decimal }[];
  expenses: { code: string; name: string; amount: Decimal }[];
  totalRevenue: Decimal;
  totalExpenses: Decimal;
  netIncome: Decimal;
}

export async function getIncomeStatement(
  prisma: PrismaClient,
  periodStart: Date,
  periodEnd: Date
): Promise<IncomeStatement> {
  const accounts = await prisma.account.findMany({
    where: {
      active: true,
      type: { in: ["REVENUE", "EXPENSE"] },
    },
    include: {
      lines: {
        where: {
          entry: { date: { gte: periodStart, lte: periodEnd } },
        },
        select: { debit: true, credit: true },
      },
    },
    orderBy: { code: "asc" },
  });

  const revenue: IncomeStatement["revenue"] = [];
  const expenses: IncomeStatement["expenses"] = [];
  let totalRevenue = new Decimal(0);
  let totalExpenses = new Decimal(0);

  for (const acct of accounts) {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const line of acct.lines) {
      debit = debit.plus(new Decimal(line.debit.toString()));
      credit = credit.plus(new Decimal(line.credit.toString()));
    }

    // Revenue normal balance is CREDIT, so revenue amount = credit - debit.
    // Expense normal balance is DEBIT, so expense amount = debit - credit.
    if (acct.type === "REVENUE") {
      const amount = credit.minus(debit);
      revenue.push({ code: acct.code, name: acct.name, amount });
      totalRevenue = totalRevenue.plus(amount);
    } else {
      const amount = debit.minus(credit);
      expenses.push({ code: acct.code, name: acct.name, amount });
      totalExpenses = totalExpenses.plus(amount);
    }
  }

  return {
    periodStart,
    periodEnd,
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    netIncome: totalRevenue.minus(totalExpenses),
  };
}

export interface BalanceSheet {
  asOf: Date;
  assets: { code: string; name: string; amount: Decimal }[];
  liabilities: { code: string; name: string; amount: Decimal }[];
  equity: { code: string; name: string; amount: Decimal }[];
  totalAssets: Decimal;
  totalLiabilities: Decimal;
  totalEquity: Decimal;          // includes current-period net income via retained earnings calc
  retainedEarnings: Decimal;     // YTD net income, computed not stored
  totalLiabilitiesAndEquity: Decimal;
  // The invariant: totalAssets === totalLiabilitiesAndEquity.
  // We return this so callers (and tests) can assert it.
  balances: boolean;
}

export async function getBalanceSheet(
  prisma: PrismaClient,
  asOf: Date
): Promise<BalanceSheet> {
  // Get permanent-account balances as of `asOf`.
  const accounts = await prisma.account.findMany({
    where: {
      active: true,
      type: { in: ["ASSET", "LIABILITY", "EQUITY"] },
    },
    include: {
      lines: {
        where: { entry: { date: { lte: asOf } } },
        select: { debit: true, credit: true },
      },
    },
    orderBy: { code: "asc" },
  });

  const assets: BalanceSheet["assets"] = [];
  const liabilities: BalanceSheet["liabilities"] = [];
  const equity: BalanceSheet["equity"] = [];
  let totalAssets = new Decimal(0);
  let totalLiabilities = new Decimal(0);
  let totalEquity = new Decimal(0);

  for (const acct of accounts) {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const line of acct.lines) {
      debit = debit.plus(new Decimal(line.debit.toString()));
      credit = credit.plus(new Decimal(line.credit.toString()));
    }

    const sign = signFor(acct.type as AccountType, acct.isContra);
    const amount = sign === 1 ? debit.minus(credit) : credit.minus(debit);

    if (acct.type === "ASSET") {
      assets.push({ code: acct.code, name: acct.name, amount });
      totalAssets = totalAssets.plus(amount);
    } else if (acct.type === "LIABILITY") {
      liabilities.push({ code: acct.code, name: acct.name, amount });
      totalLiabilities = totalLiabilities.plus(amount);
    } else {
      equity.push({ code: acct.code, name: acct.name, amount });
      totalEquity = totalEquity.plus(amount);
    }
  }

  // Retained earnings = all P&L activity from "the beginning of time" through asOf.
  // In a real system you'd close periods and roll P&L into retained earnings explicitly;
  // here we compute it on the fly, which is simpler and equivalent.
  const pnl = await getIncomeStatement(prisma, new Date("1900-01-01"), asOf);
  const retainedEarnings = pnl.netIncome;

  // Add retained earnings into equity as a synthetic line.
  equity.push({
    code: "RE",
    name: "Retained Earnings (computed)",
    amount: retainedEarnings,
  });
  totalEquity = totalEquity.plus(retainedEarnings);

  const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity);

  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    retainedEarnings,
    totalLiabilitiesAndEquity,
    balances: totalAssets.equals(totalLiabilitiesAndEquity),
  };
}
