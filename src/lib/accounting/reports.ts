// Report generators.
//
// All three reports read directly from the JournalLine table on every request.
// No materialized views, no caching, no "rollup" tables. At portfolio scale
// (thousands of lines) this is plenty fast and dramatically simpler.
//
// Design principle: reports are pure functions of the ledger state on a given
// (entity, book, date). Same inputs → same outputs, always.
//
// Multi-book note: every report is scoped to ONE (entity, book). Cross-book
// comparison (e.g. ASC 740 book-tax difference) is a separate report that
// diffs two single-book report results — not a fourth book-agnostic report.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { AccountType, signFor } from "./types";

const DEFAULT_BOOK = "US_GAAP";

// Internal helper: resolve (entityCode, bookCode) -> ids in one query.
async function resolveEntityBook(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string
): Promise<{ entityId: string; bookId: string }> {
  const [entity, book] = await Promise.all([
    prisma.legalEntity.findUnique({
      where: { code: entityCode },
      select: { id: true },
    }),
    prisma.book.findUnique({
      where: { code: bookCode },
      select: { id: true },
    }),
  ]);
  if (!entity) throw new Error(`Unknown entity: ${entityCode}`);
  if (!book) throw new Error(`Unknown book: ${bookCode}`);
  return { entityId: entity.id, bookId: book.id };
}

export interface ReportScope {
  entityCode: string;
  bookCode?: string;            // default "US_GAAP"
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  type: AccountType;
  debit: Decimal;   // sum of all debit lines on/before asOf
  credit: Decimal;  // sum of all credit lines on/before asOf
  // Net balance, expressed on the account's normal side.
  balance: Decimal;
}

export async function getTrialBalance(
  prisma: PrismaClient,
  scope: ReportScope,
  asOf: Date
): Promise<{ rows: TrialBalanceRow[]; totalDebit: Decimal; totalCredit: Decimal }> {
  const { entityId, bookId } = await resolveEntityBook(
    prisma,
    scope.entityCode,
    scope.bookCode ?? DEFAULT_BOOK
  );

  // Pull lines for the (entity, book) on/before asOf, grouped by account.
  const accounts = await prisma.account.findMany({
    where: {
      active: true,
      OR: [{ entityId: null }, { entityId }],
    },
    include: {
      lines: {
        where: {
          entry: { entityId, bookId, documentDate: { lte: asOf } },
        },
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
  scope: { entityCode: string; bookCode: string };
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
  scope: ReportScope,
  periodStart: Date,
  periodEnd: Date
): Promise<IncomeStatement> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;
  const { entityId, bookId } = await resolveEntityBook(prisma, scope.entityCode, bookCode);

  const accounts = await prisma.account.findMany({
    where: {
      active: true,
      type: { in: ["REVENUE", "EXPENSE"] },
      OR: [{ entityId: null }, { entityId }],
    },
    include: {
      lines: {
        where: {
          entry: {
            entityId,
            bookId,
            documentDate: { gte: periodStart, lte: periodEnd },
          },
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
    scope: { entityCode: scope.entityCode, bookCode },
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
  scope: { entityCode: string; bookCode: string };
  asOf: Date;
  assets: { code: string; name: string; amount: Decimal }[];
  liabilities: { code: string; name: string; amount: Decimal }[];
  equity: { code: string; name: string; amount: Decimal }[];
  totalAssets: Decimal;
  totalLiabilities: Decimal;
  totalEquity: Decimal;          // includes current-period net income via retained earnings calc
  retainedEarnings: Decimal;     // YTD net income, computed not stored
  totalLiabilitiesAndEquity: Decimal;
  balances: boolean;             // totalAssets === totalLiabilitiesAndEquity
}

export async function getBalanceSheet(
  prisma: PrismaClient,
  scope: ReportScope,
  asOf: Date
): Promise<BalanceSheet> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;
  const { entityId, bookId } = await resolveEntityBook(prisma, scope.entityCode, bookCode);

  const accounts = await prisma.account.findMany({
    where: {
      active: true,
      type: { in: ["ASSET", "LIABILITY", "EQUITY"] },
      OR: [{ entityId: null }, { entityId }],
    },
    include: {
      lines: {
        where: {
          entry: { entityId, bookId, documentDate: { lte: asOf } },
        },
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

  // Retained earnings = all P&L activity for this (entity, book) from the
  // beginning of time through asOf. Computed on the fly; production would
  // close periods and roll P&L into RE explicitly.
  const pnl = await getIncomeStatement(
    prisma,
    { entityCode: scope.entityCode, bookCode },
    new Date("1900-01-01"),
    asOf
  );
  const retainedEarnings = pnl.netIncome;

  equity.push({
    code: "RE",
    name: "Retained Earnings (computed)",
    amount: retainedEarnings,
  });
  totalEquity = totalEquity.plus(retainedEarnings);

  const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity);

  return {
    scope: { entityCode: scope.entityCode, bookCode },
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
