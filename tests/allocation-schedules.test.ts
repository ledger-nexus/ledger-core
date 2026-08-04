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
});
