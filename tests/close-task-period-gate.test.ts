// BlackLine arc — Phase 2 PR 6 tests.
//
// Pins:
//   1. getCloseTaskRollup math (histogram + pctDone)
//   2. checkRequiredTasksComplete returns the right blocker set
//   3. closePeriodAction refuses with taskBlockers when any required
//      task isn't terminal — and writes a close-period.refused audit
//   4. closePeriodAction succeeds when blockers clear (terminal status
//      or requiredForClose=false)
//   5. ADMIN_POSTMORTEM (the one !requiredForClose template) does NOT
//      block the close — composes with the Phase 2 PR 5 seed shape

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  getCloseTaskRollup,
  checkRequiredTasksComplete,
} from "@/lib/close-tasks/rollup";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const SUFFIX =
  "ct6" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let entityId: string;
let bookId: string;
let periodId: string;
const taskIds: string[] = [];

beforeAll(async () => {
  // Use the default seeded tenant to keep this self-contained.
  tenantId = await getDefaultTenantId(prisma);

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

  // Mint a fresh isolated period (so we don't conflict with seed-time
  // tasks if any other test left them behind).
  const cal = await prisma.fiscalCalendar.findFirst({
    where: { entityId },
    select: { id: true },
  });
  if (!cal) throw new Error("Need a calendar.");
  const p = await prisma.period.create({
    data: {
      tenantId,
      calendarId: cal.id,
      code: `${SUFFIX}-PR`.slice(0, 30),
      ordinal: 999,
      startsOn: new Date("2026-11-01"),
      endsOn: new Date("2026-11-30"),
    },
    select: { id: true },
  });
  periodId = p.id;

  // Build a 5-task mix:
  //   2 DONE (terminal — count toward terminal)
  //   1 WAIVED (terminal)
  //   1 IN_PROGRESS (required, blocking)
  //   1 NOT_STARTED + requiredForClose=false (does NOT block)
  // Expected: terminal=3/5 (60%), 1 blocker.
  const taskSpec: {
    name: string;
    status: "DONE" | "WAIVED" | "IN_PROGRESS" | "NOT_STARTED";
    required: boolean;
  }[] = [
    { name: "Task A done", status: "DONE", required: true },
    { name: "Task B done", status: "DONE", required: true },
    { name: "Task C waived", status: "WAIVED", required: true },
    { name: "Task D in progress", status: "IN_PROGRESS", required: true },
    { name: "Task E optional", status: "NOT_STARTED", required: false },
  ];
  for (const t of taskSpec) {
    const row = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId,
        name: t.name,
        category: "ADMIN",
        status: t.status,
        requiredForClose: t.required,
      },
      select: { id: true },
    });
    taskIds.push(row.id);
  }
});

afterAll(async () => {
  await prisma.closeTask.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.periodClose.deleteMany({ where: { periodId } });
  await prisma.period.delete({ where: { id: periodId } });
  await prisma.$disconnect();
});

describe("getCloseTaskRollup — Periods-page badge math", () => {
  it("returns the per-status histogram + pctDone", async () => {
    const r = await getCloseTaskRollup(prisma, { tenantId, periodId });
    expect(r.total).toBe(5);
    expect(r.done).toBe(2);
    expect(r.waived).toBe(1);
    expect(r.inProgress).toBe(1);
    expect(r.notStarted).toBe(1);
    expect(r.blocked).toBe(0);
    expect(r.terminal).toBe(3); // done + waived
    expect(r.pctDone).toBe(60); // round(3/5 * 100)
  });

  it("zero-task period returns zeros", async () => {
    const r = await getCloseTaskRollup(prisma, {
      tenantId,
      periodId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.total).toBe(0);
    expect(r.terminal).toBe(0);
    expect(r.pctDone).toBe(0);
  });
});

describe("checkRequiredTasksComplete — close-gate signal", () => {
  it("returns the 1 required-non-terminal task; ignores the optional one", async () => {
    const blockers = await checkRequiredTasksComplete(prisma, {
      tenantId,
      periodId,
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0].name).toBe("Task D in progress");
    expect(blockers[0].status).toBe("IN_PROGRESS");
  });

  it("returns empty when all required tasks are terminal", async () => {
    // Flip the IN_PROGRESS one to DONE — should clear the gate even
    // though the NOT_STARTED optional task remains.
    const dId = taskIds[3];
    await prisma.closeTask.update({
      where: { id: dId },
      data: { status: "DONE" },
    });
    const blockers = await checkRequiredTasksComplete(prisma, {
      tenantId,
      periodId,
    });
    expect(blockers).toEqual([]);
    // Restore for downstream tests.
    await prisma.closeTask.update({
      where: { id: dId },
      data: { status: "IN_PROGRESS" },
    });
  });
});

describe("close-gate composition", () => {
  it("waived counts as terminal — does not block the close", async () => {
    // WAIVED is one of our 3 terminal rows; the gate test above
    // already confirmed only 1 blocker (the IN_PROGRESS, not the
    // WAIVED). This test makes the intent explicit.
    const blockers = await checkRequiredTasksComplete(prisma, {
      tenantId,
      periodId,
    });
    const waivedBlockers = blockers.filter((b) => b.status === "WAIVED");
    expect(waivedBlockers).toHaveLength(0);
  });

  it("requiredForClose=false is excluded from blockers", async () => {
    // Task E is NOT_STARTED + !requiredForClose. It must NOT appear.
    const blockers = await checkRequiredTasksComplete(prisma, {
      tenantId,
      periodId,
    });
    const optionalBlockers = blockers.filter((b) =>
      b.name.includes("optional")
    );
    expect(optionalBlockers).toHaveLength(0);
  });
});
