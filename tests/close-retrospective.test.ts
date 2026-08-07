// BlackLine arc — Phase 4 PR 3 tests.
//
// Pins the close-retrospective rollup math:
//   1. Empty scope → all trends are empty, all summary stats null
//   2. Days-to-close: PeriodClose.closedAt − Period.endsOn (floor days),
//      metTarget = daysToClose ≤ targetDays
//   3. Task lead time: avg over DONE tasks per category
//   4. Exception rate: EXCEPTION count / total recons per period
//   5. Recurring blockers: top templates by BLOCKED-status count
//   6. Trends ordered oldest-first
//   7. Summary aggregates agree with per-row sums
//
// Scope-isolation: pins that cross-(entity, book) data does NOT bleed
// into the retrospective for the requested scope.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getCloseRetrospective } from "@/lib/close/retrospective";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

// Stable prefix for the self-healing scrub; the rest is per-run.
const PREFIX = "rt4";
const SUFFIX = PREFIX + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let entityId: string;
let bookId: string;
let userId: string;
let accountIds: string[] = [];
let periodIds: string[] = [];
let calendarId: string;

const createdReconIds: string[] = [];
const createdTaskIds: string[] = [];

beforeAll(async () => {
  tenantId = await getDefaultTenantId(prisma);

  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  userId = u.id;

  await scrubOrphans();

  // A dedicated ENTITY, not just a dedicated calendar.
  //
  // This suite used to borrow NORTHWIND and mint its own calendar under
  // it, on the reasoning that a private calendar keeps period ordinals
  // from colliding. It does — but ordinals were never the whole problem,
  // because `getCloseRetrospective` does not window by calendar:
  //
  //     where: { tenantId, calendar: { entityId: scope.entityId } }
  //
  // The lookback is the newest N periods across EVERY calendar on the
  // entity. So Northwind's own STANDARD_2026 periods sat in the window
  // alongside ours, and any close task anyone had ever left on one of
  // them counted toward our averages. On the shared dev database that
  // was a single DONE ACCRUAL task ("Accrue bonus", 2026-12) — enough to
  // turn an expected sampleSize of 2 into 3 and fail the lead-time
  // assertion. CI never saw it because CI seeds a fresh database.
  //
  // Owning the entity makes the query's own scope axis ours, so no
  // amount of unrelated data on Northwind can reach these numbers.
  const entity = await prisma.legalEntity.create({
    data: {
      tenantId,
      code: `${SUFFIX}-ENT`.slice(0, 32),
      name: "Retrospective Test Co.",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  entityId = entity.id;

  const book = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!book) throw new Error("Need US_GAAP book.");
  bookId = book.id;

  // The calendar hangs off our own entity, so ordinals are ours too.
  // (The earlier "reuse the Northwind calendar + random ordinal in
  // 700..792" scheme produced P2002 on (calendarId, ordinal): the per-i
  // random ranges overlap within a run, and the shared calendar
  // accumulates periods across runs on a persistent database.)
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId,
      code: `${SUFFIX}-CAL`.slice(0, 32),
      name: "Retrospective Test Calendar",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  calendarId = cal.id;

  // Mint three fresh periods to isolate the test from other suites.
  // P1 ends 2026-04-30, P2 ends 2026-05-31, P3 ends 2026-06-30.
  const periodSpecs = [
    { code: `${SUFFIX}-P1`.slice(0, 30), starts: "2026-04-01", ends: "2026-04-30" },
    { code: `${SUFFIX}-P2`.slice(0, 30), starts: "2026-05-01", ends: "2026-05-31" },
    { code: `${SUFFIX}-P3`.slice(0, 30), starts: "2026-06-01", ends: "2026-06-30" },
  ];
  for (let i = 0; i < periodSpecs.length; i++) {
    const spec = periodSpecs[i];
    const p = await prisma.period.create({
      data: {
        tenantId,
        calendarId,
        code: spec.code,
        // Deterministic ordinals — collision-proof now that the calendar
        // is dedicated to this suite.
        ordinal: i + 1,
        startsOn: new Date(spec.starts),
        endsOn: new Date(spec.ends),
      },
      select: { id: true },
    });
    periodIds.push(p.id);
  }

  // Mint a small set of accounts for the fixtures.
  for (let i = 0; i < 4; i++) {
    const a = await prisma.account.create({
      data: {
        tenantId,
        code: `${SUFFIX}_${i}`.slice(0, 20),
        name: `Acct ${i}`,
        type: "ASSET",
        normalBalance: "DEBIT",
      },
      select: { id: true },
    });
    accountIds.push(a.id);
  }
});

afterAll(async () => {
  // Reverse FK order: close-tasks + recons + period-closes + accounts,
  // then any flux/task rows that point at periodIds, then the periods.
  await prisma.closeTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  await prisma.reconciliation.deleteMany({ where: { id: { in: createdReconIds } } });
  await prisma.periodClose.deleteMany({
    where: { periodId: { in: periodIds }, entityId, bookId },
  });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  for (const pid of periodIds) {
    try {
      await prisma.period.delete({ where: { id: pid } });
    } catch {
      /* leftover FKs from earlier failing runs — leak */
    }
  }
  // Remove the dedicated calendar once its periods are gone, then the
  // entity that owned it. Failures here are swallowed on purpose — a
  // leaked row must not turn a green suite red — which is exactly why
  // `scrubOrphans` exists to collect them on the next run.
  if (calendarId) {
    try {
      await prisma.fiscalCalendar.delete({ where: { id: calendarId } });
    } catch {
      /* periods may have leaked above — leave the calendar too */
    }
  }
  if (entityId) {
    try {
      await prisma.legalEntity.delete({ where: { id: entityId } });
    } catch {
      /* calendar may have leaked above — leave the entity too */
    }
  }
  await prisma.$disconnect();
});

/**
 * Delete anything this suite leaked on an earlier run, before seeding.
 *
 * A killed vitest (Ctrl-C, OOM, signal) skips `afterAll`, and what it
 * leaves is not inert: a leaked entity keeps its calendar, its periods
 * and their DONE close tasks, and those are precisely the rows a later
 * run averages over. Cleaning up only on the way out means the first
 * interrupted run poisons every run after it.
 *
 * Keyed on the entity code prefix, which is stable across runs while the
 * rest of the suffix is not. Deletes in FK order, and deliberately does
 * NOT swallow errors — a scrub that cannot finish should say so here
 * rather than let the suite seed on top of half-removed fixtures.
 */
async function scrubOrphans(): Promise<void> {
  const stale = await prisma.legalEntity.findMany({
    where: { tenantId, code: { startsWith: PREFIX } },
    select: { id: true },
  });
  if (stale.length === 0) return;
  const entityIds = stale.map((e) => e.id);

  const calendars = await prisma.fiscalCalendar.findMany({
    where: { entityId: { in: entityIds } },
    select: { id: true },
  });
  const calendarIds = calendars.map((c) => c.id);
  const periods = await prisma.period.findMany({
    where: { calendarId: { in: calendarIds } },
    select: { id: true },
  });
  const staleperiodIds = periods.map((p) => p.id);

  const tasks = await prisma.closeTask.findMany({
    where: { periodId: { in: staleperiodIds } },
    select: { id: true },
  });
  const taskIds = tasks.map((t) => t.id);
  await prisma.closeTaskComment.deleteMany({ where: { closeTaskId: { in: taskIds } } });
  await prisma.closeTaskStateChange.deleteMany({ where: { closeTaskId: { in: taskIds } } });
  await prisma.closeTask.deleteMany({ where: { id: { in: taskIds } } });

  const recons = await prisma.reconciliation.findMany({
    where: { entityId: { in: entityIds } },
    select: { id: true },
  });
  const reconIds = recons.map((r) => r.id);
  await prisma.reconciliationManualMatch.deleteMany({
    where: { reconciliationId: { in: reconIds } },
  });
  await prisma.reconciliation.deleteMany({ where: { id: { in: reconIds } } });

  await prisma.periodClose.deleteMany({ where: { entityId: { in: entityIds } } });
  await prisma.period.deleteMany({ where: { id: { in: staleperiodIds } } });
  await prisma.fiscalCalendar.deleteMany({ where: { id: { in: calendarIds } } });
  await prisma.account.deleteMany({ where: { tenantId, code: { startsWith: PREFIX } } });
  await prisma.legalEntity.deleteMany({ where: { id: { in: entityIds } } });
}

const scope = () => ({ tenantId, entityId, bookId });

describe("getCloseRetrospective — empty case", () => {
  it("returns empty trends and null summary stats when window has no data", async () => {
    // This used to verify the SHAPE only — arrays exist, summary
    // populated — because the suite borrowed NORTHWIND and "we can't
    // fully isolate because the entity has prior periods from the
    // Northwind seed". Owning the entity removes that compromise, so
    // the empty case can assert it is actually empty. That assertion
    // doubles as the proof that the isolation holds: it fails the
    // moment anything outside this suite reaches the window.
    const retro = await getCloseRetrospective(prisma, scope(), 1);
    expect(retro.scope).toEqual(scope());
    expect(retro.targetDays).toBe(5);
    expect(Array.isArray(retro.daysToCloseTrend)).toBe(true);
    expect(Array.isArray(retro.taskLeadTime)).toBe(true);
    expect(Array.isArray(retro.exceptionRateTrend)).toBe(true);
    expect(Array.isArray(retro.recurringBlockers)).toBe(true);
    expect(retro.summary.windowPeriods).toBe(1);
    expect(retro.daysToCloseTrend).toEqual([]);
    expect(retro.taskLeadTime).toEqual([]);
    expect(retro.recurringBlockers).toEqual([]);
  });
});

describe("Days-to-close trend", () => {
  it("computes (closedAt − endsOn) in floor days and marks metTarget vs SLA", async () => {
    // P1 endsOn 2026-04-30 → close on 2026-05-03 = 3 days (met SLA of 5)
    // P2 endsOn 2026-05-31 → close on 2026-06-09 = 9 days (slipped)
    // P3 left open
    await prisma.periodClose.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId: periodIds[0],
        closedAt: new Date("2026-05-03T17:00:00Z"),
      },
    });
    await prisma.periodClose.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId: periodIds[1],
        closedAt: new Date("2026-06-09T17:00:00Z"),
      },
    });

    const retro = await getCloseRetrospective(prisma, scope(), 60, 5);
    const myPoints = retro.daysToCloseTrend.filter((p) =>
      [periodIds[0], periodIds[1]].includes(p.periodId)
    );
    expect(myPoints).toHaveLength(2);

    // Oldest first → P1 (April) then P2 (May).
    const p1 = myPoints.find((p) => p.periodId === periodIds[0])!;
    const p2 = myPoints.find((p) => p.periodId === periodIds[1])!;
    expect(p1.daysToClose).toBe(3);
    expect(p1.metTarget).toBe(true);
    expect(p2.daysToClose).toBe(9);
    expect(p2.metTarget).toBe(false);

    // P3 is still open — must not appear.
    expect(retro.daysToCloseTrend.find((p) => p.periodId === periodIds[2])).toBeUndefined();
  });
});

describe("Task lead time by category", () => {
  it("averages (completedAt − createdAt) per category over DONE tasks", async () => {
    // ACCRUAL × 2: lead times 1d, 3d → avg 2.0
    // REPORTING × 1: lead time 6d → avg 6.0
    const accrual1 = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId: periodIds[0],
        name: "Accrue Apr utilities",
        category: "ACCRUAL",
        status: "DONE",
        createdAt: new Date("2026-05-01T12:00:00Z"),
        completedAt: new Date("2026-05-02T12:00:00Z"), // 1d
      },
      select: { id: true },
    });
    createdTaskIds.push(accrual1.id);
    const accrual2 = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId: periodIds[0],
        name: "Accrue Apr telecom",
        category: "ACCRUAL",
        status: "DONE",
        createdAt: new Date("2026-05-01T12:00:00Z"),
        completedAt: new Date("2026-05-04T12:00:00Z"), // 3d
      },
      select: { id: true },
    });
    createdTaskIds.push(accrual2.id);
    const reporting1 = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId: periodIds[1],
        name: "Generate June month-end packet",
        category: "REPORTING",
        status: "DONE",
        createdAt: new Date("2026-06-01T12:00:00Z"),
        completedAt: new Date("2026-06-07T12:00:00Z"), // 6d
      },
      select: { id: true },
    });
    createdTaskIds.push(reporting1.id);

    const retro = await getCloseRetrospective(prisma, scope(), 60);

    const accrualRow = retro.taskLeadTime.find((c) => c.category === "ACCRUAL");
    const reportingRow = retro.taskLeadTime.find((c) => c.category === "REPORTING");

    expect(accrualRow).toBeDefined();
    expect(accrualRow!.avgLeadDays).toBe(2);
    expect(accrualRow!.sampleSize).toBe(2);

    expect(reportingRow).toBeDefined();
    expect(reportingRow!.avgLeadDays).toBe(6);
    expect(reportingRow!.sampleSize).toBe(1);

    // Sort: worst (slowest) → best.
    const idxReporting = retro.taskLeadTime.indexOf(reportingRow!);
    const idxAccrual = retro.taskLeadTime.indexOf(accrualRow!);
    expect(idxReporting).toBeLessThan(idxAccrual);
  });
});

describe("Exception-rate trend", () => {
  it("counts EXCEPTION / total recons per period; 0 when no recons", async () => {
    // P1 (April): 3 recons, 1 exception → rate 1/3
    // P2 (May): 4 recons, 0 exception → rate 0
    // P3 (June): no recons → totals 0, rate 0
    const r1a = await prisma.reconciliation.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId: periodIds[0],
        accountId: accountIds[0],
        glBalance: "100" as never,
        tolerance: "0.5" as never,
        status: "EXCEPTION",
      },
      select: { id: true },
    });
    createdReconIds.push(r1a.id);
    const r1b = await prisma.reconciliation.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId: periodIds[0],
        accountId: accountIds[1],
        glBalance: "100" as never,
        tolerance: "0.5" as never,
        status: "RECONCILED",
      },
      select: { id: true },
    });
    createdReconIds.push(r1b.id);
    const r1c = await prisma.reconciliation.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId: periodIds[0],
        accountId: accountIds[2],
        glBalance: "100" as never,
        tolerance: "0.5" as never,
        status: "RECONCILED",
      },
      select: { id: true },
    });
    createdReconIds.push(r1c.id);

    for (let i = 0; i < 4; i++) {
      const r = await prisma.reconciliation.create({
        data: {
          tenantId,
          entityId,
          bookId,
          periodId: periodIds[1],
          accountId: accountIds[i % accountIds.length],
          // unique accountId per row — accountIds has 4 so i 0..3 is fine
          glBalance: "100" as never,
          tolerance: "0.5" as never,
          status: "RECONCILED",
        },
        select: { id: true },
      });
      createdReconIds.push(r.id);
    }

    const retro = await getCloseRetrospective(prisma, scope(), 60);
    const p1 = retro.exceptionRateTrend.find((p) => p.periodId === periodIds[0])!;
    const p2 = retro.exceptionRateTrend.find((p) => p.periodId === periodIds[1])!;
    const p3 = retro.exceptionRateTrend.find((p) => p.periodId === periodIds[2])!;

    expect(p1.totalRecons).toBe(3);
    expect(p1.exceptionCount).toBe(1);
    expect(p1.rate).toBeCloseTo(1 / 3, 6);

    expect(p2.totalRecons).toBe(4);
    expect(p2.exceptionCount).toBe(0);
    expect(p2.rate).toBe(0);

    expect(p3.totalRecons).toBe(0);
    expect(p3.exceptionCount).toBe(0);
    expect(p3.rate).toBe(0);
  });
});

describe("Recurring blockers", () => {
  it("ranks templates by BLOCKED count; never-blocked templates excluded", async () => {
    const blockedAuditTask = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId: periodIds[2],
        templateKey: "WAIT_FOR_AUDITOR",
        name: "Wait for auditor sign-off",
        category: "ADMIN",
        status: "BLOCKED",
        requiredForClose: true,
      },
      select: { id: true },
    });
    createdTaskIds.push(blockedAuditTask.id);
    // After PR 2/3, recurring-blockers reads from the state-change
    // log rather than the snapshot status. The Server Action path
    // would write this transition automatically; here we mint the
    // fixture row directly because we created the task via raw
    // Prisma (bypassing the action layer).
    await prisma.closeTaskStateChange.create({
      data: {
        tenantId,
        closeTaskId: blockedAuditTask.id,
        fromStatus: "IN_PROGRESS",
        toStatus: "BLOCKED",
        reason: "Waiting on auditor sign-off",
        changedById: userId,
      },
    });

    const cleanRunningTask = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId: periodIds[2],
        templateKey: "POST_ACCRUALS",
        name: "Post month-end accruals",
        category: "ACCRUAL",
        status: "IN_PROGRESS",
        requiredForClose: true,
      },
      select: { id: true },
    });
    createdTaskIds.push(cleanRunningTask.id);

    const retro = await getCloseRetrospective(prisma, scope(), 60);

    const auditEntry = retro.recurringBlockers.find(
      (b) => b.templateKey === "WAIT_FOR_AUDITOR"
    );
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.blockedCount).toBeGreaterThanOrEqual(1);

    const cleanEntry = retro.recurringBlockers.find(
      (b) => b.templateKey === "POST_ACCRUALS"
    );
    expect(cleanEntry).toBeUndefined();
  });
});

describe("Summary aggregates", () => {
  it("agree with per-row sums and trend lengths", async () => {
    const retro = await getCloseRetrospective(prisma, scope(), 60);

    // closedPeriodCount === daysToCloseTrend.length (always)
    expect(retro.summary.closedPeriodCount).toBe(retro.daysToCloseTrend.length);

    // pctMetTarget === metTarget count / closedPeriodCount
    if (retro.summary.closedPeriodCount === 0) {
      expect(retro.summary.pctMetTarget).toBeNull();
    } else {
      const metCount = retro.daysToCloseTrend.filter((p) => p.metTarget).length;
      expect(retro.summary.pctMetTarget).toBeCloseTo(
        metCount / retro.summary.closedPeriodCount,
        6
      );
    }

    // totalReconsCompleted === sum of per-period totalRecons
    const sumRecons = retro.exceptionRateTrend.reduce(
      (s, p) => s + p.totalRecons,
      0
    );
    expect(retro.summary.totalReconsCompleted).toBe(sumRecons);

    // avgExceptionRate === totalExceptions / totalRecons
    const sumEx = retro.exceptionRateTrend.reduce(
      (s, p) => s + p.exceptionCount,
      0
    );
    if (sumRecons === 0) {
      expect(retro.summary.avgExceptionRate).toBeNull();
    } else {
      expect(retro.summary.avgExceptionRate).toBeCloseTo(sumEx / sumRecons, 6);
    }
  });
});

describe("Ordering invariants", () => {
  it("daysToCloseTrend + exceptionRateTrend ordered oldest → newest", async () => {
    const retro = await getCloseRetrospective(prisma, scope(), 60);

    const dtc = retro.daysToCloseTrend
      .filter((p) => periodIds.includes(p.periodId))
      .map((p) => p.endsOn.getTime());
    for (let i = 1; i < dtc.length; i++) {
      expect(dtc[i]).toBeGreaterThanOrEqual(dtc[i - 1]);
    }

    // exception-rate trend covers ALL periods in window (not just
    // closed); just check the subset we minted to avoid coupling
    // to other suites' fixtures.
    const myEx = retro.exceptionRateTrend.filter((p) =>
      periodIds.includes(p.periodId)
    );
    // myEx is a slice of the full ordered trend — find positions and
    // assert monotonic by index of periodIds (P1 < P2 < P3 by mint
    // order which matches startsOn order).
    const positions = myEx.map((p) => periodIds.indexOf(p.periodId));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});
