// Close-task state-history PR 2/3 tests.
//
// Pins the historical-vs-snapshot difference in recurringBlockers:
//   1. A task that was BLOCKED then unblocked still counts as a
//      recurring blocker (the old snapshot impl would have missed it)
//   2. A task that NEVER hit BLOCKED is excluded
//   3. A template can be in_progress now, but if it hit BLOCKED at
//      least once in the window it appears in the rollup
//   4. Multiple BLOCKED transitions on the same task count as ONE
//      (the metric is "tasks ever blocked", not "block transitions")
//   5. Ad-hoc tasks (templateKey = null) bucket by name
//   6. Sort by blockedCount desc; top 10 cap respected

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getCloseRetrospective } from "@/lib/close/retrospective";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const SUFFIX =
  "crh" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let entityId: string;
let bookId: string;
let userId: string;
let periodIds: string[] = [];

const createdTaskIds: string[] = [];

beforeAll(async () => {
  tenantId = await getDefaultTenantId(prisma);
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  userId = u.id;

  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId, code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) throw new Error("Need Northwind entity.");
  entityId = entity.id;

  const book = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!book) throw new Error("Need US_GAAP book.");
  bookId = book.id;

  const cal = await prisma.fiscalCalendar.findFirst({
    where: { entityId },
    select: { id: true },
  });
  if (!cal) throw new Error("Need a calendar.");

  // Three test periods.
  for (let i = 0; i < 3; i++) {
    const p = await prisma.period.create({
      data: {
        tenantId,
        calendarId: cal.id,
        code: `${SUFFIX}-P${i}`.slice(0, 30),
        ordinal: 600 + i + Math.floor(Math.random() * 90),
        startsOn: new Date(`2026-0${i + 4}-01`),
        endsOn: new Date(`2026-0${i + 4}-${i === 1 ? 31 : 30}`),
      },
      select: { id: true },
    });
    periodIds.push(p.id);
  }
});

afterAll(async () => {
  // close-task delete cascades the state-change rows (the trigger's
  // cascade carve-out via pg_trigger_depth() permits it).
  await prisma.closeTask.deleteMany({
    where: { id: { in: createdTaskIds } },
  });
  for (const pid of periodIds) {
    try {
      await prisma.period.delete({ where: { id: pid } });
    } catch {
      /* leftover FKs from earlier failing runs */
    }
  }
  await prisma.$disconnect();
});

const scope = () => ({ tenantId, entityId, bookId });

async function mintTaskWithHistory(opts: {
  periodId: string;
  templateKey: string | null;
  name: string;
  finalStatus: "NOT_STARTED" | "IN_PROGRESS" | "DONE" | "BLOCKED" | "WAIVED";
  hitBlocked?: boolean; // if true, INSERT a BLOCKED transition into the history regardless of finalStatus
}): Promise<string> {
  const t = await prisma.closeTask.create({
    data: {
      tenantId,
      periodId: opts.periodId,
      templateKey: opts.templateKey,
      name: opts.name,
      category: "ADMIN",
      requiredForClose: true,
      status: opts.finalStatus,
    },
    select: { id: true },
  });
  createdTaskIds.push(t.id);
  // Use raw SQL bypassing the trigger? No — the trigger allows INSERT.
  // The trigger only blocks UPDATE + direct DELETE.
  if (opts.hitBlocked) {
    await prisma.closeTaskStateChange.create({
      data: {
        tenantId,
        closeTaskId: t.id,
        fromStatus: "IN_PROGRESS",
        toStatus: "BLOCKED",
        reason: "Test fixture",
        changedById: userId,
      },
    });
  }
  if (opts.finalStatus !== "NOT_STARTED") {
    await prisma.closeTaskStateChange.create({
      data: {
        tenantId,
        closeTaskId: t.id,
        fromStatus: opts.hitBlocked ? "BLOCKED" : "NOT_STARTED",
        toStatus: opts.finalStatus,
        reason: null,
        changedById: userId,
      },
    });
  }
  return t.id;
}

describe("recurringBlockers — historical replay", () => {
  it("captures a task that was BLOCKED then unblocked (snapshot would miss)", async () => {
    // Template that hit BLOCKED, then got unblocked + completed. Under
    // the old snapshot impl, current status=DONE → would NOT appear.
    // Under the historical impl, hitBlocked=true → appears.
    await mintTaskWithHistory({
      periodId: periodIds[0],
      templateKey: `${SUFFIX}_WAS_BLOCKED_NOW_DONE`,
      name: "Was blocked then completed",
      finalStatus: "DONE",
      hitBlocked: true,
    });

    const retro = await getCloseRetrospective(prisma, scope(), 60);
    const found = retro.recurringBlockers.find(
      (b) => b.templateKey === `${SUFFIX}_WAS_BLOCKED_NOW_DONE`
    );
    expect(found).toBeDefined();
    expect(found!.blockedCount).toBe(1);
    expect(found!.totalCount).toBe(1);
  });

  it("excludes templates that never hit BLOCKED", async () => {
    await mintTaskWithHistory({
      periodId: periodIds[0],
      templateKey: `${SUFFIX}_CLEAN`,
      name: "Clean task",
      finalStatus: "DONE",
      hitBlocked: false,
    });

    const retro = await getCloseRetrospective(prisma, scope(), 60);
    const found = retro.recurringBlockers.find(
      (b) => b.templateKey === `${SUFFIX}_CLEAN`
    );
    expect(found).toBeUndefined();
  });

  it("counts ONE blocked task even with multiple BLOCKED transitions", async () => {
    // Same task hits BLOCKED twice (got unblocked then re-blocked).
    // Should count as 1 ever-blocked task, not 2.
    const id = await mintTaskWithHistory({
      periodId: periodIds[1],
      templateKey: `${SUFFIX}_DOUBLE_BLOCK`,
      name: "Double-blocked task",
      finalStatus: "BLOCKED",
      hitBlocked: true,
    });
    // Add a second BLOCKED transition.
    await prisma.closeTaskStateChange.create({
      data: {
        tenantId,
        closeTaskId: id,
        fromStatus: "IN_PROGRESS",
        toStatus: "BLOCKED",
        reason: "Second block",
        changedById: userId,
      },
    });

    const retro = await getCloseRetrospective(prisma, scope(), 60);
    const found = retro.recurringBlockers.find(
      (b) => b.templateKey === `${SUFFIX}_DOUBLE_BLOCK`
    );
    expect(found).toBeDefined();
    expect(found!.blockedCount).toBe(1);
    expect(found!.totalCount).toBe(1);
  });

  it("counts distinct tasks per template across the window", async () => {
    // Same template, multiple periods, each with a BLOCKED hit.
    await mintTaskWithHistory({
      periodId: periodIds[0],
      templateKey: `${SUFFIX}_RECURRING`,
      name: "Recurring blocker",
      finalStatus: "DONE",
      hitBlocked: true,
    });
    await mintTaskWithHistory({
      periodId: periodIds[1],
      templateKey: `${SUFFIX}_RECURRING`,
      name: "Recurring blocker",
      finalStatus: "DONE",
      hitBlocked: true,
    });
    await mintTaskWithHistory({
      periodId: periodIds[2],
      templateKey: `${SUFFIX}_RECURRING`,
      name: "Recurring blocker",
      finalStatus: "BLOCKED",
      hitBlocked: true,
    });

    const retro = await getCloseRetrospective(prisma, scope(), 60);
    const found = retro.recurringBlockers.find(
      (b) => b.templateKey === `${SUFFIX}_RECURRING`
    );
    expect(found).toBeDefined();
    expect(found!.blockedCount).toBe(3);
    expect(found!.totalCount).toBe(3);
    expect(found!.blockRate).toBe(1);
  });

  it("ad-hoc tasks (null templateKey) bucket by name", async () => {
    await mintTaskWithHistory({
      periodId: periodIds[0],
      templateKey: null,
      name: `${SUFFIX} ad-hoc blocker`,
      finalStatus: "DONE",
      hitBlocked: true,
    });
    await mintTaskWithHistory({
      periodId: periodIds[1],
      templateKey: null,
      name: `${SUFFIX} ad-hoc blocker`,
      finalStatus: "DONE",
      hitBlocked: true,
    });

    const retro = await getCloseRetrospective(prisma, scope(), 60);
    const found = retro.recurringBlockers.find(
      (b) => b.templateKey === null && b.name === `${SUFFIX} ad-hoc blocker`
    );
    expect(found).toBeDefined();
    expect(found!.blockedCount).toBe(2);
  });

  it("sorts by blockedCount desc and respects top-10 cap", async () => {
    const retro = await getCloseRetrospective(prisma, scope(), 60);
    expect(retro.recurringBlockers.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < retro.recurringBlockers.length; i++) {
      expect(retro.recurringBlockers[i].blockedCount).toBeLessThanOrEqual(
        retro.recurringBlockers[i - 1].blockedCount
      );
    }
  });
});
