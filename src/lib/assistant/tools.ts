// Read-only GL tools for the "ask your ledger" assistant.
//
// This module is the load-bearing half of the feature and has NO dependency
// on the LLM: it declares the tools an assistant may call and executes each
// one against the SAME deterministic query layer the report pages use. The
// numbers a tool returns are therefore identical to what the rest of the app
// shows — the assistant never computes a figure, it only asks these tools
// what the ledger already says and phrases the answer.
//
// Because it's pure (prisma + scope in, JSON out), it's unit-tested directly.
// Correctness lives here; ask.ts is just the conversation around it.
//
// SCOPE IS SERVER-DERIVED. Every executor receives an AssistantScope resolved
// from the session (tenant + entity + book) and passes tenantId into every
// query. Tool *inputs* from the model only ever name an account code or a
// date range — never a tenant, entity, or book — so the model cannot widen
// its own read past the scope the caller granted.

import type { Prisma, PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import {
  getTrialBalance,
  getIncomeStatement,
  getBalanceSheet,
} from "@/lib/accounting/reports";
import { getCashFlowStatement } from "@/lib/accounting/reports/cash-flow";
import { getBookTaxDifference } from "@/lib/accounting/reports/book-tax-difference";
import { arAging, openArBalance } from "@/lib/accounting/sub-ledgers/ar";
import { apAging, openApBalance } from "@/lib/accounting/sub-ledgers/ap";

type Db = PrismaClient | Prisma.TransactionClient;

export interface AssistantScope {
  tenantId: string;
  entityCode: string;
  bookCode: string;
}

/** Anthropic tool definition shape (name + description + JSON input schema). */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

const DATE_PROP = {
  type: "string",
  description: "A calendar date as YYYY-MM-DD.",
} as const;

// The catalog the model sees. Descriptions are prescriptive about WHEN to
// reach for each tool — the model picks tools far better from "use this when
// the user asks about X" than from a bare statement of what the tool does.
export const TOOL_DEFS: ToolDef[] = [
  {
    name: "get_balances",
    description:
      "Return every account and its balance as of a date (a trial balance). Use this for 'what is my balance in X', 'how much cash do I have', 'what do I owe on my credit card' — any single-account or whole-ledger balance question. The balance is stated on the account's normal side (a positive number means more of what the account normally holds).",
    input_schema: {
      type: "object",
      properties: { asOf: DATE_PROP },
      additionalProperties: false,
    },
  },
  {
    name: "get_income_statement",
    description:
      "Return revenue, expenses, and net income for a date range. Use this for 'how much did I earn/spend', 'what was my income last month', 'am I in the black this year' — anything about flows over a period rather than a point-in-time balance.",
    input_schema: {
      type: "object",
      properties: { from: DATE_PROP, to: DATE_PROP },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_balance_sheet",
    description:
      "Return assets, liabilities, and equity as of a date, including net worth (total equity). Use this for 'what is my net worth', 'what are my assets', 'how much do I owe in total'.",
    input_schema: {
      type: "object",
      properties: { asOf: DATE_PROP },
      additionalProperties: false,
    },
  },
  {
    name: "list_accounts",
    description:
      "List the chart of accounts (code, name, type, whether it's a bank account). Use this to discover which account a question is about before pulling its balance or activity — e.g. find the 'groceries' expense account, or every bank account.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_account_activity",
    description:
      "Return the postings to ONE account over a date range: total debits, total credits, net movement, and the most recent lines. Use this for 'what did I spend on groceries', 'show me my checking activity', 'how much went to that vendor' — questions about what happened in an account, not just its ending balance. Look up the account code with list_accounts first if you don't have it.",
    input_schema: {
      type: "object",
      properties: {
        accountCode: {
          type: "string",
          description: "The account's code, e.g. '6100'.",
        },
        from: DATE_PROP,
        to: DATE_PROP,
      },
      required: ["accountCode"],
      additionalProperties: false,
    },
  },
  {
    name: "get_cash_flow",
    description:
      "Return the indirect-method cash flow statement for a date range: net income, operating / investing / financing cash flow, and the net change in cash. Use this for 'where did my cash go', 'how much cash did I generate', 'why is my cash down when I made money'.",
    input_schema: {
      type: "object",
      properties: { from: DATE_PROP, to: DATE_PROP },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_ar_aging",
    description:
      "Return accounts-receivable aging buckets (current, 1-30, 31-60, 61-90, over 90 days) with totals as of a date. Use this for 'who owes me money', 'how much AR is overdue', 'what receivables are outstanding'.",
    input_schema: {
      type: "object",
      properties: { asOf: DATE_PROP },
      additionalProperties: false,
    },
  },
  {
    name: "get_ap_aging",
    description:
      "Return accounts-payable aging buckets (current, 1-30, 31-60, 61-90, over 90 days) with totals as of a date. Use this for 'what bills do I owe', 'how much AP is overdue', 'what do I need to pay'.",
    input_schema: {
      type: "object",
      properties: { asOf: DATE_PROP },
      additionalProperties: false,
    },
  },
  {
    name: "get_book_tax_difference",
    description:
      "Compare this book against the tax book for a date range: book vs tax net income, total difference, and the permanent/temporary split (ASC 740 flavor). Use this for 'book vs tax', 'what are my book-tax differences', 'taxable income vs book income'.",
    input_schema: {
      type: "object",
      properties: {
        from: DATE_PROP,
        to: DATE_PROP,
        taxBookCode: {
          type: "string",
          description: "The tax-basis book code. Defaults to US_TAX.",
        },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "search_journal_entries",
    description:
      "Find posted journal entries by free-text (memo, entry number, line description, or party) and/or date range. Use this for 'find the entry for X', 'what did I book on that date', 'show entries mentioning rent'.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free text to match against memo / description / party.",
        },
        from: DATE_PROP,
        to: DATE_PROP,
      },
      additionalProperties: false,
    },
  },
];

// --- date parsing -----------------------------------------------------------
// The model hands us YYYY-MM-DD strings. Parse at UTC midnight and reject
// anything malformed so a bad date becomes a tool error the model can
// recover from, never a thrown 500.

function parseDate(s: string): Date | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** End-of-day UTC, so an `asOf` date includes everything posted that day. */
function endOfDay(d: Date): Date {
  return new Date(d.getTime() + (24 * 60 * 60 * 1000 - 1));
}

const dec = (v: Prisma.Decimal): Decimal => new Decimal(v.toString());
/** Money as an exact 2dp string — the model formats it for display. */
const money = (v: Decimal): string => v.toFixed(2);

export interface ToolResult {
  [k: string]: unknown;
}

/**
 * Execute one tool call. `now` is injected (not read from the clock) so the
 * function stays a pure input→output map that tests can pin to a fixed date.
 * Returns a plain JSON object; on any recoverable problem returns `{ error }`
 * so the model can adjust rather than the request failing.
 */
export async function executeTool(
  prisma: Db,
  scope: AssistantScope,
  name: string,
  input: Record<string, unknown>,
  now: Date
): Promise<ToolResult> {
  const reportScope = {
    entityCode: scope.entityCode,
    bookCode: scope.bookCode,
    tenantId: scope.tenantId,
  };

  switch (name) {
    case "get_balances": {
      const asOf = input.asOf
        ? parseDate(String(input.asOf))
        : endOfDay(now);
      if (!asOf) return { error: "asOf must be YYYY-MM-DD." };
      const tb = await getTrialBalance(prisma as PrismaClient, reportScope, asOf);
      return {
        asOf: asOf.toISOString().slice(0, 10),
        currency: "USD",
        accounts: tb.rows
          // Drop dead weight: zero-balance accounts just pad the context.
          .filter((r) => !r.balance.isZero())
          .map((r) => ({
            code: r.accountCode,
            name: r.accountName,
            type: r.type,
            balance: money(r.balance),
          })),
      };
    }

    case "get_income_statement": {
      const from = parseDate(String(input.from ?? ""));
      const to = parseDate(String(input.to ?? ""));
      if (!from || !to)
        return { error: "from and to must both be YYYY-MM-DD." };
      const is = await getIncomeStatement(
        prisma as PrismaClient,
        reportScope,
        from,
        endOfDay(to)
      );
      return {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        currency: "USD",
        totalRevenue: money(is.totalRevenue),
        totalExpenses: money(is.totalExpenses),
        netIncome: money(is.netIncome),
        revenue: is.revenue
          .filter((r) => !r.amount.isZero())
          .map((r) => ({ code: r.code, name: r.name, amount: money(r.amount) })),
        expenses: is.expenses
          .filter((r) => !r.amount.isZero())
          .map((r) => ({ code: r.code, name: r.name, amount: money(r.amount) })),
      };
    }

    case "get_balance_sheet": {
      const asOf = input.asOf ? parseDate(String(input.asOf)) : endOfDay(now);
      if (!asOf) return { error: "asOf must be YYYY-MM-DD." };
      const bs = await getBalanceSheet(prisma as PrismaClient, reportScope, asOf);
      const line = (r: { code: string; name: string; amount: Decimal }) => ({
        code: r.code,
        name: r.name,
        amount: money(r.amount),
      });
      return {
        asOf: asOf.toISOString().slice(0, 10),
        currency: "USD",
        totalAssets: money(bs.totalAssets),
        totalLiabilities: money(bs.totalLiabilities),
        netWorth: money(bs.totalEquity),
        balances: bs.balances,
        assets: bs.assets.filter((r) => !r.amount.isZero()).map(line),
        liabilities: bs.liabilities.filter((r) => !r.amount.isZero()).map(line),
        equity: bs.equity.filter((r) => !r.amount.isZero()).map(line),
      };
    }

    case "list_accounts": {
      // Mirrors the chart-of-accounts page query: tenant-scoped, this
      // entity plus shared (entityId null) accounts.
      const accounts = await prisma.account.findMany({
        where: {
          tenantId: scope.tenantId,
          active: true,
          OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
        },
        orderBy: [{ type: "asc" }, { code: "asc" }],
        select: {
          code: true,
          name: true,
          type: true,
          isBank: true,
        },
      });
      return { accounts };
    }

    case "get_account_activity": {
      const code = String(input.accountCode ?? "").trim();
      if (!code) return { error: "accountCode is required." };
      const from = input.from ? parseDate(String(input.from)) : null;
      const to = input.to ? parseDate(String(input.to)) : null;
      if (input.from && !from) return { error: "from must be YYYY-MM-DD." };
      if (input.to && !to) return { error: "to must be YYYY-MM-DD." };

      // Resolve the account the same way the detail page does: entity-
      // specific first, then a shared (entityId null) fallback.
      const account =
        (await prisma.account.findFirst({
          where: {
            tenantId: scope.tenantId,
            code,
            entity: { code: scope.entityCode },
          },
          select: { id: true, code: true, name: true, type: true, normalBalance: true },
        })) ??
        (await prisma.account.findFirst({
          where: { tenantId: scope.tenantId, code, entityId: null },
          select: { id: true, code: true, name: true, type: true, normalBalance: true },
        }));
      if (!account)
        return { error: `No account with code '${code}' in this scope.` };

      const documentDate: Prisma.DateTimeFilter = {};
      if (from) documentDate.gte = from;
      if (to) documentDate.lte = endOfDay(to);

      const lines = await prisma.journalLine.findMany({
        where: {
          accountId: account.id,
          entry: {
            entity: { code: scope.entityCode },
            book: { code: scope.bookCode },
            ...(from || to ? { documentDate } : {}),
          },
        },
        orderBy: [
          { entry: { documentDate: "desc" } },
          { entry: { entryNumber: "desc" } },
          { lineNo: "desc" },
        ],
        select: {
          debit: true,
          credit: true,
          description: true,
          party: { select: { displayName: true } },
          entry: { select: { entryNumber: true, documentDate: true, memo: true } },
        },
      });

      // Net movement on the account's normal side — the same convention the
      // register uses, so "spent on groceries" reads as a positive number
      // on an expense (debit-normal) account.
      const normalIsDebit = account.normalBalance === "DEBIT";
      let totalDebit = new Decimal(0);
      let totalCredit = new Decimal(0);
      for (const l of lines) {
        totalDebit = totalDebit.plus(dec(l.debit));
        totalCredit = totalCredit.plus(dec(l.credit));
      }
      const net = normalIsDebit
        ? totalDebit.minus(totalCredit)
        : totalCredit.minus(totalDebit);

      const MAX_LINES = 40;
      return {
        account: {
          code: account.code,
          name: account.name,
          type: account.type,
        },
        currency: "USD",
        from: from ? from.toISOString().slice(0, 10) : "beginning",
        to: to ? to.toISOString().slice(0, 10) : "latest",
        lineCount: lines.length,
        totalDebit: money(totalDebit),
        totalCredit: money(totalCredit),
        netMovement: money(net),
        lines: lines.slice(0, MAX_LINES).map((l) => ({
          date: l.entry.documentDate.toISOString().slice(0, 10),
          entry: l.entry.entryNumber,
          description: l.description ?? l.entry.memo ?? "",
          party: l.party?.displayName ?? null,
          debit: money(dec(l.debit)),
          credit: money(dec(l.credit)),
        })),
        truncated: lines.length > MAX_LINES,
      };
    }

    case "search_journal_entries": {
      const q = typeof input.query === "string" ? input.query.trim() : "";
      const from = input.from ? parseDate(String(input.from)) : null;
      const to = input.to ? parseDate(String(input.to)) : null;
      if (input.from && !from) return { error: "from must be YYYY-MM-DD." };
      if (input.to && !to) return { error: "to must be YYYY-MM-DD." };

      const documentDate: Prisma.DateTimeFilter = {};
      if (from) documentDate.gte = from;
      if (to) documentDate.lte = endOfDay(to);

      const search: Prisma.JournalEntryWhereInput = q
        ? {
            OR: [
              { memo: { contains: q, mode: "insensitive" } },
              { entryNumber: { contains: q, mode: "insensitive" } },
              { lines: { some: { description: { contains: q, mode: "insensitive" } } } },
              { lines: { some: { party: { code: { contains: q, mode: "insensitive" } } } } },
            ],
          }
        : {};

      const MAX = 25;
      const entries = await prisma.journalEntry.findMany({
        where: {
          tenantId: scope.tenantId,
          entity: { code: scope.entityCode },
          book: { code: scope.bookCode },
          ...(from || to ? { documentDate } : {}),
          ...search,
        },
        orderBy: [{ documentDate: "desc" }, { entryNumber: "desc" }],
        take: MAX + 1,
        select: {
          entryNumber: true,
          documentDate: true,
          memo: true,
          source: true,
        },
      });

      return {
        query: q || null,
        matchCount: Math.min(entries.length, MAX),
        entries: entries.slice(0, MAX).map((e) => ({
          entry: e.entryNumber,
          date: e.documentDate.toISOString().slice(0, 10),
          memo: e.memo ?? "",
          source: e.source,
        })),
        truncated: entries.length > MAX,
      };
    }

    case "get_cash_flow": {
      const from = parseDate(String(input.from ?? ""));
      const to = parseDate(String(input.to ?? ""));
      if (!from || !to) return { error: "from and to must both be YYYY-MM-DD." };
      const cf = await getCashFlowStatement(
        prisma as PrismaClient,
        reportScope,
        from,
        endOfDay(to)
      );
      const line = (l: { accountName: string; cashImpact: Decimal }) => ({
        name: l.accountName,
        cashImpact: money(l.cashImpact),
      });
      return {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        currency: "USD",
        netIncome: money(cf.netIncome),
        operatingCashFlow: money(cf.operatingCashFlow),
        investingCashFlow: money(cf.investingCashFlow),
        financingCashFlow: money(cf.financingCashFlow),
        netCashFlow: money(cf.netCashFlow),
        beginningCash: money(cf.beginningCash),
        endingCash: money(cf.endingCash),
        reconciles: cf.reconciles,
        nonCashAddBacks: cf.nonCashAddBacks.map(line),
        workingCapitalChanges: cf.workingCapitalChanges.map(line),
        investingItems: cf.investingItems.map(line),
        financingItems: cf.financingItems.map(line),
      };
    }

    case "get_ar_aging":
    case "get_ap_aging": {
      const asOf = input.asOf ? parseDate(String(input.asOf)) : endOfDay(now);
      if (!asOf) return { error: "asOf must be YYYY-MM-DD." };
      const isAr = name === "get_ar_aging";
      const [buckets, total] = await Promise.all([
        (isAr ? arAging : apAging)(
          prisma as PrismaClient,
          scope.entityCode,
          scope.bookCode,
          asOf,
          scope.tenantId
        ),
        (isAr ? openArBalance : openApBalance)(
          prisma as PrismaClient,
          scope.entityCode,
          scope.bookCode,
          scope.tenantId
        ),
      ]);
      return {
        asOf: asOf.toISOString().slice(0, 10),
        currency: "USD",
        kind: isAr ? "receivables (owed to you)" : "payables (you owe)",
        totalOpen: money(total),
        buckets: buckets.map((b) => ({
          bucket: b.bucket,
          total: money(b.totalBalance),
          items: b.itemCount,
        })),
      };
    }

    case "get_book_tax_difference": {
      const from = parseDate(String(input.from ?? ""));
      const to = parseDate(String(input.to ?? ""));
      if (!from || !to) return { error: "from and to must both be YYYY-MM-DD." };
      const taxBookCode =
        typeof input.taxBookCode === "string" && input.taxBookCode.trim()
          ? input.taxBookCode.trim()
          : "US_TAX";
      const btd = await getBookTaxDifference(prisma as PrismaClient, {
        entityCode: scope.entityCode,
        fromBookCode: scope.bookCode,
        toBookCode: taxBookCode,
        periodStart: from,
        periodEnd: endOfDay(to),
        tenantId: scope.tenantId,
      });
      const row = (r: {
        accountCode: string;
        accountName: string;
        delta: Decimal;
        classification: string;
      }) => ({
        code: r.accountCode,
        name: r.accountName,
        delta: money(r.delta),
        classification: r.classification,
      });
      return {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        currency: "USD",
        bookCode: scope.bookCode,
        taxBookCode,
        bookNetIncome: money(btd.bookNetIncome),
        taxNetIncome: money(btd.taxNetIncome),
        totalDelta: money(btd.totalDelta),
        permanentDeltaTotal: money(btd.permanentDeltaTotal),
        temporaryDeltaTotal: money(btd.temporaryDeltaTotal),
        pnlDifferences: btd.pnlRows.filter((r) => !r.delta.isZero()).map(row),
      };
    }

    default:
      return { error: `Unknown tool '${name}'.` };
  }
}
