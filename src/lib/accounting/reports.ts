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
//
// SECURITY: when `tenantId` is provided, the entity lookup is scoped
// to that tenant. Without it, a caller passing an entityCode that
// exists in another tenant would silently load THAT tenant's entity.
// All UI report callers MUST pass tenantId (from getCurrentScope).
// The optional fallback exists for legacy seed / single-tenant scripts.
async function resolveEntityBook(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string,
  tenantId?: string
): Promise<{ entityId: string; bookId: string; entityTenantId: string }> {
  const [entity, book] = await Promise.all([
    prisma.legalEntity.findFirst({
      where: tenantId ? { tenantId, code: entityCode } : { code: entityCode },
      select: { id: true, tenantId: true },
    }),
    prisma.book.findUnique({
      where: { code: bookCode },
      select: { id: true },
    }),
  ]);
  if (!entity) throw new Error(`Unknown entity: ${entityCode}`);
  if (!book) throw new Error(`Unknown book: ${bookCode}`);
  // The entity's own tenant — callers use it to scope account scans.
  // Shared accounts (entityId=null) exist per tenant, so "all shared
  // accounts" without a tenant filter would mix in other tenants' charts.
  return { entityId: entity.id, bookId: book.id, entityTenantId: entity.tenantId };
}

export interface ReportScope {
  entityCode: string;
  bookCode?: string;            // default "US_GAAP"
  /**
   * Tenant the entity must belong to. Strongly recommended for any UI
   * caller (pass from getCurrentScope). Omitting it falls back to the
   * legacy global lookup; in a multi-tenant world that can match the
   * wrong tenant's entity. Substrate seeds + scripts omit this.
   */
  tenantId?: string;
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  type: AccountType;
  debit: Decimal;   // sum of all debit lines on/before asOf
  credit: Decimal;  // sum of all credit lines on/before asOf
  // Net balance, expressed on the account's normal side.
  balance: Decimal;
  // Phase 7 hierarchy: parent account code (the parent's `code`, not id)
  // — null for roots / accounts with no parent. Carried on every row so
  // the renderer can build a tree via buildHierarchy().
  parentCode: string | null;
  isContra: boolean;
}

export async function getTrialBalance(
  prisma: PrismaClient,
  scope: ReportScope,
  asOf: Date
): Promise<{ rows: TrialBalanceRow[]; totalDebit: Decimal; totalCredit: Decimal }> {
  const { entityId, bookId, entityTenantId } = await resolveEntityBook(
    prisma,
    scope.entityCode,
    scope.bookCode ?? DEFAULT_BOOK,
    scope.tenantId
  );

  // Pull lines for the (entity, book) on/before asOf, grouped by account.
  // Include the parent's code (Phase 7 hierarchy) so reports can render
  // sub-totals without a second query.
  //
  // DELIBERATE: the per-account sums run in JS over decimal.js, not via
  // Prisma groupBy/_sum. The entity-specific-overrides-shared dedup below
  // has to happen in JS regardless, decimal.js summation is exact and
  // auditable, and row volumes here are small. Don't "optimize" this into
  // an aggregate without re-validating both points.
  //
  // tenantId pin: shared accounts (entityId=null) exist PER TENANT, so
  // without the filter every tenant's shared chart lands in this scan —
  // zero-balance rows from other tenants leak their codes/names, and the
  // same-code dedup below can shadow this tenant's real account.
  const rawAccounts = await prisma.account.findMany({
    where: {
      active: true,
      tenantId: entityTenantId,
      OR: [{ entityId: null }, { entityId }],
    },
    include: {
      lines: {
        where: {
          entry: { entityId, bookId, documentDate: { lte: asOf } },
        },
        select: { debit: true, credit: true },
      },
      parent: { select: { code: true } },
    },
    orderBy: { code: "asc" },
  });

  // Dedup: entity-specific account overrides shared (entityId=null) at
  // the same code. See getBalanceSheet for the full rationale.
  const byCode = new Map<string, (typeof rawAccounts)[number]>();
  for (const a of rawAccounts) {
    const existing = byCode.get(a.code);
    if (!existing || (a.entityId !== null && existing.entityId === null)) {
      byCode.set(a.code, a);
    }
  }
  const accounts = Array.from(byCode.values()).sort((a, b) =>
    a.code.localeCompare(b.code)
  );

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
      parentCode: acct.parent?.code ?? null,
      isContra: acct.isContra,
    };
  });

  return { rows, totalDebit, totalCredit };
}

/**
 * One row in a hierarchical section of a financial statement. `amount`
 * is the account's own period activity, normalized to the section's
 * natural sign (positive for the section's normal side; negative for a
 * contra account, which correctly DEDUCTS when summed).
 *
 * `parentCode` + `isContra` are carried here so the page renderer can
 * call buildHierarchy() without a second DB query.
 */
export interface FinancialStatementRow {
  code: string;
  name: string;
  amount: Decimal;
  parentCode: string | null;
  isContra: boolean;
}

export interface IncomeStatement {
  scope: { entityCode: string; bookCode: string };
  periodStart: Date;
  periodEnd: Date;
  revenue: FinancialStatementRow[];
  expenses: FinancialStatementRow[];
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
  const { entityId, bookId, entityTenantId } = await resolveEntityBook(prisma, scope.entityCode, bookCode, scope.tenantId);

  // Phase 7 hierarchy: include parent.code so the IS page renderer can
  // build a tree via buildHierarchy() without a second query.
  //
  // tenantId pin: shared accounts (entityId=null) exist PER TENANT, so
  // without the filter every tenant's shared chart lands in this scan —
  // zero-balance rows from other tenants leak their codes/names, and the
  // same-code dedup below can shadow this tenant's real account.
  const rawAccounts = await prisma.account.findMany({
    where: {
      active: true,
      tenantId: entityTenantId,
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
      parent: { select: { code: true } },
    },
    orderBy: { code: "asc" },
  });

  // Dedup: same pattern as getBalanceSheet — when both shared and
  // entity-specific accounts exist at the same code, prefer the
  // entity-specific one. Otherwise the IS would show two rows per
  // code (one with the entity's activity, one zero from the shared
  // chart), which is just visual noise.
  const byCode = new Map<string, (typeof rawAccounts)[number]>();
  for (const a of rawAccounts) {
    const existing = byCode.get(a.code);
    if (!existing || (a.entityId !== null && existing.entityId === null)) {
      byCode.set(a.code, a);
    }
  }
  const accounts = Array.from(byCode.values()).sort((a, b) =>
    a.code.localeCompare(b.code)
  );

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

    const parentCode = acct.parent?.code ?? null;
    if (acct.type === "REVENUE") {
      const amount = credit.minus(debit);
      revenue.push({ code: acct.code, name: acct.name, amount, parentCode, isContra: acct.isContra });
      totalRevenue = totalRevenue.plus(amount);
    } else {
      const amount = debit.minus(credit);
      expenses.push({ code: acct.code, name: acct.name, amount, parentCode, isContra: acct.isContra });
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
  assets: FinancialStatementRow[];
  liabilities: FinancialStatementRow[];
  equity: FinancialStatementRow[];
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
  const { entityId, bookId, entityTenantId } = await resolveEntityBook(prisma, scope.entityCode, bookCode, scope.tenantId);

  // Phase 7 hierarchy: include parent.code so the BS page renderer can
  // build a tree via buildHierarchy() without a second query.
  //
  // tenantId pin: shared accounts (entityId=null) exist PER TENANT, so
  // without the filter every tenant's shared chart lands in this scan —
  // zero-balance rows from other tenants leak their codes/names, and the
  // same-code dedup below can shadow this tenant's real account.
  const rawAccounts = await prisma.account.findMany({
    where: {
      active: true,
      tenantId: entityTenantId,
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
      parent: { select: { code: true } },
    },
    orderBy: { code: "asc" },
  });

  // Dedup: when both a shared (entityId=null) and an entity-specific
  // account exist at the same code, prefer the entity-specific one.
  // This mirrors postJournalEntry's resolution: an entity-specific
  // override means "use this for this entity," not "render both rows."
  // Without dedup, the BS would show two lines per code and
  // .find(c => c.code === X) becomes ambiguous.
  const byCode = new Map<string, (typeof rawAccounts)[number]>();
  for (const a of rawAccounts) {
    const existing = byCode.get(a.code);
    if (!existing || (a.entityId !== null && existing.entityId === null)) {
      byCode.set(a.code, a);
    }
  }
  const accounts = Array.from(byCode.values()).sort((a, b) =>
    a.code.localeCompare(b.code)
  );

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

    // Use the SECTION'S natural sign, not the account's effective sign.
    // For the Assets section, every line is on the DEBIT side, so the
    // amount = debit - credit. A contra-asset (Accumulated Depreciation,
    // Allowance for Doubtful Accounts) is credit-normal — its amount
    // here is therefore NEGATIVE, which correctly DEDUCTS from totalAssets
    // when summed. Same logic for Liabilities + Equity on the credit side
    // (contra-liabilities and treasury stock show as negative deductions).
    //
    // The earlier implementation used signFor(type, isContra) which gave
    // the contra account's effective normal side — that produced a
    // positive amount that got ADDED to its section, double-counting
    // the deduction and breaking the A = L + E identity by 2× the
    // contra balance.
    const sectionSign: 1 | -1 = acct.type === "ASSET" ? 1 : -1;
    const amount =
      sectionSign === 1 ? debit.minus(credit) : credit.minus(debit);

    const parentCode = acct.parent?.code ?? null;
    const row: FinancialStatementRow = {
      code: acct.code,
      name: acct.name,
      amount,
      parentCode,
      isContra: acct.isContra,
    };
    if (acct.type === "ASSET") {
      assets.push(row);
      totalAssets = totalAssets.plus(amount);
    } else if (acct.type === "LIABILITY") {
      liabilities.push(row);
      totalLiabilities = totalLiabilities.plus(amount);
    } else {
      equity.push(row);
      totalEquity = totalEquity.plus(amount);
    }
  }

  // Retained earnings = all P&L activity for this (entity, book) from the
  // beginning of time through asOf. Computed on the fly; production would
  // close periods and roll P&L into RE explicitly.
  const pnl = await getIncomeStatement(
    prisma,
    { entityCode: scope.entityCode, bookCode, tenantId: scope.tenantId },
    new Date("1900-01-01"),
    asOf
  );
  const retainedEarnings = pnl.netIncome;

  equity.push({
    code: "RE",
    name: "Retained Earnings (computed)",
    amount: retainedEarnings,
    // Synthetic row — no DB account, so no parent. Renders as a root
    // in the Equity hierarchy.
    parentCode: null,
    isContra: false,
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
