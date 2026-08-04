// Allocation schedules — percent allocation of a source account's
// month-to-docDate activity, run through the recurring pipeline.
//
// The invariants that make ALLOCATION safe to keep AUTO:
//   - deterministic math with the last target taking the rounding
//     remainder (Σ targets === activity, to the penny);
//   - the posted entry clears the source (window activity nets to 0);
//   - idempotent per docDate via the recurring lineage dedup;
//   - zero activity completes the run without posting (a quiet month
//     never wedges the template);
//   - drifted percents refuse at run time, never partially allocate.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { runRecurringEntries } from "@/lib/accounting/recurring";
import {
  computeAllocationLines,
  assertMonthEndAnchor,
  isMonthEnd,
  AllocationTemplateError,
} from "@/lib/accounting/allocation";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);
const BOOK = "US_GAAP";
const E = `ALCX${SUFFIX}`.toUpperCase().slice(0, 14);

const A = {
  src: `AL61${SUFFIX}`.slice(0, 12),
  d1: `AL71${SUFFIX}`.slice(0, 12),
  d2: `AL72${SUFFIX}`.slice(0, 12),
  d3: `AL73${SUFFIX}`.slice(0, 12),
  cash: `AL10${SUFFIX}`.slice(0, 12),
  quiet: `AL69${SUFFIX}`.slice(0, 12),
};

let tenantId: string;

async function scrubStale() {
  const stale = await prisma.tenant.findMany({
    where: { slug: { startsWith: "alcx" } },
    select: { id: true },
  });
  const tIds = stale.map((t) => t.id);
  if (tIds.length > 0) {
    await prisma.recurringEntryLine.deleteMany({
      where: { template: { tenantId: { in: tIds } } },
    });
    await prisma.recurringEntry.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.journalLine.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.period.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
  }
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: "ALCX Fixture" } },
    select: { id: true },
  });
  if (staleUsers.length > 0) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.user.deleteMany({ where: { id: { in: staleUsers.map((u) => u.id) } } });
    });
  }
}

beforeAll(async () => {
  await scrubStale();
  const owner = await prisma.user.create({
    data: { email: `alcx-owner-${SUFFIX}@example.test`, displayName: "ALCX Fixture owner" },
    select: { id: true },
  });
  const tenant = await prisma.tenant.create({
    data: { slug: `alcx-${SUFFIX}`, name: "ALCX Co", ownerUserId: owner.id },
    select: { id: true },
  });
  tenantId = tenant.id;

  const ent = await prisma.legalEntity.create({
    data: { tenantId, code: E, name: E, functionalCurrencyId: "USD" },
    select: { id: true },
  });
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId: ent.id,
      code: `ALCX_CAL`.slice(0, 30),
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  await prisma.period.create({
    data: {
      tenantId,
      calendarId: cal.id,
      code: "2026-05",
      ordinal: 5,
      startsOn: new Date("2026-05-01"),
      endsOn: new Date("2026-05-31"),
    },
  });

  for (const [code, name, type] of [
    [A.src, "Overhead pool", "EXPENSE"],
    [A.d1, "Dept 1 expense", "EXPENSE"],
    [A.d2, "Dept 2 expense", "EXPENSE"],
    [A.d3, "Dept 3 expense", "EXPENSE"],
    [A.cash, "Cash", "ASSET"],
    [A.quiet, "Quiet pool", "EXPENSE"],
  ] as const) {
    await prisma.account.create({
      data: {
        tenantId,
        entityId: ent.id,
        code,
        name,
        type,
        normalBalance: type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT",
      },
    });
  }

  // May overhead: 1000.33 net debit — chosen so 60/30/10 forces the
  // remainder rule (600.20 + 300.10 + 100.03).
  await postJournalEntry(prisma, {
    tenantId,
    entityCode: E,
    bookCode: BOOK,
    documentDate: new Date("2026-05-12"),
    memo: "May overhead",
    source: "MANUAL",
    lines: [
      { accountCode: A.src, debit: 1000.33 },
      { accountCode: A.cash, credit: 1000.33 },
    ],
  });


  const book = await prisma.book.findUniqueOrThrow({
    where: { code: BOOK },
    select: { id: true },
  });
  await prisma.recurringEntry.create({
    data: {
      tenantId,
      entityId: ent.id,
      bookId: book.id,
      code: `ALCX_OVH_${SUFFIX}`.toUpperCase().slice(0, 40),
      memo: "Monthly overhead allocation",
      currencyId: "USD",
      cadence: "MONTHLY",
      startDate: new Date("2026-05-31"),
      kind: "ALLOCATION",
      allocationSourceAccountCode: A.src,
      lines: {
        create: [
          { lineNo: 1, accountCode: A.d1, allocationPercent: "60.0000" },
          { lineNo: 2, accountCode: A.d2, allocationPercent: "30.0000" },
          { lineNo: 3, accountCode: A.d3, allocationPercent: "10.0000" },
        ],
      },
    },
  });
  await prisma.recurringEntry.create({
    data: {
      tenantId,
      entityId: ent.id,
      bookId: book.id,
      code: `ALCX_QUIET_${SUFFIX}`.toUpperCase().slice(0, 40),
      memo: "Quiet pool allocation",
      currencyId: "USD",
      cadence: "MONTHLY",
      startDate: new Date("2026-05-31"),
      kind: "ALLOCATION",
      allocationSourceAccountCode: A.quiet,
      lines: {
        create: [{ lineNo: 1, accountCode: A.d1, allocationPercent: "100.0000" }],
      },
    },
  });
});

afterAll(async () => {
  await scrubStale();
  await prisma.$disconnect();
});

describe("computeAllocationLines (pure)", () => {
  const targets = (p: [string, string][]) =>
    p.map(([accountCode, percent]) => ({ accountCode, percent: new Decimal(percent) }));

  it("penny invariant: last target takes the remainder; entry balances", () => {
    const lines = computeAllocationLines({
      sourceAccountCode: "SRC",
      sourceActivity: new Decimal("1000.33"),
      targets: targets([
        ["D1", "60"],
        ["D2", "30"],
        ["D3", "10"],
      ]),
    });
    expect(lines.map((l) => l.debit.toString())).toEqual(["600.2", "300.1", "100.03", "0"]);
    expect(lines[3].credit.toString()).toBe("1000.33");
    const net = lines.reduce((a, l) => a.plus(l.debit).minus(l.credit), new Decimal(0));
    expect(net.isZero()).toBe(true);
  });

  it("credit-side activity flips both sides; zero activity → []; bad percents refuse", () => {
    const flipped = computeAllocationLines({
      sourceAccountCode: "SRC",
      sourceActivity: new Decimal("-200"),
      targets: targets([["D1", "100"]]),
    });
    expect(flipped[0].credit.toString()).toBe("200");
    expect(flipped[1].debit.toString()).toBe("200");

    expect(
      computeAllocationLines({
        sourceAccountCode: "SRC",
        sourceActivity: new Decimal(0),
        targets: targets([["D1", "100"]]),
      })
    ).toEqual([]);

    expect(() =>
      computeAllocationLines({
        sourceAccountCode: "SRC",
        sourceActivity: new Decimal(100),
        targets: targets([
          ["D1", "50"],
          ["D2", "40"],
        ]),
      })
    ).toThrow(AllocationTemplateError);
  });

  it("refuses a pool too small to split instead of emitting a negative line", () => {
    // 0.05 across 8 targets: each 12.5% share is 0.00625, which rounds
    // UP to 0.01, so the first seven consume 0.07 and the remainder
    // would be −0.02. postJournalEntry would reject that as a negative
    // amount — an error about the wrong thing. Refuse in allocation's
    // own vocabulary instead.
    expect(() =>
      computeAllocationLines({
        sourceAccountCode: "SRC",
        sourceActivity: new Decimal("0.05"),
        targets: targets(
          Array.from({ length: 8 }, (_, i) => [`D${i + 1}`, "12.5"] as [string, string])
        ),
      })
    ).toThrow(/too small to split/);
  });
});

describe("month-end anchoring", () => {
  it("accepts month-ends (including a short February) and refuses mid-month", () => {
    expect(isMonthEnd(new Date("2026-05-31"))).toBe(true);
    expect(isMonthEnd(new Date("2026-02-28"))).toBe(true);
    expect(isMonthEnd(new Date("2028-02-29"))).toBe(true); // leap
    expect(isMonthEnd(new Date("2026-02-27"))).toBe(false);
    expect(isMonthEnd(new Date("2026-05-15"))).toBe(false);
  });

  it("a mid-month run refuses — the window would drop the rest of the month", () => {
    // The window is [first of month, docDate]. Anchored on the 15th,
    // May 16–31 is never allocated by anything, silently. Refusing is
    // the whole point: a wrong number is worse than a stopped schedule.
    expect(() => assertMonthEndAnchor(new Date("2026-05-15"))).toThrow(
      AllocationTemplateError
    );
    expect(() => assertMonthEndAnchor(new Date("2026-05-31"))).not.toThrow();
  });
});

describe("allocation through the recurring runner (DB)", () => {
  it("posts the allocation, clears the source, idempotent on re-run; quiet template advances without posting", async () => {
    const first = await runRecurringEntries(prisma, {
      tenantId,
      throughDate: new Date("2026-05-31"),
      triggeredBy: "test",
    });
    // Overhead template posted; quiet template completed with nothing
    // to allocate (no entry, no error).
    expect(first.entriesPosted).toBe(1);

    const entry = await prisma.journalEntry.findFirst({
      where: { tenantId, sourceRecordType: "RecurringEntry", memo: "Monthly overhead allocation" },
      include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } } },
    });
    expect(entry).not.toBeNull();
    const byCode = new Map(entry!.lines.map((l) => [l.account.code, l]));
    expect(new Decimal(byCode.get(A.d1)!.debit.toString()).toNumber()).toBeCloseTo(600.2, 4);
    expect(new Decimal(byCode.get(A.d2)!.debit.toString()).toNumber()).toBeCloseTo(300.1, 4);
    expect(new Decimal(byCode.get(A.d3)!.debit.toString()).toNumber()).toBeCloseTo(100.03, 4);
    expect(new Decimal(byCode.get(A.src)!.credit.toString()).toNumber()).toBeCloseTo(1000.33, 4);

    // Source window activity nets to zero after the allocation.
    const src = await prisma.account.findFirstOrThrow({
      where: { tenantId, code: A.src },
      select: { id: true },
    });
    const sums = await prisma.journalLine.aggregate({
      where: { tenantId, accountId: src.id },
      _sum: { debit: true, credit: true },
    });
    expect(
      new Decimal(sums._sum.debit!.toString()).minus(sums._sum.credit!.toString()).isZero()
    ).toBe(true);

    // Quiet template: bookmark advanced despite posting nothing.
    const quiet = await prisma.recurringEntry.findFirstOrThrow({
      where: { tenantId, allocationSourceAccountCode: A.quiet },
      select: { lastPostedDate: true },
    });
    expect(quiet.lastPostedDate).not.toBeNull();

    // Idempotency: a second run posts nothing new.
    const second = await runRecurringEntries(prisma, {
      tenantId,
      throughDate: new Date("2026-05-31"),
      triggeredBy: "test",
    });
    expect(second.entriesPosted).toBe(0);
    const count = await prisma.journalEntry.count({
      where: { tenantId, sourceRecordType: "RecurringEntry" },
    });
    expect(count).toBe(1);
  });

  it("a 30-June anchor runs consecutive months — the step lands on 31 July, not 30 July", async () => {
    // The cadence anchors on the start date's DAY, so a 30 Jun template
    // would step to 30 Jul: not a month end, so the window would cover
    // 1–30 Jul and the run would refuse. Every month-end anchor except
    // the 31st was affected. Both months must post.
    const book = await prisma.book.findUniqueOrThrow({
      where: { code: BOOK },
      select: { id: true },
    });
    const ent = await prisma.legalEntity.findFirstOrThrow({
      where: { tenantId, code: E },
      select: { id: true },
    });
    await prisma.period.createMany({
      data: [
        {
          tenantId,
          calendarId: (
            await prisma.fiscalCalendar.findFirstOrThrow({
              where: { tenantId, entityId: ent.id },
              select: { id: true },
            })
          ).id,
          code: "2026-06",
          ordinal: 6,
          startsOn: new Date("2026-06-01"),
          endsOn: new Date("2026-06-30"),
        },
      ],
      skipDuplicates: true,
    });
    // June activity on a fresh pool so the second month has something
    // to allocate.
    await postJournalEntry(prisma, {
      tenantId,
      entityCode: E,
      bookCode: BOOK,
      documentDate: new Date("2026-06-10"),
      memo: "June overhead",
      source: "MANUAL",
      lines: [
        { accountCode: A.d3, debit: 500 },
        { accountCode: A.cash, credit: 500 },
      ],
    });
    const tpl = await prisma.recurringEntry.create({
      data: {
        tenantId,
        entityId: ent.id,
        bookId: book.id,
        code: `ALCX_JUN30_${SUFFIX}`.toUpperCase().slice(0, 40),
        memo: "June-30 anchored allocation",
        currencyId: "USD",
        cadence: "MONTHLY",
        startDate: new Date("2026-05-31"),
        kind: "ALLOCATION",
        allocationSourceAccountCode: A.d3,
        lines: { create: [{ lineNo: 1, accountCode: A.d1, allocationPercent: "100.0000" }] },
      },
      select: { id: true },
    });

    const run = await runRecurringEntries(prisma, {
      tenantId,
      templateId: tpl.id,
      throughDate: new Date("2026-06-30"),
      triggeredBy: "test",
    });
    expect(run.templates[0].errors).toEqual([]);

    const after = await prisma.recurringEntry.findUniqueOrThrow({
      where: { id: tpl.id },
      select: { lastPostedDate: true },
    });
    // May 31 (nothing to allocate) then June 30 — NOT June 31-as-30.
    expect(after.lastPostedDate!.toISOString().slice(0, 10)).toBe("2026-06-30");
    const june = await prisma.journalEntry.findFirst({
      where: { tenantId, sourceRecordId: `${tpl.id}:2026-06-30` },
      include: { lines: { include: { account: true } } },
    });
    expect(june).not.toBeNull();
    expect(
      new Decimal(
        june!.lines.find((l) => l.account.code === A.d1)!.debit.toString()
      ).toNumber()
    ).toBeCloseTo(500, 2);
  });

  it("a mid-month-anchored template still allocates the WHOLE month", async () => {
    // The create action refuses this shape, so reaching it takes a
    // seed, a script, or a restored row. The hazard is the window:
    // anchored on the 15th it would run [1st, 15th] and nothing would
    // ever pick up the 16th–EOM. Snapping the run to month end means
    // the late-month activity below is allocated rather than orphaned.
    const book = await prisma.book.findUniqueOrThrow({
      where: { code: BOOK },
      select: { id: true },
    });
    const ent = await prisma.legalEntity.findFirstOrThrow({
      where: { tenantId, code: E },
      select: { id: true },
    });
    const lateCode = `AL80${SUFFIX}`.slice(0, 12);
    await prisma.account.create({
      data: {
        tenantId,
        entityId: ent.id,
        code: lateCode,
        name: "Late-month pool",
        type: "EXPENSE",
        normalBalance: "DEBIT",
      },
    });
    // Dated the 20th — AFTER the template's mid-month anchor.
    await postJournalEntry(prisma, {
      tenantId,
      entityCode: E,
      bookCode: BOOK,
      documentDate: new Date("2026-05-20"),
      memo: "Late-month overhead",
      source: "MANUAL",
      lines: [
        { accountCode: lateCode, debit: 640 },
        { accountCode: A.cash, credit: 640 },
      ],
    });

    const mid = await prisma.recurringEntry.create({
      data: {
        tenantId,
        entityId: ent.id,
        bookId: book.id,
        code: `ALCX_MID_${SUFFIX}`.toUpperCase().slice(0, 40),
        memo: "Mid-month anchored allocation",
        currencyId: "USD",
        cadence: "MONTHLY",
        startDate: new Date("2026-05-15"),
        kind: "ALLOCATION",
        allocationSourceAccountCode: lateCode,
        lines: { create: [{ lineNo: 1, accountCode: A.d1, allocationPercent: "100.0000" }] },
      },
      select: { id: true },
    });

    const run = await runRecurringEntries(prisma, {
      tenantId,
      templateId: mid.id,
      throughDate: new Date("2026-05-31"),
      triggeredBy: "test",
    });
    expect(run.templates[0].errors).toEqual([]);
    expect(run.entriesPosted).toBe(1);

    // Posted on the 31st, not the 15th, and it carries the full 640 —
    // the amount a [1st, 15th] window would have missed entirely.
    const posted = await prisma.journalEntry.findFirst({
      where: { tenantId, sourceRecordId: `${mid.id}:2026-05-31` },
      include: { lines: { include: { account: true } } },
    });
    expect(posted).not.toBeNull();
    expect(
      new Decimal(
        posted!.lines.find((l) => l.account.code === lateCode)!.credit.toString()
      ).toNumber()
    ).toBeCloseTo(640, 2);
  });
});
