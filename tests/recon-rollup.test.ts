// BlackLine arc — Phase 1 PR 8 tests.
//
// Pins the rollup math + summary-line strings. Cheap unit-flavored
// against real Postgres: spin up recons across all 6 statuses on a
// scratch period, verify the histogram + done count + pctDone.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  getReconciliationRollup,
  rollupSummaryLine,
} from "@/lib/recon/rollup";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const SUFFIX =
  "rcn8" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let entityId: string;
let bookId: string;
let periodId: string;
const accountIds: string[] = [];
const reconIds: string[] = [];

beforeAll(async () => {
  tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId, code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) throw new Error("Run Northwind seed first.");
  entityId = entity.id;
  const book = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!book) throw new Error("Missing US_GAAP book");
  bookId = book.id;

  // Fresh period so the rollup is isolated from any seed-loaded recons.
  const cal = await prisma.fiscalCalendar.findFirst({
    where: { entityId },
    select: { id: true },
  });
  if (!cal) throw new Error("Need a calendar");
  const p = await prisma.period.create({
    data: {
      tenantId,
      calendarId: cal.id,
      code: `${SUFFIX}-PR`.slice(0, 30),
      ordinal: 99,
      startsOn: new Date("2026-09-01"),
      endsOn: new Date("2026-09-30"),
    },
    select: { id: true },
  });
  periodId = p.id;

  // 10 recons across statuses:
  //   3 RECONCILED, 1 WAIVED → done = 4
  //   2 PREPARED, 1 IN_PROGRESS, 1 OPEN, 2 EXCEPTION → outstanding = 6
  // pctDone = round(4/10 * 100) = 40
  const distribution: {
    status: "RECONCILED" | "WAIVED" | "PREPARED" | "IN_PROGRESS" | "OPEN" | "EXCEPTION";
    n: number;
  }[] = [
    { status: "RECONCILED", n: 3 },
    { status: "WAIVED", n: 1 },
    { status: "PREPARED", n: 2 },
    { status: "IN_PROGRESS", n: 1 },
    { status: "OPEN", n: 1 },
    { status: "EXCEPTION", n: 2 },
  ];

  let i = 0;
  for (const d of distribution) {
    for (let j = 0; j < d.n; j++) {
      i++;
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
      const r = await prisma.reconciliation.create({
        data: {
          tenantId,
          entityId,
          bookId,
          periodId,
          accountId: a.id,
          glBalance: "100.00" as never,
          tolerance: "0.50" as never,
          status: d.status,
          requiresReview: true,
        },
        select: { id: true },
      });
      reconIds.push(r.id);
    }
  }
});

afterAll(async () => {
  await prisma.reconciliation.deleteMany({
    where: { id: { in: reconIds } },
  });
  await prisma.account.deleteMany({
    where: { id: { in: accountIds } },
  });
  await prisma.period.delete({ where: { id: periodId } });
  await prisma.$disconnect();
});

describe("getReconciliationRollup — month-end packet math", () => {
  it("returns the per-status histogram + done count + pctDone", async () => {
    const r = await getReconciliationRollup(prisma, {
      tenantId,
      entityId,
      bookId,
      periodId,
    });
    expect(r.total).toBe(10);
    expect(r.reconciled).toBe(3);
    expect(r.waived).toBe(1);
    expect(r.prepared).toBe(2);
    expect(r.inProgress).toBe(1);
    expect(r.open).toBe(1);
    expect(r.exception).toBe(2);
    expect(r.done).toBe(4); // reconciled + waived
    expect(r.pctDone).toBe(40);
  });

  it("scope-tight: a different periodId returns zero counts", async () => {
    // Use a UUID that points nowhere.
    const r = await getReconciliationRollup(prisma, {
      tenantId,
      entityId,
      bookId,
      periodId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.total).toBe(0);
    expect(r.done).toBe(0);
    expect(r.pctDone).toBe(0);
  });

  it("rollupSummaryLine renders the natural-language sentence", async () => {
    const r = await getReconciliationRollup(prisma, {
      tenantId,
      entityId,
      bookId,
      periodId,
    });
    const line = rollupSummaryLine(r);
    expect(line).toContain("4 of 10 signed off (40%)");
    expect(line).toContain("2 exceptions");
    expect(line).toContain("2 awaiting review"); // PREPARED
    expect(line).toContain("1 sent back"); // IN_PROGRESS
    expect(line).toContain("1 not started"); // OPEN
  });

  it("rollupSummaryLine handles total=0 gracefully", () => {
    const line = rollupSummaryLine({
      total: 0,
      reconciled: 0,
      waived: 0,
      prepared: 0,
      inProgress: 0,
      open: 0,
      exception: 0,
      done: 0,
      pctDone: 0,
    });
    expect(line).toBe("No reconciliations opened for this period");
  });
});
