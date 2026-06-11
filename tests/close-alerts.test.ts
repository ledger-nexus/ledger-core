// BlackLine arc — Phase 4 PR 2 tests.
//
// Pins the cross-pillar alert aggregator:
//   1. Recon EXCEPTION → high severity
//   2. Recon PREPARED stale ≥2d → medium; younger → low
//   3. Task BLOCKED + required → high; BLOCKED + optional → medium
//   4. Task overdue + required → medium; optional → low
//   5. Flux NEEDS_COMMENT lines on a statement older than 3 days → high;
//      younger → medium
//   6. Severity order in result: high → medium → low
//   7. Empty pillar / no statement / clean period returns []

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  getCloseAlerts,
  summarizeAlerts,
} from "@/lib/close/alerts";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const SUFFIX = "al4" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const NOW = new Date("2026-07-15T12:00:00Z");

let tenantId: string;
let entityId: string;
let bookId: string;
let periodId: string;
let userId: string;
let accountIds: string[] = [];
const createdReconIds: string[] = [];
const createdTaskIds: string[] = [];
const createdFluxIds: string[] = [];

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

  // Mint a fresh period to isolate the test.
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
      ordinal: 800 + (Math.floor(Math.random() * 199)),
      startsOn: new Date("2026-07-01"),
      endsOn: new Date("2026-07-31"),
    },
    select: { id: true },
  });
  periodId = p.id;

  // Mint accounts for the fixtures.
  for (let i = 0; i < 5; i++) {
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
  // Reverse FK order: lines + statements + tasks + recons + accounts
  // first, then any flux_statement rows that point at periodId via
  // toPeriodId (test failures may leak some), THEN delete the period.
  await prisma.fluxLine.deleteMany({
    where: { statement: { OR: [{ toPeriodId: periodId }, { fromPeriodId: periodId }] } },
  });
  await prisma.fluxStatement.deleteMany({
    where: { OR: [{ toPeriodId: periodId }, { fromPeriodId: periodId }] },
  });
  await prisma.closeTask.deleteMany({
    where: { id: { in: createdTaskIds } },
  });
  await prisma.reconciliation.deleteMany({
    where: { id: { in: createdReconIds } },
  });
  await prisma.account.deleteMany({
    where: { id: { in: accountIds } },
  });
  try {
    await prisma.period.delete({ where: { id: periodId } });
  } catch {
    /* leftover FKs from earlier failing runs — leak the period */
  }
  await prisma.$disconnect();
});

const scope = () => ({
  tenantId,
  entityId,
  bookId,
  periodId,
  periodCode: SUFFIX,
});

describe("getCloseAlerts — empty case", () => {
  it("returns [] when no pillars have any in-flight items", async () => {
    const alerts = await getCloseAlerts(prisma, scope(), NOW);
    expect(alerts).toEqual([]);
  });
});

describe("Recon pillar alerts", () => {
  it("EXCEPTION → high severity", async () => {
    const r = await prisma.reconciliation.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId,
        accountId: accountIds[0],
        glBalance: "100" as never,
        tolerance: "0.5" as never,
        status: "EXCEPTION",
      },
      select: { id: true },
    });
    createdReconIds.push(r.id);

    const alerts = await getCloseAlerts(prisma, scope(), NOW);
    const reconAlerts = alerts.filter((a) => a.pillar === "recon");
    expect(reconAlerts).toHaveLength(1);
    expect(reconAlerts[0].severity).toBe("high");
    expect(reconAlerts[0].title).toContain("EXCEPTION");
    expect(reconAlerts[0].href).toContain(r.id);
  });

  it("PREPARED stale ≥2d → medium severity", async () => {
    const preparedAt = new Date("2026-07-10T12:00:00Z"); // 5 days ago vs NOW
    const r = await prisma.reconciliation.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId,
        accountId: accountIds[1],
        glBalance: "100" as never,
        tolerance: "0.5" as never,
        status: "PREPARED",
        preparedBy: userId,
        preparedAt,
      },
      select: { id: true },
    });
    createdReconIds.push(r.id);

    const alerts = await getCloseAlerts(prisma, scope(), NOW);
    const found = alerts.find((a) => a.id === `recon:${r.id}`);
    expect(found).toBeDefined();
    expect(found!.severity).toBe("medium");
    expect(found!.ageDays).toBe(5);
  });
});

describe("Task pillar alerts", () => {
  it("BLOCKED + requiredForClose=true → high", async () => {
    const t = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId,
        name: "Blocked required task",
        category: "ADMIN",
        status: "BLOCKED",
        requiredForClose: true,
        blockedReason: "Waiting on bank confirmation",
      },
      select: { id: true },
    });
    createdTaskIds.push(t.id);

    const alerts = await getCloseAlerts(prisma, scope(), NOW);
    const found = alerts.find((a) => a.id === `task:${t.id}`);
    expect(found).toBeDefined();
    expect(found!.severity).toBe("high");
    expect(found!.description).toBe("Waiting on bank confirmation");
  });

  it("BLOCKED + requiredForClose=false → medium", async () => {
    const t = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId,
        name: "Blocked optional task",
        category: "ADMIN",
        status: "BLOCKED",
        requiredForClose: false,
        blockedReason: "Low-pri followup",
      },
      select: { id: true },
    });
    createdTaskIds.push(t.id);

    const alerts = await getCloseAlerts(prisma, scope(), NOW);
    const found = alerts.find((a) => a.id === `task:${t.id}`);
    expect(found!.severity).toBe("medium");
  });

  it("overdue NOT_STARTED + required → medium", async () => {
    const t = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId,
        name: "Overdue task",
        category: "ACCRUAL",
        status: "NOT_STARTED",
        requiredForClose: true,
        dueAt: new Date("2026-07-10"), // 5 days ago
      },
      select: { id: true },
    });
    createdTaskIds.push(t.id);

    const alerts = await getCloseAlerts(prisma, scope(), NOW);
    const found = alerts.find((a) => a.id === `task:${t.id}`);
    expect(found).toBeDefined();
    expect(found!.severity).toBe("medium");
    expect(found!.title).toContain("Overdue");
  });
});

describe("Flux pillar alerts", () => {
  it("statement older than 3 days with NEEDS_COMMENT lines → high", async () => {
    // Need a "from" period for the statement scope. Use any period.
    const otherPeriod = await prisma.period.findFirst({
      where: { calendar: { entityId }, id: { not: periodId } },
      select: { id: true },
    });
    if (!otherPeriod) throw new Error("Need a second period.");

    const stmt = await prisma.fluxStatement.create({
      data: {
        tenantId,
        entityId,
        bookId,
        fromPeriodId: otherPeriod.id,
        toPeriodId: periodId,
        absoluteThreshold: "5000" as never,
        percentThreshold: "10" as never,
        status: "DRAFT",
      },
      select: { id: true },
    });
    // Pull and back-date the created/updated stamps. Need explicit
    // ::uuid cast for the WHERE id match — Prisma's $executeRawUnsafe
    // binds positional args as text by default.
    await prisma.$executeRawUnsafe(
      `UPDATE flux_statement SET "createdAt" = $1, "updatedAt" = $1 WHERE id = $2::uuid`,
      new Date("2026-07-10T12:00:00Z"), // 5 days before NOW
      stmt.id
    );
    createdFluxIds.push(stmt.id);

    await prisma.fluxLine.create({
      data: {
        tenantId,
        statementId: stmt.id,
        accountId: accountIds[2],
        priorAmount: "100" as never,
        currentAmount: "10000" as never,
        deltaAmount: "9900" as never,
        deltaPercent: "9900" as never,
        status: "NEEDS_COMMENT",
      },
    });

    const alerts = await getCloseAlerts(prisma, scope(), NOW);
    const fluxAlerts = alerts.filter((a) => a.pillar === "flux");
    expect(fluxAlerts).toHaveLength(1);
    expect(fluxAlerts[0].severity).toBe("high");
    expect(fluxAlerts[0].href).toContain(stmt.id);
  });
});

describe("Sort + histogram", () => {
  it("sorts high → medium → low; histogram counts agree", async () => {
    const alerts = await getCloseAlerts(prisma, scope(), NOW);
    const sevSeq = alerts.map((a) => a.severity);
    // Every "medium" must come AFTER every "high"; every "low" after
    // every "medium".
    let phase = 0; // 0=high, 1=medium, 2=low
    for (const s of sevSeq) {
      if (s === "high") {
        expect(phase).toBe(0);
      } else if (s === "medium") {
        if (phase === 0) phase = 1;
        else expect(phase).toBe(1);
      } else {
        if (phase < 2) phase = 2;
        expect(phase).toBe(2);
      }
    }

    const histogram = summarizeAlerts(alerts);
    expect(histogram.total).toBe(alerts.length);
    const sumSev =
      histogram.bySeverity.high +
      histogram.bySeverity.medium +
      histogram.bySeverity.low;
    expect(sumSev).toBe(alerts.length);
    const sumPil =
      histogram.byPillar.recon +
      histogram.byPillar.task +
      histogram.byPillar.flux;
    expect(sumPil).toBe(alerts.length);
  });
});
