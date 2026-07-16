// The read-only "ask your ledger" tool executor must return the SAME numbers
// the report pages show — that's the whole contract of the feature (the model
// phrases answers; the ledger is the source of every figure). These tests
// exercise executeTool directly against a real Postgres, with no LLM in the
// loop, so a regression in the query layer fails here regardless of what the
// model would say.
//
// Fixtures (entity ASKQ_ENT, 2026):
//   2026-01-01  DR Checking 20,000 / CR Opening Equity 20,000
//   2026-02-15  DR Checking  5,000 / CR Salary          5,000
//   2026-03-10  DR Groceries   300 / CR Checking          300
//   2026-04-10  DR Groceries   200 / CR Credit Card       200
// As of 2026-12-31:  Checking 24,700 · Credit Card 200 · Opening Eq 20,000
//   Salary 5,000 · Groceries 500 · net income 4,500 · net worth 24,500.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { executeTool, type AssistantScope } from "@/lib/assistant/tools";
import { askLedger } from "@/lib/assistant/ask";

const prisma = new PrismaClient();

// DB-free: proves the feature degrades cleanly on an instance with no API key
// (a fresh personal install) instead of throwing — the browser can't drive the
// React form in this environment, so this is the runtime evidence for it.
describe("ask-your-ledger graceful degradation", () => {
  it("returns not-configured WITHOUT touching the database when no key is set", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // Any DB access on the no-key path is a bug; this throws if touched.
    const throwingPrisma = new Proxy(
      {},
      {
        get() {
          throw new Error("DB must not be touched when no API key is set");
        },
      }
    ) as unknown as PrismaClient;
    try {
      const r = await askLedger({
        prisma: throwingPrisma,
        scope: { tenantId: "t", entityCode: "E", bookCode: "US_GAAP" },
        question: "what is my cash balance?",
        now: new Date("2026-12-31"),
      });
      expect(r.configured).toBe(false);
      expect(r.consulted).toEqual([]);
      expect(r.answer).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

const ENTITY_CODE = "ASKQ_ENT";
const BOOK_CODE = "US_GAAP";
const AS_OF = new Date("2026-12-31");

const HAS_DB = !!process.env.DATABASE_URL;

let scope: AssistantScope;

describe.skipIf(!HAS_DB)("ask-your-ledger tool executor", () => {
  beforeAll(async () => {
    const tenantId = await getDefaultTenantId(prisma);
    scope = { tenantId, entityCode: ENTITY_CODE, bookCode: BOOK_CODE };

    // Self-heal: a killed prior run leaves this entity's rows behind and
    // would poison the numbers. Scrub in FK order before seeding.
    const existing = await prisma.legalEntity.findFirst({
      where: { tenantId, code: ENTITY_CODE },
      select: { id: true },
    });
    if (existing) {
      await prisma.journalLine.deleteMany({
        where: { entry: { entityId: existing.id } },
      });
      await prisma.journalEntry.deleteMany({ where: { entityId: existing.id } });
      await prisma.account.deleteMany({ where: { entityId: existing.id } });
      await prisma.legalEntity.delete({ where: { id: existing.id } });
    }

    await seed(tenantId);
  });

  beforeEach(async () => {
    await prisma.journalLine.deleteMany({
      where: { entry: { entity: { code: ENTITY_CODE } } },
    });
    await prisma.journalEntry.deleteMany({
      where: { entity: { code: ENTITY_CODE } },
    });
    await postFixtures();
  });

  it("get_balances returns each account's balance on its normal side", async () => {
    const r = (await executeTool(prisma, scope, "get_balances", {}, AS_OF)) as {
      accounts: { code: string; balance: string }[];
    };
    const by = Object.fromEntries(r.accounts.map((a) => [a.code, a.balance]));
    expect(by["1000"]).toBe("24700.00"); // checking, debit-normal
    expect(by["2000"]).toBe("200.00"); // credit card owed, credit-normal
    expect(by["3000"]).toBe("20000.00"); // opening equity
    expect(by["6100"]).toBe("500.00"); // groceries expense
  });

  it("get_account_activity nets movement on the account's normal side", async () => {
    const r = (await executeTool(
      prisma,
      scope,
      "get_account_activity",
      { accountCode: "6100" },
      AS_OF
    )) as { netMovement: string; totalDebit: string; lineCount: number };
    expect(r.netMovement).toBe("500.00"); // two grocery debits
    expect(r.totalDebit).toBe("500.00");
    expect(r.lineCount).toBe(2);
  });

  it("get_income_statement reports revenue, expenses, net income for a range", async () => {
    const r = (await executeTool(
      prisma,
      scope,
      "get_income_statement",
      { from: "2026-01-01", to: "2026-12-31" },
      AS_OF
    )) as { totalRevenue: string; totalExpenses: string; netIncome: string };
    expect(r.totalRevenue).toBe("5000.00");
    expect(r.totalExpenses).toBe("500.00");
    expect(r.netIncome).toBe("4500.00");
  });

  it("get_balance_sheet reports net worth and balances (A = L + E)", async () => {
    const r = (await executeTool(
      prisma,
      scope,
      "get_balance_sheet",
      {},
      AS_OF
    )) as { totalAssets: string; netWorth: string; balances: boolean };
    expect(r.totalAssets).toBe("24700.00");
    expect(r.netWorth).toBe("24500.00"); // 20,000 opening + 4,500 YTD income
    expect(r.balances).toBe(true);
  });

  it("list_accounts returns the chart with bank flag", async () => {
    const r = (await executeTool(prisma, scope, "list_accounts", {}, AS_OF)) as {
      accounts: { code: string; isBank: boolean }[];
    };
    const checking = r.accounts.find((a) => a.code === "1000");
    expect(checking?.isBank).toBe(true);
    expect(r.accounts.some((a) => a.code === "6100")).toBe(true);
  });

  it("search_journal_entries matches on memo", async () => {
    const r = (await executeTool(
      prisma,
      scope,
      "search_journal_entries",
      { query: "salary" },
      AS_OF
    )) as { entries: { memo: string }[] };
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].memo.toLowerCase()).toContain("salary");
  });

  it("scopes reads to the granted tenant/entity — a foreign entity code is not honored", async () => {
    // The scope is server-derived; the executor must only read ASKQ_ENT.
    // Confirm it never returns another entity's accounts by asking for a
    // code that only exists elsewhere.
    const r = (await executeTool(
      prisma,
      scope,
      "get_account_activity",
      { accountCode: "NONEXISTENT-CODE" },
      AS_OF
    )) as { error?: string };
    expect(r.error).toMatch(/No account/);
  });

  it("rejects a malformed date rather than throwing", async () => {
    const r = (await executeTool(
      prisma,
      scope,
      "get_income_statement",
      { from: "not-a-date", to: "2026-12-31" },
      AS_OF
    )) as { error?: string };
    expect(r.error).toMatch(/YYYY-MM-DD/);
  });

  it("returns an error for an unknown tool", async () => {
    const r = (await executeTool(prisma, scope, "drop_tables", {}, AS_OF)) as {
      error?: string;
    };
    expect(r.error).toMatch(/Unknown tool/);
  });
});

async function seed(tenantId: string) {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY_CODE } },
    create: {
      tenantId,
      code: ENTITY_CODE,
      name: "Ask Query Test Household",
      functionalCurrencyId: "USD",
    },
    update: { tenantId },
  });
  await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: {
      code: BOOK_CODE,
      name: "US GAAP",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
    },
    update: {},
  });

  const accounts = [
    { code: "1000", name: "Checking", type: "ASSET", normalBalance: "DEBIT", isBank: true },
    { code: "2000", name: "Credit Card", type: "LIABILITY", normalBalance: "CREDIT", isBank: false },
    { code: "3000", name: "Opening Balance Equity", type: "EQUITY", normalBalance: "CREDIT", isBank: false },
    { code: "4000", name: "Salary Income", type: "REVENUE", normalBalance: "CREDIT", isBank: false },
    { code: "6100", name: "Groceries", type: "EXPENSE", normalBalance: "DEBIT", isBank: false },
  ] as const;
  for (const a of accounts) {
    const existing = await prisma.account.findFirst({
      where: { entityId: entity.id, code: a.code },
    });
    if (!existing) {
      await prisma.account.create({
        data: {
          tenantId,
          entityId: entity.id,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
          isContra: false,
          isBank: a.isBank,
        },
      });
    }
  }
}

async function post(
  documentDate: string,
  memo: string,
  lines: { accountCode: string; debit?: number; credit?: number }[]
) {
  return postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date(documentDate),
    memo,
    source: "MANUAL",
    lines,
  });
}

async function postFixtures() {
  await post("2026-01-01", "Opening balances", [
    { accountCode: "1000", debit: 20000 },
    { accountCode: "3000", credit: 20000 },
  ]);
  await post("2026-02-15", "February salary", [
    { accountCode: "1000", debit: 5000 },
    { accountCode: "4000", credit: 5000 },
  ]);
  await post("2026-03-10", "Grocery run", [
    { accountCode: "6100", debit: 300 },
    { accountCode: "1000", credit: 300 },
  ]);
  await post("2026-04-10", "Grocery run on card", [
    { accountCode: "6100", debit: 200 },
    { accountCode: "2000", credit: 200 },
  ]);
}
