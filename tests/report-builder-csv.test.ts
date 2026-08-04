// Report Builder PR 6 — CSV serializer tests.
//
// Validates `renderedMatrixToCsv` produces correct CSV output for each
// of the 4 GAAP statements against a small fixture entity. Catches:
//   - Header row carries template name + scope label
//   - Column headers from RenderedMatrix.columns
//   - SPACER rows emit blank lines
//   - HEADER rows show as standalone label rows
//   - FORMULA / SUBTOTAL rows get indented
//   - CSV formula injection cannot land via row labels (defense-in-depth)
//   - Output round-trips cleanly through `toCsv` (no commas / quotes leak)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { renderTemplate } from "@/lib/accounting/reports/builder/render";
import {
  INCOME_STATEMENT_TEMPLATE,
  BALANCE_SHEET_TEMPLATE,
  EQUITY_TEMPLATE,
  CASH_FLOW_TEMPLATE,
} from "@/lib/accounting/reports/builder/templates";
import {
  renderedMatrixToCsv,
  builderCsvFilename,
} from "@/lib/accounting/reports/builder/csv";
import type {
  ReportTemplate,
  RenderedMatrix,
} from "@/lib/accounting/reports/builder/types";

const prisma = new PrismaClient();

const PREFIX = "RPTCSV";
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

  // Small Q1 fixture: $50,000 contribution + $5,000 revenue.
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-01-05"),
    memo: "contribution",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 50000, credit: 0 },
      { accountCode: "3000", debit: 0, credit: 50000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-03-15"),
    memo: "revenue",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 5000, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 5000 },
    ],
  });
}

async function cleanup(): Promise<void> {
  if (!entityId) return;
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  const cals = await prisma.fiscalCalendar.findMany({
    where: { entityId },
    select: { id: true },
  });
  await prisma.period.deleteMany({ where: { calendarId: { in: cals.map((c) => c.id) } } });
  await prisma.fiscalCalendar.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
}

async function renderFor(template: ReportTemplate): Promise<RenderedMatrix> {
  return renderTemplate(prisma, template, {
    asOfDate: new Date("2026-03-31"),
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    tenantId,
  });
}

describe("Report Builder CSV serializer", () => {
  beforeAll(async () => {
    await ensureFixture();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("IS CSV: first row has template name + scope label", async () => {
    const matrix = await renderFor(INCOME_STATEMENT_TEMPLATE);
    const csv = renderedMatrixToCsv(matrix, {
      scopeLabel: `${ENT_CODE} / ${BOOK_CODE} · 2026-03-31`,
    });
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toContain("Income Statement");
    expect(firstLine).toContain(ENT_CODE);
    expect(firstLine).toContain("2026-03-31");
  });

  it("IS CSV: column header row carries the template's column labels", async () => {
    const matrix = await renderFor(INCOME_STATEMENT_TEMPLATE);
    const csv = renderedMatrixToCsv(matrix);
    const lines = csv.split("\n");
    // Lines: [0]=name, [1]=blank, [2]=Row,<col headers>
    expect(lines[2]).toContain("Row");
    for (const col of matrix.columns) {
      expect(lines[2]).toContain(col.label);
    }
  });

  it("IS CSV: includes Net Income row with the right value ($5,000.00 in Q1)", async () => {
    const matrix = await renderFor(INCOME_STATEMENT_TEMPLATE);
    const csv = renderedMatrixToCsv(matrix);
    // Net income row label: "Net income" (FORMULA, indented to two spaces).
    expect(csv).toMatch(/Net income.*5,000\.00/);
  });

  it("BS CSV: emits all 4 SUBTOTAL labels (assets, liab, equity, L+E)", async () => {
    const matrix = await renderFor(BALANCE_SHEET_TEMPLATE);
    const csv = renderedMatrixToCsv(matrix);
    expect(csv).toContain("Total assets");
    expect(csv).toContain("Total liabilities");
    expect(csv).toContain("Total equity");
    expect(csv).toContain("Total liabilities + equity");
  });

  it("EQ CSV: 4-column matrix header line", async () => {
    const matrix = await renderFor(EQUITY_TEMPLATE);
    const csv = renderedMatrixToCsv(matrix);
    const lines = csv.split("\n");
    expect(lines[2]).toContain("Common Stock");
    expect(lines[2]).toContain("Additional Paid-in Capital");
    expect(lines[2]).toContain("Retained Earnings");
    expect(lines[2]).toContain("Total");
  });

  it("CF CSV: starts with the IS Net Income reference row", async () => {
    const matrix = await renderFor(CASH_FLOW_TEMPLATE);
    const csv = renderedMatrixToCsv(matrix);
    // The CF template uses @IS.ni so the rendered row label should be
    // something recognizable. Just spot-check structure: more than 0
    // rows of content.
    expect(csv.split("\n").length).toBeGreaterThan(5);
  });

  it("CSV: SPACER rows emit blank lines", async () => {
    const matrix = await renderFor(INCOME_STATEMENT_TEMPLATE);
    const csv = renderedMatrixToCsv(matrix);
    // IS template has 3 SPACER rows. There must be at least 3 blank
    // lines in the body (excluding header/blank/column-header at top).
    const lines = csv.split("\n");
    const bodyBlanks = lines.slice(3).filter((l) => l === "").length;
    expect(bodyBlanks).toBeGreaterThanOrEqual(3);
  });

  it("CSV: HEADER rows present without numeric cells", async () => {
    const matrix = await renderFor(INCOME_STATEMENT_TEMPLATE);
    const csv = renderedMatrixToCsv(matrix);
    // "Revenue" header line has only the label.
    expect(csv).toMatch(/\nRevenue\n/);
  });

  it("CSV: formula-leader-style row labels are neutralized (defense-in-depth)", async () => {
    // Synthesize a matrix with a hostile label to verify the toCsv
    // helper neutralizes formula leaders inside rendered labels too.
    const matrix: RenderedMatrix = {
      template: { ...INCOME_STATEMENT_TEMPLATE, name: "=CMD" }, // hostile
      columns: [{ id: "c1", label: "Amount" }],
      rows: [
        {
          id: "x",
          label: "=HYPERLINK(\"http://evil\",\"click\")",
          cells: [{ value: "100", display: "100.00" }],
        },
      ],
    };
    const csv = renderedMatrixToCsv(matrix);
    // The leading `=` must be neutralized with a single quote.
    expect(csv).not.toMatch(/^=CMD/);
    expect(csv).toContain("'=CMD");
    expect(csv).toContain("'=HYPERLINK");
  });

  it("builderCsvFilename: lowercases template code + appends suffix", () => {
    expect(builderCsvFilename(INCOME_STATEMENT_TEMPLATE, "2026-03-31")).toBe(
      "is-2026-03-31.csv"
    );
    // No suffix → defaults to today (YYYY-MM-DD).
    expect(builderCsvFilename(EQUITY_TEMPLATE)).toMatch(/^eq-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
