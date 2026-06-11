// BlackLine arc — Phase 3 PR 4 tests.
//
// Pins:
//   - getFluxRollup math (histogram + signed/material counts)
//   - signedOff = (FINALIZED && signed === material)
//   - "latest by updatedAt" tie-break when multiple statements exist
//     for the same toPeriod (from-period varies)
//   - null return when no statement exists
//   - fluxRollupLine natural-language string

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getFluxRollup, fluxRollupLine } from "@/lib/flux/rollup";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const SUFFIX = "fxr" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let entityId: string;
let bookId: string;
let fromPeriodId: string;
let toPeriodId: string;
let altFromPeriodId: string;
let accountIds: string[] = [];
const createdStatements: string[] = [];

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
  if (!book) throw new Error("Missing US_GAAP book.");
  bookId = book.id;

  // Use any three distinct seeded periods. fromPeriod = oldest,
  // altFromPeriod = middle, toPeriod = newest. The "latest-by-
  // updatedAt" test creates statements against both (from, to)
  // combinations.
  const periods = await prisma.period.findMany({
    where: { calendar: { entityId } },
    orderBy: { startsOn: "asc" },
    take: 3,
    select: { id: true },
  });
  if (periods.length < 3) throw new Error("Need ≥3 periods seeded.");
  fromPeriodId = periods[0].id;
  altFromPeriodId = periods[1].id;
  toPeriodId = periods[2].id;

  // Mint 5 accounts with a known status distribution.
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
  await prisma.fluxLine.deleteMany({
    where: { statementId: { in: createdStatements } },
  });
  await prisma.fluxStatement.deleteMany({
    where: { id: { in: createdStatements } },
  });
  await prisma.account.deleteMany({
    where: { id: { in: accountIds } },
  });
  await prisma.$disconnect();
});

describe("getFluxRollup", () => {
  it("returns null when no statement exists for the scope", async () => {
    const r = await getFluxRollup(prisma, {
      tenantId,
      entityId,
      bookId,
      toPeriodId,
    });
    expect(r).toBeNull();
  });

  it("rolls up status histogram + signed/material counts", async () => {
    // 5-account mix:
    //   1 IMMATERIAL
    //   1 NEEDS_COMMENT
    //   2 EXPLAINED
    //   1 WAIVED
    const stmt = await prisma.fluxStatement.create({
      data: {
        tenantId,
        entityId,
        bookId,
        fromPeriodId,
        toPeriodId,
        absoluteThreshold: "5000" as never,
        percentThreshold: "10" as never,
        status: "DRAFT",
      },
      select: { id: true },
    });
    createdStatements.push(stmt.id);

    const spec: {
      acctIdx: number;
      status:
        | "IMMATERIAL"
        | "NEEDS_COMMENT"
        | "EXPLAINED"
        | "WAIVED";
    }[] = [
      { acctIdx: 0, status: "IMMATERIAL" },
      { acctIdx: 1, status: "NEEDS_COMMENT" },
      { acctIdx: 2, status: "EXPLAINED" },
      { acctIdx: 3, status: "EXPLAINED" },
      { acctIdx: 4, status: "WAIVED" },
    ];
    for (const s of spec) {
      await prisma.fluxLine.create({
        data: {
          tenantId,
          statementId: stmt.id,
          accountId: accountIds[s.acctIdx],
          priorAmount: "100" as never,
          currentAmount: "100" as never,
          deltaAmount: "0" as never,
          status: s.status,
        },
      });
    }

    const r = await getFluxRollup(prisma, {
      tenantId,
      entityId,
      bookId,
      toPeriodId,
    });
    expect(r).not.toBeNull();
    expect(r!.total).toBe(5);
    expect(r!.immaterial).toBe(1);
    expect(r!.needsComment).toBe(1);
    expect(r!.explained).toBe(2);
    expect(r!.waived).toBe(1);
    expect(r!.material).toBe(4); // exclude IMMATERIAL
    expect(r!.signed).toBe(3); // EXPLAINED + WAIVED
    // status=DRAFT, signed < material → not signed off yet
    expect(r!.signedOff).toBe(false);
  });

  it("signedOff requires FINALIZED status AND signed === material", async () => {
    // Statement above has 1 NEEDS_COMMENT remaining. Flip it to
    // EXPLAINED, then finalize, then re-check.
    const stmt = await prisma.fluxStatement.findFirst({
      where: { entityId, bookId, toPeriodId },
      select: { id: true },
    });
    if (!stmt) throw new Error("missing statement");
    await prisma.fluxLine.updateMany({
      where: { statementId: stmt.id, status: "NEEDS_COMMENT" },
      data: { status: "EXPLAINED" },
    });

    // Pre-finalize: signed === material but status still DRAFT →
    // NOT signedOff.
    const r1 = await getFluxRollup(prisma, {
      tenantId,
      entityId,
      bookId,
      toPeriodId,
    });
    expect(r1!.signed).toBe(4);
    expect(r1!.material).toBe(4);
    expect(r1!.signedOff).toBe(false);

    // Finalize → signedOff = true.
    await prisma.fluxStatement.update({
      where: { id: stmt.id },
      data: {
        status: "FINALIZED",
        finalizedAt: new Date("2026-06-30"),
      },
    });
    const r2 = await getFluxRollup(prisma, {
      tenantId,
      entityId,
      bookId,
      toPeriodId,
    });
    expect(r2!.status).toBe("FINALIZED");
    expect(r2!.signedOff).toBe(true);
  });

  it("picks the most-recently-updated statement when multiple exist for the same toPeriod", async () => {
    // Create a SECOND statement against the same toPeriod but a
    // different fromPeriod. Its updatedAt is newer than the existing
    // statement's; getFluxRollup should return THIS one.
    const stmt2 = await prisma.fluxStatement.create({
      data: {
        tenantId,
        entityId,
        bookId,
        fromPeriodId: altFromPeriodId, // different prior period
        toPeriodId,
        absoluteThreshold: "10000" as never,
        percentThreshold: "20" as never,
        status: "DRAFT",
      },
      select: { id: true },
    });
    createdStatements.push(stmt2.id);
    // Add one IMMATERIAL line so the histogram is distinct (total=1).
    await prisma.fluxLine.create({
      data: {
        tenantId,
        statementId: stmt2.id,
        accountId: accountIds[0],
        priorAmount: "100" as never,
        currentAmount: "100" as never,
        deltaAmount: "0" as never,
        status: "IMMATERIAL",
      },
    });

    const r = await getFluxRollup(prisma, {
      tenantId,
      entityId,
      bookId,
      toPeriodId,
    });
    expect(r!.statementId).toBe(stmt2.id);
    expect(r!.total).toBe(1);
    expect(r!.status).toBe("DRAFT");
  });
});

describe("fluxRollupLine", () => {
  it("renders 'No flux statement' when null", () => {
    expect(fluxRollupLine(null)).toBe("No flux statement for this period");
  });

  it("renders DRAFT + signed + pending when in progress", () => {
    const line = fluxRollupLine({
      statementId: "x",
      status: "DRAFT",
      finalizedAt: null,
      finalizedBy: null,
      total: 47,
      immaterial: 24,
      needsComment: 3,
      explained: 18,
      waived: 2,
      material: 23,
      signed: 20,
      signedOff: false,
    });
    expect(line).toContain("20 of 23 material");
    expect(line).toContain("3 pending");
    expect(line).toContain("47 total");
    expect(line).toContain("DRAFT");
  });

  it("renders FINALIZED when complete", () => {
    const line = fluxRollupLine({
      statementId: "x",
      status: "FINALIZED",
      finalizedAt: new Date(),
      finalizedBy: "Alice",
      total: 23,
      immaterial: 0,
      needsComment: 0,
      explained: 23,
      waived: 0,
      material: 23,
      signed: 23,
      signedOff: true,
    });
    expect(line).toContain("23 of 23 material");
    expect(line).not.toContain("pending");
    expect(line).toContain("FINALIZED");
  });
});
