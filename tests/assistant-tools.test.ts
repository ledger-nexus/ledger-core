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
const TENANT_SLUG = "askq-test";
const USER_EMAIL = "askq@test.local";
const AS_OF = new Date("2026-12-31");

const HAS_DB = !!process.env.DATABASE_URL;

let scope: AssistantScope;

describe.skipIf(!HAS_DB)("ask-your-ledger tool executor", () => {
  beforeAll(async () => {
    // DEDICATED tenant, not the default one. Sharing the default tenant
    // let other suites' shared (entityId-null) same-code accounts shadow
    // this suite's chart in by-code metadata maps — reproduced as the
    // cash-flow classifier dropping the credit-card line when run after
    // sub-ledgers/invariants. Per the repo fixture rules: mint your own.
    // Self-heal first: earlier versions of this suite seeded ASKQ_ENT under
    // the DEFAULT tenant — scrub the code GLOBALLY so exactly one ASKQ_ENT
    // can exist (postJournalEntry resolves by code; twins = wrong entity).
    const twins = await prisma.legalEntity.findMany({
      where: { code: ENTITY_CODE },
      select: { id: true },
    });
    for (const twin of twins) {
      await prisma.journalLine.deleteMany({ where: { entry: { entityId: twin.id } } });
      await prisma.journalEntry.deleteMany({ where: { entityId: twin.id } });
      await prisma.account.deleteMany({ where: { entityId: twin.id } });
      await prisma.legalEntity.delete({ where: { id: twin.id } });
    }
    const stale = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
    if (stale) {
      await prisma.journalLine.deleteMany({ where: { tenantId: stale.id } });
      await prisma.journalEntry.deleteMany({ where: { tenantId: stale.id } });
      await prisma.account.deleteMany({ where: { tenantId: stale.id } });
      await prisma.legalEntity.deleteMany({ where: { tenantId: stale.id } });
      await prisma.tenantMembership.deleteMany({ where: { tenantId: stale.id } });
      await prisma.tenant.delete({ where: { id: stale.id } });
    }
    // Reuse the fixture user rather than delete-and-recreate it. A hard
    // DELETE on app_user makes Postgres run the audit_log FK's referential
    // action, which the append-only rule pair (migration 0015) rewrites to
    // NOTHING — the delete then fails with "referential integrity query ...
    // gave unexpected result". That only bites on a DB where a prior run
    // already left the row, so CI's fresh container passed while every
    // rerun against the shared dev DB died in beforeAll. Upserting is
    // idempotent and keeps the append-only control armed; the suite's audit
    // trail is not under test here.
    const user = await prisma.user.upsert({
      where: { email: USER_EMAIL },
      create: { email: USER_EMAIL, displayName: "AskQ Test" },
      update: {},
    });
    const tenant = await prisma.tenant.create({
      data: { slug: TENANT_SLUG, name: "AskQ Test Tenant", ownerUserId: user.id },
    });
    scope = { tenantId: tenant.id, entityCode: ENTITY_CODE, bookCode: BOOK_CODE };

    await seed(tenant.id);
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

  it("get_cash_flow reports operating/financing split and reconciles to actual cash", async () => {
    const r = (await executeTool(
      prisma,
      scope,
      "get_cash_flow",
      { from: "2026-01-01", to: "2026-12-31" },
      AS_OF
    )) as {
      netIncome: string;
      operatingCashFlow: string;
      financingCashFlow: string;
      netCashFlow: string;
      endingCash: string;
      reconciles: boolean;
    };
    expect(r.netIncome).toBe("4500.00");
    // Credit-card balance +200 is a working-capital source of cash.
    expect(r.operatingCashFlow).toBe("4700.00");
    // Opening-balance equity is financing.
    expect(r.financingCashFlow).toBe("20000.00");
    expect(r.netCashFlow).toBe("24700.00");
    expect(r.endingCash).toBe("24700.00");
    expect(r.reconciles).toBe(true);
  });

  it("get_ar_aging / get_ap_aging return zeroed buckets when no open items exist", async () => {
    for (const tool of ["get_ar_aging", "get_ap_aging"] as const) {
      const r = (await executeTool(prisma, scope, tool, {}, AS_OF)) as {
        totalOpen: string;
        buckets: { bucket: string; total: string; items: number }[];
      };
      expect(r.totalOpen).toBe("0.00");
      expect(r.buckets.map((b) => b.bucket)).toEqual([
        "CURRENT",
        "1_30",
        "31_60",
        "61_90",
        "OVER_90",
      ]);
      expect(r.buckets.every((b) => b.total === "0.00" && b.items === 0)).toBe(true);
    }
  });

  it("get_book_tax_difference compares the session book against the tax book", async () => {
    const r = (await executeTool(
      prisma,
      scope,
      "get_book_tax_difference",
      { from: "2026-01-01", to: "2026-12-31" },
      AS_OF
    )) as {
      bookNetIncome: string;
      taxNetIncome: string;
      totalDelta: string;
      bookCode: string;
      taxBookCode: string;
    };
    expect(r.bookCode).toBe("US_GAAP");
    expect(r.taxBookCode).toBe("US_TAX");
    expect(r.bookNetIncome).toBe("4500.00"); // 5,000 salary − 500 groceries
    expect(r.taxNetIncome).toBe("4800.00"); // tax basis: 4,800 salary, no deduction
    expect(r.totalDelta).toBe("-300.00"); // book − tax
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
    { code: "1000", name: "Checking", type: "ASSET", normalBalance: "DEBIT", isBank: true, subtype: "CASH" },
    // Subtype drives the cash-flow classifier (a subtype-less liability is
    // honestly UNCATEGORIZED there) — model the card as an accrued liability.
    { code: "2000", name: "Credit Card", type: "LIABILITY", normalBalance: "CREDIT", isBank: false, subtype: "ACCRUED" },
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
          subtype: "subtype" in a ? (a as { subtype?: string }).subtype ?? null : null,
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
    tenantId: scope.tenantId,
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
  // Tax-basis view of the same year for book-tax difference: salary only,
  // recognized at 4,800 (a 200 timing difference vs the GAAP book's 5,000
  // and no grocery deduction — deltas are the point, not realism).
  await postJournalEntry(prisma, {
    tenantId: scope.tenantId,
    entityCode: ENTITY_CODE,
    bookCode: "US_TAX",
    currencyCode: "USD",
    documentDate: new Date("2026-02-15"),
    memo: "February salary (tax basis)",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 4800 },
      { accountCode: "4000", credit: 4800 },
    ],
  });
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
