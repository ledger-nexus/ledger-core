// Report Builder PR 9 — ReportTemplate persistence tests.
//
// Validates the repository helpers + the resolution path:
//   - loadTemplate falls back to SYSTEM_TEMPLATES when the DB has no row
//   - loadTemplate prefers the DB row when one exists for (tenant, code)
//   - listTemplates returns only the requesting tenant's rows
//   - Composite unique (tenantId, code) prevents collisions
//   - A user-cloned row (isSystem: false) renders identically to the
//     system source via `renderTemplate`
//
// The Server Action surface (clone / rename / delete) isn't exercised
// here — Server Actions require a request context. Their authorization
// + audit paths are covered by integration tests at the route layer
// (PR 10 + adversarial pass).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { postJournalEntry } from "@/lib/accounting/post-journal";

import { renderTemplate } from "@/lib/accounting/reports/builder/render";
import {
  loadTemplate,
  listTemplates,
} from "@/lib/accounting/reports/builder/repository";
import { INCOME_STATEMENT_TEMPLATE } from "@/lib/accounting/reports/builder/templates";

const prisma = new PrismaClient();

const PREFIX = "RPTP"; // ReportBuilder Persistence
// Uppercase the stamp to match the Server Action's normalization
// (clone Server Action `.toUpperCase()`s code at write-time) — the
// composite-unique key is case-sensitive so we must match.
const STAMP = Date.now().toString(36).toUpperCase();
const ENT_CODE = `${PREFIX}_E1_${STAMP}`;
const BOOK_CODE = "US_GAAP";

let tenantId: string;
let otherTenantId: string;
let entityId: string;
let createdTemplateIds: string[] = [];

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
      code: `STANDARD_2026_${STAMP}`,
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

  // Post one JE so renderTemplate has data to evaluate.
  await postJournalEntry(prisma, {
    entityCode: ENT_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-02-15"),
    memo: "Revenue",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 2000, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 2000 },
    ],
  });

  // Spin up a second tenant so listTemplates isolation can be proven.
  const admin = await prisma.user.upsert({
    where: { email: `pr9-persistence-${STAMP}@northwind.test` },
    create: {
      email: `pr9-persistence-${STAMP}@northwind.test`,
      displayName: "PR9 persistence admin",
      isActive: true,
    },
    update: { isActive: true },
  });
  const other = await prisma.tenant.create({
    data: {
      name: `${PREFIX}_OTHER_${STAMP}`,
      slug: `${PREFIX.toLowerCase()}-other-${STAMP}`,
      ownerUserId: admin.id,
    },
  });
  otherTenantId = other.id;

  // Persist a custom template on the OTHER tenant so listTemplates on
  // OUR tenant should NOT see it.
  const otherTpl = await prisma.reportTemplate.create({
    data: {
      tenantId: otherTenantId,
      code: "OTHER_TENANT_TPL",
      name: "Other tenant's template",
      isSystem: false,
      version: 1,
      definition: INCOME_STATEMENT_TEMPLATE.definition as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  createdTemplateIds.push(otherTpl.id);
}

async function cleanup(): Promise<void> {
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
  // Wipe any templates we created on the default tenant during the run.
  await prisma.reportTemplate.deleteMany({
    where: {
      OR: [
        { id: { in: createdTemplateIds } },
        { code: { startsWith: `${PREFIX}_` } },
      ],
    },
  });
  if (otherTenantId) {
    await prisma.reportTemplate.deleteMany({ where: { tenantId: otherTenantId } });
    await prisma.tenant.deleteMany({ where: { id: otherTenantId } });
  }
}

describe("Report Builder PR 9 — persistence", () => {
  beforeAll(async () => {
    await ensureFixture();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("loadTemplate falls back to SYSTEM_TEMPLATES when DB has no row", async () => {
    const tpl = await loadTemplate(prisma, "IS", tenantId);
    expect(tpl).not.toBeNull();
    expect(tpl!.code).toBe("IS");
    expect(tpl!.isSystem).toBe(true);
    expect(tpl!.name).toBe("Income Statement");
  });

  it("loadTemplate returns null for an unknown code (no DB, not in registry)", async () => {
    const tpl = await loadTemplate(prisma, "NONEXISTENT_CODE_XYZ", tenantId);
    expect(tpl).toBeNull();
  });

  it("loadTemplate prefers DB row over SYSTEM_TEMPLATES when both exist", async () => {
    const code = `${PREFIX}_OVERRIDE_${STAMP}`;
    const customDefinition: Prisma.InputJsonValue = {
      ...(INCOME_STATEMENT_TEMPLATE.definition as unknown as Record<string, unknown>),
    } as Prisma.InputJsonValue;

    const created = await prisma.reportTemplate.create({
      data: {
        tenantId,
        code,
        name: "Custom IS Override",
        isSystem: false,
        version: 7,
        definition: customDefinition,
      },
      select: { id: true },
    });
    createdTemplateIds.push(created.id);

    const tpl = await loadTemplate(prisma, code, tenantId);
    expect(tpl).not.toBeNull();
    expect(tpl!.name).toBe("Custom IS Override");
    expect(tpl!.version).toBe(7);
    expect(tpl!.isSystem).toBe(false);
  });

  it("loadTemplate is tenant-scoped — other tenant's row invisible to us", async () => {
    const tpl = await loadTemplate(prisma, "OTHER_TENANT_TPL", tenantId);
    expect(tpl).toBeNull();
  });

  it("listTemplates returns only the requesting tenant's rows", async () => {
    const rows = await listTemplates(prisma, tenantId);
    for (const r of rows) {
      // None of the OTHER_TENANT_TPL row should leak in.
      expect(r.code).not.toBe("OTHER_TENANT_TPL");
    }
    // The override we created in the previous test should appear.
    const found = rows.find((r) => r.code === `${PREFIX}_OVERRIDE_${STAMP}`);
    expect(found).toBeDefined();
  });

  it("composite unique (tenantId, code) prevents collision in same tenant", async () => {
    const code = `${PREFIX}_DUP_${STAMP}`;
    const first = await prisma.reportTemplate.create({
      data: {
        tenantId,
        code,
        name: "First",
        isSystem: false,
        version: 1,
        definition: {} as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    createdTemplateIds.push(first.id);

    await expect(
      prisma.reportTemplate.create({
        data: {
          tenantId,
          code,
          name: "Second",
          isSystem: false,
          version: 1,
          definition: {} as unknown as Prisma.InputJsonValue,
        },
      })
    ).rejects.toThrow();
  });

  it("a user-cloned template renders identically to the system source", async () => {
    // Clone IS into the tenant's DB verbatim.
    const cloneCode = `${PREFIX}_IS_CLONE_${STAMP}`;
    const cloned = await prisma.reportTemplate.create({
      data: {
        tenantId,
        code: cloneCode,
        name: "Cloned IS",
        isSystem: false,
        version: 1,
        definition: INCOME_STATEMENT_TEMPLATE.definition as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    createdTemplateIds.push(cloned.id);

    const systemRendered = await renderTemplate(prisma, INCOME_STATEMENT_TEMPLATE, {
      asOfDate: new Date("2026-12-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });
    const clonedTpl = await loadTemplate(prisma, cloneCode, tenantId);
    expect(clonedTpl).not.toBeNull();
    const cloneRendered = await renderTemplate(prisma, clonedTpl!, {
      asOfDate: new Date("2026-12-31"),
      entityCode: ENT_CODE,
      bookCode: BOOK_CODE,
      tenantId,
    });

    // ni row value should match exactly. Same data, same row evaluation.
    const sysNi = systemRendered.rows.find((r) => r.id === "ni");
    const cloneNi = cloneRendered.rows.find((r) => r.id === "ni");
    expect(sysNi).toBeDefined();
    expect(cloneNi).toBeDefined();
    expect(cloneNi!.cells[0].value).toBe(sysNi!.cells[0].value);
    // From the fixture: $2,000 revenue, no expenses → Net Income $2,000.
    expect(cloneNi!.cells[0].value).toBe("2000.00");
  });
});
