// Report Builder arc — end-to-end operator journey smoke test.
//
// THE POINT: the 11 PRs of the arc layer cleanly only if the FULL
// operator workflow works:
//
//   1. Clone a system template into the tenant's DB.
//   2. Edit the clone's definition (change a row label).
//   3. Render the resulting matrix.
//   4. Verify the CSV reflects the edit.
//   5. Verify the PDF buffer generates.
//   6. Delete the clone.
//
// Per-layer tests cover each step. This test makes sure the LAYERS
// COMPOSE — that loadTemplate returns the edited version, that the
// row engine accepts the persisted JSON, that the CSV serializer
// flows the new label through. Future refactors that break the
// hand-offs will fail HERE first.
//
// Server Actions are not used directly (they need a request context).
// We invoke the same Prisma calls the actions make so the surface
// being exercised is "the persisted-template tier of the arc."

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { renderToBuffer } from "@react-pdf/renderer";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

import { INCOME_STATEMENT_TEMPLATE } from "@/lib/accounting/reports/builder/templates";
import { loadTemplate } from "@/lib/accounting/reports/builder/repository";
import { renderTemplate } from "@/lib/accounting/reports/builder/render";
import { renderedMatrixToCsv } from "@/lib/accounting/reports/builder/csv";
import { BuilderPdfDocument } from "@/lib/accounting/reports/builder/pdf";
import {
  ReportTemplateDefinitionSchema,
  validateDefinitionIntegrity,
} from "@/lib/accounting/reports/builder/schema";

const prisma = new PrismaClient();

const PREFIX = "RPTE2E";
const STAMP = Date.now().toString(36).toUpperCase();
const ENT_CODE = `${PREFIX}_ENT_${STAMP}`;
const BOOK_CODE = "US_GAAP";
const CLONE_CODE = `${PREFIX}_CLONE_${STAMP}`;
const NEW_NI_LABEL = "Net income after tax — customized";

let tenantId: string;
let entityId: string;
let cloneId: string;

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
      code: `CAL_${STAMP}`,
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

  // $5,000 revenue posted in February so the rendered matrix has data.
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-02-15"),
    memo: "End-to-end fixture revenue",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 5000, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 5000 },
    ],
  });
}

async function cleanup(): Promise<void> {
  if (cloneId) {
    await prisma.reportTemplate.deleteMany({ where: { id: cloneId } });
  }
  await prisma.reportTemplate.deleteMany({
    where: { code: { startsWith: `${PREFIX}_` } },
  });
  if (entityId) {
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
}

describe("Report Builder — end-to-end operator journey", () => {
  beforeAll(async () => {
    await ensureFixture();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // ──────────────────────────────────────────────────────────────────
  // Step 1: Clone IS into the tenant's DB. Mirrors PR 9's
  // cloneReportTemplate Server Action.
  it("step 1 — clone IS template into tenant DB", async () => {
    const created = await prisma.reportTemplate.create({
      data: {
        tenantId,
        code: CLONE_CODE,
        name: "Customized IS",
        isSystem: false,
        version: 1,
        definition: INCOME_STATEMENT_TEMPLATE.definition as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    cloneId = created.id;

    const resolved = await loadTemplate(prisma, CLONE_CODE, tenantId);
    expect(resolved).not.toBeNull();
    expect(resolved!.code).toBe(CLONE_CODE);
    expect(resolved!.isSystem).toBe(false);
    expect(resolved!.version).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────
  // Step 2: Edit the clone's definition through the PR 10 validation
  // pipeline. Change the "Net income" row's label.
  it("step 2 — edit clone definition through Zod + integrity pipeline", async () => {
    const current = await loadTemplate(prisma, CLONE_CODE, tenantId);
    expect(current).not.toBeNull();

    // Operator copies the JSON, edits a label, pastes back.
    const edited = JSON.parse(JSON.stringify(current!.definition)) as ReturnType<
      typeof ReportTemplateDefinitionSchema.parse
    >;
    const niRow = edited.rows.find((r) => r.id === "ni");
    expect(niRow).toBeDefined();
    if (niRow && "label" in niRow) {
      niRow.label = NEW_NI_LABEL;
    }

    // PR 10 validation pipeline.
    const parsed = ReportTemplateDefinitionSchema.parse(edited);
    expect(validateDefinitionIntegrity(parsed)).toEqual([]);

    // PR 11 concurrency-safe update.
    const updated = await prisma.reportTemplate.updateMany({
      where: { id: cloneId, version: 1 },
      data: {
        definition: parsed as unknown as Prisma.InputJsonValue,
        version: 2,
      },
    });
    expect(updated.count).toBe(1);

    const after = await loadTemplate(prisma, CLONE_CODE, tenantId);
    expect(after!.version).toBe(2);
    const niAfter = after!.definition.rows.find((r) => r.id === "ni");
    expect(niAfter && "label" in niAfter ? niAfter.label : null).toBe(NEW_NI_LABEL);
  });

  // ──────────────────────────────────────────────────────────────────
  // Step 3: Render the edited template via PR 3's renderTemplate.
  // Asserts the customized label flows all the way to RenderedMatrix.
  it("step 3 — rendered matrix reflects the customized label", async () => {
    const tpl = await loadTemplate(prisma, CLONE_CODE, tenantId);
    expect(tpl).not.toBeNull();

    const matrix = await renderTemplate(prisma, tpl!, {
      asOfDate: new Date("2026-12-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });

    const niRow = matrix.rows.find((r) => r.id === "ni");
    expect(niRow).toBeDefined();
    expect(niRow!.label).toBe(NEW_NI_LABEL);
    // Net income = $5,000 revenue − $0 expenses = $5,000.00.
    expect(niRow!.cells[0].value).toBe("5000.00");
  });

  // ──────────────────────────────────────────────────────────────────
  // Step 4: CSV export carries the customized label (PR 6 serializer).
  it("step 4 — CSV export carries the customized label", async () => {
    const tpl = await loadTemplate(prisma, CLONE_CODE, tenantId);
    const matrix = await renderTemplate(prisma, tpl!, {
      asOfDate: new Date("2026-12-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    const csv = renderedMatrixToCsv(matrix, {
      scopeLabel: `${ENT_CODE} / ${BOOK_CODE} · 2026-12-31`,
    });
    expect(csv).toContain(NEW_NI_LABEL);
    // Also verify the $5,000.00 NI value is in the CSV.
    expect(csv).toContain("5,000.00");
  });

  // ──────────────────────────────────────────────────────────────────
  // Step 5: PDF buffer generates without crashing (PR 8 component).
  it("step 5 — PDF buffer generates from the edited template", async () => {
    const tpl = await loadTemplate(prisma, CLONE_CODE, tenantId);
    const matrix = await renderTemplate(prisma, tpl!, {
      asOfDate: new Date("2026-12-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    const buffer = await renderToBuffer(
      BuilderPdfDocument({
        template: {
          code: tpl!.code,
          name: tpl!.name,
          version: tpl!.version,
        },
        scope: {
          entityCode: ENT_CODE,
          bookCode: BOOK_CODE,
          asOf: "2026-12-31",
        },
        columns: matrix.columns.map((c) => ({ id: c.id, label: c.label })),
        rows: matrix.rows.map((r) => ({
          id: r.id,
          label: r.label,
          cells: r.cells.map((c) => ({ display: c.display })),
          isHeader: Boolean(r.isHeader),
          isSpacer: Boolean(r.isSpacer),
          isFormula: Boolean(r.isFormula),
          isSubtotal: Boolean(r.isSubtotal),
        })),
        generatedAt: "2026-06-09 12:00:00 UTC",
      })
    );
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  // ──────────────────────────────────────────────────────────────────
  // Step 6: Delete the clone — mirrors PR 9's deleteReportTemplate.
  // Asserts the resolver no longer returns it.
  it("step 6 — delete + resolver returns null", async () => {
    await prisma.reportTemplate.delete({ where: { id: cloneId } });
    cloneId = ""; // prevent cleanup double-delete
    const gone = await loadTemplate(prisma, CLONE_CODE, tenantId);
    expect(gone).toBeNull();
  });
});
