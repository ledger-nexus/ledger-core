// Report Builder PR 2 — math primitive + row engine tests.
//
// Two layers:
//   1. Pure unit tests of runRowEngine with synthetic balance maps.
//      No DB. Validates the row evaluation logic in isolation.
//   2. Integration test against a fixture entity. Posts a few JEs,
//      verifies getAccountBalances returns expected numbers, runs the
//      IS template against it, confirms Net Income matches manually-
//      computed value.
//
// PR 3 (column engine) will add Northwind-seed-based tests that verify
// the builder's IS output matches the existing getIncomeStatement's
// output to the cent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { PrismaClient } from "@prisma/client";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import {
  getAccountBalances,
  filterBalances,
  type AccountBalances,
  type AccountBalance,
} from "@/lib/accounting/reports/builder/balances";
import { runRowEngine, formatCell } from "@/lib/accounting/reports/builder/row-engine";
import type { RowDef, ColumnScope } from "@/lib/accounting/reports/builder/types";

const prisma = new PrismaClient();

// ---- Synthetic balance helpers ------------------------------------

function makeBalance(over: Partial<AccountBalance> & { code: string; balance: Decimal }): AccountBalance {
  return {
    code: over.code,
    name: over.name ?? over.code,
    type: over.type ?? "ASSET",
    subtype: over.subtype ?? null,
    debit: over.debit ?? new Decimal(0),
    credit: over.credit ?? new Decimal(0),
    balance: over.balance,
    isContra: over.isContra ?? false,
    isBank: over.isBank ?? false,
    parentCode: over.parentCode ?? null,
  };
}

function makeBalances(balances: AccountBalance[]): AccountBalances {
  const map: AccountBalances = new Map();
  for (const b of balances) map.set(b.code, b);
  return map;
}

const SCOPE: ColumnScope = {
  entityCode: "TEST",
  bookCode: "US_GAAP",
};

// ---- Pure unit tests ----------------------------------------------

describe("filterBalances — AccountFilter semantics", () => {
  const balances = makeBalances([
    makeBalance({ code: "1000", type: "ASSET", subtype: "CASH", balance: new Decimal(1000) }),
    makeBalance({ code: "1200", type: "ASSET", subtype: "AR_TRADE", balance: new Decimal(500) }),
    makeBalance({ code: "2000", type: "LIABILITY", subtype: "AP_TRADE", balance: new Decimal(300) }),
    makeBalance({ code: "4000", type: "REVENUE", balance: new Decimal(2000) }),
    makeBalance({ code: "5000", type: "EXPENSE", subtype: "COGS", balance: new Decimal(800) }),
    makeBalance({ code: "6000", type: "EXPENSE", balance: new Decimal(400) }),
  ]);

  it("types filter", () => {
    const result = filterBalances(balances, { types: ["ASSET"] });
    expect(result.map((b) => b.code).sort()).toEqual(["1000", "1200"]);
  });

  it("subtypes filter", () => {
    const result = filterBalances(balances, { subtypes: ["CASH", "AP_TRADE"] });
    expect(result.map((b) => b.code).sort()).toEqual(["1000", "2000"]);
  });

  it("types AND subtypes filter (both must match)", () => {
    const result = filterBalances(balances, { types: ["ASSET"], subtypes: ["CASH"] });
    expect(result.map((b) => b.code)).toEqual(["1000"]);
  });

  it("includeCodes wins absolutely", () => {
    const result = filterBalances(balances, {
      types: ["ASSET"],
      includeCodes: ["4000"], // include overrides type filter
    });
    expect(result.map((b) => b.code)).toEqual(["4000"]);
  });

  it("excludeCodes subtracts", () => {
    const result = filterBalances(balances, {
      types: ["EXPENSE"],
      excludeCodes: ["5000"],
    });
    expect(result.map((b) => b.code)).toEqual(["6000"]);
  });
});

describe("runRowEngine — row kinds", () => {
  const balances = makeBalances([
    makeBalance({ code: "4000", type: "REVENUE", balance: new Decimal(-1000) }), // credit-normal
    makeBalance({ code: "5000", type: "EXPENSE", subtype: "COGS", balance: new Decimal(400) }),
    makeBalance({ code: "6000", type: "EXPENSE", balance: new Decimal(200) }),
  ]);

  it("ACCOUNTS with signFlip — Revenue presents positive", () => {
    const rows: RowDef[] = [
      {
        id: "rev",
        kind: "ACCOUNTS",
        label: "Revenue",
        filter: { types: ["REVENUE"] },
        signFlip: true,
      },
    ];
    const result = runRowEngine({ rows, balances, scope: SCOPE });
    // Revenue balance is -1000 (credit-normal in our convention).
    // signFlip → +1000 presents.
    expect(result.byId.get("rev")!.value.toString()).toBe("1000");
    expect(result.warnings).toEqual([]);
  });

  it("ACCOUNTS without signFlip — Expense presents positive (debit-normal)", () => {
    const rows: RowDef[] = [
      {
        id: "exp",
        kind: "ACCOUNTS",
        label: "Total expenses",
        filter: { types: ["EXPENSE"] },
      },
    ];
    const result = runRowEngine({ rows, balances, scope: SCOPE });
    expect(result.byId.get("exp")!.value.toString()).toBe("600"); // 400 + 200
  });

  it("FORMULA — Gross Profit = Revenue − COGS", () => {
    const rows: RowDef[] = [
      { id: "rev", kind: "ACCOUNTS", label: "Revenue", filter: { types: ["REVENUE"] }, signFlip: true },
      { id: "cogs", kind: "ACCOUNTS", label: "COGS", filter: { subtypes: ["COGS"] } },
      { id: "gp", kind: "FORMULA", label: "Gross profit", add: ["rev"], subtract: ["cogs"] },
    ];
    const result = runRowEngine({ rows, balances, scope: SCOPE });
    expect(result.byId.get("gp")!.value.toString()).toBe("600"); // 1000 − 400
    expect(result.byId.get("gp")!.isFormula).toBe(true);
  });

  it("SUBTOTAL — sum of children", () => {
    const rows: RowDef[] = [
      { id: "cogs", kind: "ACCOUNTS", label: "COGS", filter: { subtypes: ["COGS"] } },
      { id: "opex", kind: "ACCOUNTS", label: "OpEx", filter: { types: ["EXPENSE"], excludeCodes: ["5000"] } },
      { id: "total_exp", kind: "SUBTOTAL", label: "Total expenses", childIds: ["cogs", "opex"] },
    ];
    const result = runRowEngine({ rows, balances, scope: SCOPE });
    expect(result.byId.get("total_exp")!.value.toString()).toBe("600"); // 400 + 200
    expect(result.byId.get("total_exp")!.isSubtotal).toBe(true);
  });

  it("Cross-template reference resolves from crossTemplateValues", () => {
    const rows: RowDef[] = [
      { id: "ni_ref", kind: "FORMULA", label: "Net income (from IS)", add: ["@IS.ni"] },
    ];
    const crossTemplateValues = new Map([["@IS.ni", new Decimal(1500)]]);
    const result = runRowEngine({ rows, balances, scope: SCOPE, crossTemplateValues });
    expect(result.byId.get("ni_ref")!.value.toString()).toBe("1500");
    expect(result.warnings).toEqual([]);
  });

  it("Unresolved cross-template reference yields warning + default 0", () => {
    const rows: RowDef[] = [
      { id: "ni_ref", kind: "FORMULA", label: "Net income (from IS)", add: ["@IS.ni"] },
    ];
    const result = runRowEngine({ rows, balances, scope: SCOPE });
    expect(result.byId.get("ni_ref")!.value.toString()).toBe("0");
    expect(result.warnings).toContain("Cross-template reference unresolved: @IS.ni");
  });

  it("PERIOD_DELTA without openingBalances warns + defaults to 0 (PR 3 wires opening map via column engine)", () => {
    const rows: RowDef[] = [
      {
        id: "d_ar",
        kind: "PERIOD_DELTA",
        label: "Δ AR",
        filter: { subtypes: ["AR_TRADE"] },
        direction: "increase",
      },
    ];
    // Caller didn't provide openingBalances — row engine warns + 0.
    const result = runRowEngine({ rows, balances, scope: SCOPE });
    expect(result.byId.get("d_ar")!.value.toString()).toBe("0");
    expect(result.warnings[0]).toMatch(/PERIOD_DELTA.*openingBalances/);
  });

  it("PERIOD_DELTA WITH openingBalances computes closing − opening, applies direction", () => {
    const closing = makeBalances([
      makeBalance({ code: "1200", type: "ASSET", subtype: "AR_TRADE", balance: new Decimal(1200) }),
    ]);
    const opening = makeBalances([
      makeBalance({ code: "1200", type: "ASSET", subtype: "AR_TRADE", balance: new Decimal(500) }),
    ]);
    const rows: RowDef[] = [
      {
        id: "d_ar",
        kind: "PERIOD_DELTA",
        label: "Δ AR",
        filter: { subtypes: ["AR_TRADE"] },
        direction: "increase", // AR up → cash down, flip sign
      },
    ];
    const result = runRowEngine({
      rows,
      balances: closing,
      scope: SCOPE,
      openingBalances: opening,
    });
    // Δ = 1200 − 500 = 700. direction=increase → negate → −700.
    expect(result.byId.get("d_ar")!.value.toString()).toBe("-700");
  });

  it("HEADER + SPACER carry no value but render in document order", () => {
    const rows: RowDef[] = [
      { id: "h1", kind: "HEADER", label: "Revenue" },
      { id: "rev", kind: "ACCOUNTS", label: "Revenue", filter: { types: ["REVENUE"] }, signFlip: true },
      { id: "s1", kind: "SPACER" },
      { id: "h2", kind: "HEADER", label: "Expenses" },
    ];
    const result = runRowEngine({ rows, balances, scope: SCOPE });
    expect(result.rows.map((r) => r.id)).toEqual(["h1", "rev", "s1", "h2"]);
    expect(result.byId.get("h1")!.isHeader).toBe(true);
    expect(result.byId.get("s1")!.isSpacer).toBe(true);
    // HEADER/SPACER value is 0.
    expect(result.byId.get("h1")!.value.toString()).toBe("0");
    expect(result.byId.get("s1")!.value.toString()).toBe("0");
  });
});

describe("formatCell — money formatting", () => {
  it("positive number formats with thousands separators", () => {
    const cell = formatCell(
      { id: "x", label: "", value: new Decimal(1234567.89), contributingCodes: [] },
      SCOPE,
      false
    );
    expect(cell.display).toBe("1,234,567.89");
  });

  it("negative number formats with parens when parens:true (default)", () => {
    const cell = formatCell(
      { id: "x", label: "", value: new Decimal(-1234.56), contributingCodes: [] },
      SCOPE,
      false
    );
    expect(cell.display).toBe("(1,234.56)");
  });

  it("zero formats as 0.00", () => {
    const cell = formatCell(
      { id: "x", label: "", value: new Decimal(0), contributingCodes: [] },
      SCOPE,
      false
    );
    expect(cell.display).toBe("0.00");
  });

  it("includes drill-down when showDrillDown + codes present", () => {
    const cell = formatCell(
      { id: "x", label: "", value: new Decimal(100), contributingCodes: ["1000", "1010"] },
      SCOPE,
      true
    );
    expect(cell.drillDown).toEqual({
      accountCodes: ["1000", "1010"],
      scope: SCOPE,
    });
  });
});

// ---- Integration test: build a small fixture, verify end-to-end ---

const PREFIX = "RPTB"; // ReportBuilder
const ENT_CODE = `${PREFIX}_E1_${Date.now().toString(36)}`;
const BOOK_CODE = "US_GAAP";

let tenantId: string;
let entityId: string;

async function ensureFixture(): Promise<void> {
  tenantId = await getDefaultTenantId(prisma);
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: { code: BOOK_CODE, name: BOOK_CODE, basis: BOOK_CODE, reportingCurrencyId: "USD" },
    update: {},
  });
  // Seed minimal chart of accounts in the global namespace (already
  // present from Northwind seed; idempotent skip).
  const e = await prisma.legalEntity.create({
    data: { tenantId, code: ENT_CODE, name: ENT_CODE, functionalCurrencyId: "USD" },
  });
  entityId = e.id;
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId: e.id,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
  });
  for (let m = 1; m <= 12; m++) {
    await prisma.period.create({
      data: {
        tenantId,
        calendarId: cal.id,
        code: `2026-${String(m).padStart(2, "0")}`,
        ordinal: m,
        startsOn: new Date(2026, m - 1, 1),
        endsOn: new Date(2026, m, 0),
      },
    });
  }

  // Post a tiny test JE: $1000 revenue + $400 COGS + $200 OpEx in
  // April 2026. Net income = 1000 − 400 − 200 = $400.
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-04-15"),
    memo: "RPTB test sale",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 1000, credit: 0 }, // Cash in
      { accountCode: "4000", debit: 0, credit: 1000 }, // Revenue
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-04-15"),
    memo: "RPTB test cogs",
    source: "MANUAL",
    lines: [
      { accountCode: "5000", debit: 400, credit: 0 }, // COGS
      { accountCode: "1000", debit: 0, credit: 400 }, // Cash out
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-04-15"),
    memo: "RPTB test opex",
    source: "MANUAL",
    lines: [
      { accountCode: "6000", debit: 200, credit: 0 }, // OpEx
      { accountCode: "1000", debit: 0, credit: 200 }, // Cash out
    ],
  });
}

async function cleanup(): Promise<void> {
  if (!entityId) return;
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  const cals = await prisma.fiscalCalendar.findMany({ where: { entityId }, select: { id: true } });
  await prisma.period.deleteMany({ where: { calendarId: { in: cals.map((c) => c.id) } } });
  await prisma.fiscalCalendar.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
}

describe("integration — getAccountBalances + runRowEngine against fixture", () => {
  beforeAll(async () => {
    await ensureFixture();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("returns expected per-account balances for the test JEs", async () => {
    const balances = await getAccountBalances(prisma, {
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
      fromDate: new Date("2026-04-01"),
      toDate: new Date("2026-04-30"),
    });
    // Cash: +1000 in, −600 out → +400 net debit balance
    expect(balances.get("1000")?.balance.toString()).toBe("400");
    // Revenue: +1000 credit, sign-aware balance = −1000 (credit-normal)
    expect(balances.get("4000")?.balance.toString()).toBe("-1000");
    // COGS: +400 debit, debit-normal
    expect(balances.get("5000")?.balance.toString()).toBe("400");
    // OpEx: +200 debit, debit-normal
    expect(balances.get("6000")?.balance.toString()).toBe("200");
  });

  it("runs a tiny IS-shaped template and computes correct Net Income = 400", async () => {
    const balances = await getAccountBalances(prisma, {
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
      fromDate: new Date("2026-04-01"),
      toDate: new Date("2026-04-30"),
    });

    const rows: RowDef[] = [
      { id: "rev", kind: "ACCOUNTS", label: "Revenue", filter: { types: ["REVENUE"] }, signFlip: true },
      { id: "cogs", kind: "ACCOUNTS", label: "COGS", filter: { includeCodes: ["5000"] } },
      { id: "gp", kind: "FORMULA", label: "Gross profit", add: ["rev"], subtract: ["cogs"] },
      { id: "opex", kind: "ACCOUNTS", label: "OpEx", filter: { includeCodes: ["6000"] } },
      { id: "ni", kind: "FORMULA", label: "Net income", add: ["gp"], subtract: ["opex"] },
    ];

    const result = runRowEngine({
      rows,
      balances,
      scope: { entityCode: ENT_CODE, bookCode: BOOK_CODE },
    });

    expect(result.byId.get("rev")!.value.toString()).toBe("1000");
    expect(result.byId.get("cogs")!.value.toString()).toBe("400");
    expect(result.byId.get("gp")!.value.toString()).toBe("600");
    expect(result.byId.get("opex")!.value.toString()).toBe("200");
    expect(result.byId.get("ni")!.value.toString()).toBe("400");
    expect(result.warnings).toEqual([]);
  });
});
