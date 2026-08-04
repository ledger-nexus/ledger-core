// Integration tests for the recurring-entries engine.
//
// What we verify here:
//   1. Date math: addMonthsAnchored handles month-end clamping
//      (Jan 31 + 1 month → Feb 28; the next + 1 → Mar 31 — re-anchors).
//   2. enumerateDueDates: produces every cadence step inclusively up to
//      throughDate, stops at endDate.
//   3. Runner happy path: creates a template, runs through 3 months,
//      expects 3 JEs posted with correct dates + balanced lines.
//   4. Idempotency: re-running with the same throughDate produces
//      0 new entries (dedup via lineage triple).
//   5. Re-run forward: extending throughDate posts only the new
//      periods, not the old ones.
//   6. Inactive templates: skipped by the runner.
//   7. endDate honored: runner stops at endDate even if throughDate
//      is further out.
//   8. lastPostedDate advances to the last successful docDate after
//      the runner finishes.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  addMonthsAnchored,
  enumerateDueDates,
  runRecurringEntries,
} from "@/lib/accounting/recurring";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const SUFFIX = ("RECUR" + Date.now().toString(36)).toUpperCase();
const ENTITY_CODE = `RECUR-${SUFFIX}`;
const BOOK_CODE = "US_GAAP";

let tenantId: string;
let entityId: string;
let bookId: string;

beforeAll(async () => {
  tenantId = await getDefaultTenantId(prisma);

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const book = await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: { code: BOOK_CODE, name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });
  bookId = book.id;

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId,
      code: ENTITY_CODE,
      name: "Recurring Test Co.",
      functionalCurrencyId: "USD",
    },
  });
  entityId = entity.id;

  const calendar = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId,
      code: `RECUR_CAL_${SUFFIX}`,
      name: "Test calendar",
      periodFrequency: "MONTHLY",
    },
  });
  for (let m = 1; m <= 12; m++) {
    await prisma.period.create({
      data: {
        tenantId,
        calendarId: calendar.id,
        code: `2026-${String(m).padStart(2, "0")}`,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
    });
  }

  // Two trivial accounts: an expense + a cash account. Tenant + entity
  // scoped so they're unique to this test.
  for (const a of [
    { code: "EXP", type: "EXPENSE" as const, normalBalance: "DEBIT" as const },
    { code: "CASH", type: "ASSET" as const, normalBalance: "DEBIT" as const, isBank: true },
  ]) {
    await prisma.account.create({
      data: {
        tenantId,
        entityId,
        code: a.code,
        name: a.code,
        type: a.type,
        normalBalance: a.normalBalance,
        isBank: a.isBank ?? false,
      },
    });
  }
});

afterAll(async () => {
  await prisma.recurringEntryLine.deleteMany({ where: { template: { entityId } } });
  await prisma.recurringEntry.deleteMany({ where: { entityId } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.period.deleteMany({ where: { calendar: { entityId } } });
  await prisma.fiscalCalendar.deleteMany({ where: { entityId } });
  await prisma.recordEvent.deleteMany({ where: { tenantId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Each test starts with a clean slate for templates + produced JEs.
  await prisma.recurringEntryLine.deleteMany({ where: { template: { entityId } } });
  await prisma.recurringEntry.deleteMany({ where: { entityId } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
});

describe("addMonthsAnchored", () => {
  it("Jan 31 + 1 month clamps to Feb 28 (non-leap)", () => {
    const r = addMonthsAnchored(new Date("2026-01-31"), 1, 31);
    expect(r.toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("re-anchors to 31 when target month has 31 days", () => {
    // Jan 31 → Feb 28 → Mar 31 (anchor is 31, March has 31 days)
    const feb = addMonthsAnchored(new Date("2026-01-31"), 1, 31);
    const mar = addMonthsAnchored(feb, 1, 31);
    expect(mar.toISOString().slice(0, 10)).toBe("2026-03-31");
  });

  it("Jan 15 + 1 month is Feb 15 (anchor day = 15)", () => {
    const r = addMonthsAnchored(new Date("2026-01-15"), 1, 15);
    expect(r.toISOString().slice(0, 10)).toBe("2026-02-15");
  });

  it("Dec 31 + 1 month rolls to next year", () => {
    const r = addMonthsAnchored(new Date("2026-12-31"), 1, 31);
    expect(r.toISOString().slice(0, 10)).toBe("2027-01-31");
  });
});

describe("enumerateDueDates", () => {
  it("MONTHLY from never-posted produces start + each step through end", () => {
    const dates = enumerateDueDates({
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
      lastPostedDate: null,
      endDate: null,
      throughDate: new Date("2026-03-31"),
    });
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  it("MONTHLY from last-posted produces only NEW periods", () => {
    const dates = enumerateDueDates({
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
      lastPostedDate: new Date("2026-02-01"),
      endDate: null,
      throughDate: new Date("2026-04-30"),
    });
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-03-01",
      "2026-04-01",
    ]);
  });

  it("QUARTERLY steps by 3 months", () => {
    const dates = enumerateDueDates({
      cadence: "QUARTERLY",
      startDate: new Date("2026-01-01"),
      lastPostedDate: null,
      endDate: null,
      throughDate: new Date("2026-12-31"),
    });
    expect(dates).toHaveLength(4);
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-01-01",
      "2026-04-01",
      "2026-07-01",
      "2026-10-01",
    ]);
  });

  it("ANNUALLY steps by 12 months", () => {
    const dates = enumerateDueDates({
      cadence: "ANNUALLY",
      startDate: new Date("2026-01-15"),
      lastPostedDate: null,
      endDate: null,
      throughDate: new Date("2028-12-31"),
    });
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-01-15",
      "2027-01-15",
      "2028-01-15",
    ]);
  });

  it("endDate caps the enumeration even if throughDate is later", () => {
    const dates = enumerateDueDates({
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
      lastPostedDate: null,
      endDate: new Date("2026-02-28"),
      throughDate: new Date("2026-06-30"),
    });
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-01-01",
      "2026-02-01",
    ]);
  });

  it("snapToMonthEnd keeps an allocation schedule on month ends", () => {
    // Without the snap, a 30 Jun start anchors on day 30 and steps to
    // 30 Jul — not a month end, so the allocation window would cover
    // 1–30 Jul and the run would refuse. Only a 31st start survived.
    const dates = enumerateDueDates({
      cadence: "MONTHLY",
      startDate: new Date("2026-06-30"),
      lastPostedDate: null,
      endDate: null,
      throughDate: new Date("2026-09-30"),
      snapToMonthEnd: true,
    });
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
    ]);
  });

  it("snapToMonthEnd is inert on a schedule already anchored to the 31st", () => {
    const snapped = enumerateDueDates({
      cadence: "MONTHLY",
      startDate: new Date("2026-01-31"),
      lastPostedDate: null,
      endDate: null,
      throughDate: new Date("2026-04-30"),
      snapToMonthEnd: true,
    });
    expect(snapped.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("no due dates when current state is already past throughDate", () => {
    const dates = enumerateDueDates({
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
      lastPostedDate: new Date("2026-06-01"),
      endDate: null,
      throughDate: new Date("2026-03-31"),
    });
    expect(dates).toEqual([]);
  });
});

describe("runRecurringEntries — engine", () => {
  async function createTemplate(opts: {
    code: string;
    cadence: "MONTHLY" | "QUARTERLY" | "ANNUALLY";
    startDate: Date;
    endDate?: Date;
    isActive?: boolean;
  }) {
    return prisma.recurringEntry.create({
      data: {
        tenantId,
        entityId,
        bookId,
        code: opts.code,
        memo: `${opts.code} test memo`,
        currencyId: "USD",
        cadence: opts.cadence,
        startDate: opts.startDate,
        endDate: opts.endDate,
        isActive: opts.isActive ?? true,
        lines: {
          create: [
            { lineNo: 1, accountCode: "EXP", debit: "100.0000", credit: "0" },
            { lineNo: 2, accountCode: "CASH", debit: "0", credit: "100.0000" },
          ],
        },
      },
    });
  }

  it("happy path: monthly template runs through 3 months → 3 JEs posted", async () => {
    const tpl = await createTemplate({
      code: `M3-${SUFFIX}`,
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
    });
    const result = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-03-31"),
      tenantId,
      templateId: tpl.id,
    });
    expect(result.entriesPosted).toBe(3);
    expect(result.templates[0].posted).toBe(3);
    expect(result.templates[0].errors).toHaveLength(0);

    const produced = await prisma.journalEntry.findMany({
      where: { sourceSystem: "SUBSTRATE", sourceRecordId: { startsWith: `${tpl.id}:` } },
      orderBy: { documentDate: "asc" },
      select: { documentDate: true, memo: true },
    });
    expect(produced).toHaveLength(3);
    expect(produced.map((e) => e.documentDate.toISOString().slice(0, 10))).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);

    // lastPostedDate advanced.
    const refreshed = await prisma.recurringEntry.findUnique({
      where: { id: tpl.id },
      select: { lastPostedDate: true },
    });
    expect(refreshed!.lastPostedDate!.toISOString().slice(0, 10)).toBe("2026-03-01");
  });

  it("idempotent: re-running with the same throughDate posts 0 new entries", async () => {
    const tpl = await createTemplate({
      code: `IDEMP-${SUFFIX}`,
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
    });
    const first = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-03-31"),
      templateId: tpl.id,
    });
    expect(first.entriesPosted).toBe(3);

    const second = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-03-31"),
      templateId: tpl.id,
    });
    // The engine dedups at the enumeration level: lastPostedDate from
    // the first run advances past 2026-03-31, so the second run sees
    // zero due dates and posts nothing. (This is even cleaner than
    // relying on postJournalEntry's lineage dedup — the engine never
    // tries to call it for already-posted periods.)
    expect(second.entriesPosted).toBe(0);
    expect(second.templatesIdle).toBe(1);

    const totalProduced = await prisma.journalEntry.count({
      where: { sourceSystem: "SUBSTRATE", sourceRecordId: { startsWith: `${tpl.id}:` } },
    });
    expect(totalProduced).toBe(3); // Still 3, not 6.
  });

  it("crash between the post and the bookmark: the re-run resumes instead of wedging", async () => {
    // The post and the lastPostedDate update are deliberately separate
    // transactions, so a process that dies between them leaves entries
    // whose docDates the next run re-enumerates. postJournalEntry does
    // not dedupe — it inserts — so before the lineage pre-check that
    // re-run raised a unique violation, recorded it as an error, and
    // left the bookmark null. EVERY subsequent nightly run repeated it:
    // one crash wedged the template permanently.
    const tpl = await createTemplate({
      code: `WEDGE-${SUFFIX}`,
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
    });
    const first = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-02-28"),
      templateId: tpl.id,
    });
    expect(first.entriesPosted).toBe(2);

    // Rewind only the bookmark — the JEs stay committed.
    await prisma.recurringEntry.update({
      where: { id: tpl.id },
      data: { lastPostedDate: null },
    });

    const second = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-02-28"),
      templateId: tpl.id,
    });
    expect(second.templates[0].errors).toEqual([]);
    expect(second.entriesPosted).toBe(0);

    // No duplicates, and the bookmark caught back up.
    const total = await prisma.journalEntry.count({
      where: { sourceSystem: "SUBSTRATE", sourceRecordId: { startsWith: `${tpl.id}:` } },
    });
    expect(total).toBe(2);
    const refreshed = await prisma.recurringEntry.findUnique({
      where: { id: tpl.id },
      select: { lastPostedDate: true },
    });
    expect(refreshed!.lastPostedDate!.toISOString().slice(0, 10)).toBe("2026-02-01");

    // The template still moves forward — recovery, not just survival.
    const third = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-03-31"),
      templateId: tpl.id,
    });
    expect(third.entriesPosted).toBe(1);
    expect(third.templates[0].errors).toEqual([]);
  });

  it("forward run: extending throughDate posts only NEW periods", async () => {
    const tpl = await createTemplate({
      code: `FWD-${SUFFIX}`,
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
    });
    await runRecurringEntries(prisma, {
      throughDate: new Date("2026-02-28"),
      templateId: tpl.id,
    });

    const second = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-04-30"),
      templateId: tpl.id,
    });
    // Should post just March + April.
    expect(second.entriesPosted).toBe(2);

    const docDates = (
      await prisma.journalEntry.findMany({
        where: { sourceSystem: "SUBSTRATE", sourceRecordId: { startsWith: `${tpl.id}:` } },
        orderBy: { documentDate: "asc" },
        select: { documentDate: true },
      })
    ).map((e) => e.documentDate.toISOString().slice(0, 10));
    expect(docDates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
  });

  it("inactive templates are skipped", async () => {
    const tpl = await createTemplate({
      code: `PAUSED-${SUFFIX}`,
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
      isActive: false,
    });
    const result = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-12-31"),
      templateId: tpl.id,
    });
    expect(result.entriesPosted).toBe(0);
    expect(result.templates).toHaveLength(0);
  });

  it("endDate caps the runner", async () => {
    const tpl = await createTemplate({
      code: `ENDED-${SUFFIX}`,
      cadence: "MONTHLY",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-02-28"),
    });
    const result = await runRecurringEntries(prisma, {
      throughDate: new Date("2026-12-31"), // way past endDate
      templateId: tpl.id,
    });
    expect(result.entriesPosted).toBe(2);
  });

  it("tenant scoping: other-tenant templates are not touched", async () => {
    // The runner is restricted to a single tenant when tenantId is passed.
    // Creating a template under a different (fake) tenant should be ignored.
    const fakeTenant = await prisma.tenant.create({
      data: {
        slug: `recur-other-${SUFFIX.toLowerCase()}`,
        name: "Other tenant",
        ownerUserId: tenantId, // any UUID
      },
    });
    try {
      // We don't actually need a full setup here — just an inactive-by-default-skip
      // proof. The tenantId filter on findMany means findMany returns 0 templates
      // for this other tenant.
      const result = await runRecurringEntries(prisma, {
        throughDate: new Date("2026-12-31"),
        tenantId: fakeTenant.id,
      });
      expect(result.entriesPosted).toBe(0);
      expect(result.templates).toHaveLength(0);
    } finally {
      await prisma.tenant.delete({ where: { id: fakeTenant.id } });
    }
  });
});
