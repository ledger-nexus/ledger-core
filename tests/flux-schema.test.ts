// BlackLine arc — Phase 3 PR 1 tests.
//
// Round-trips the new schema:
//   - FluxStatement: idempotent regen via @@unique([entityId, bookId,
//     fromPeriodId, toPeriodId])
//   - FluxLine: cascade-delete from statement
//   - Frozen-snapshot fields preserved on read
//   - deltaPercent nullable (division-by-zero guard for new accounts)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const SUFFIX = "fx1" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let entityId: string;
let bookId: string;
let fromPeriodId: string;
let toPeriodId: string;
let accountId: string;
const createdStatements: string[] = [];
let createdAccount = false;

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

  // Use any two distinct seeded periods.
  const periods = await prisma.period.findMany({
    where: { calendar: { entityId } },
    orderBy: { startsOn: "asc" },
    take: 2,
    select: { id: true },
  });
  if (periods.length < 2) throw new Error("Need ≥2 periods seeded.");
  fromPeriodId = periods[0].id;
  toPeriodId = periods[1].id;

  // Mint an isolated account so we don't collide with any existing
  // flux rows on the seeded chart (no Phase 3 seed yet, but safe).
  const acct = await prisma.account.create({
    data: {
      tenantId,
      code: `${SUFFIX}_FX`.slice(0, 20),
      name: "Flux test acct",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    select: { id: true },
  });
  accountId = acct.id;
  createdAccount = true;
});

afterAll(async () => {
  await prisma.fluxLine.deleteMany({
    where: { statementId: { in: createdStatements } },
  });
  await prisma.fluxStatement.deleteMany({
    where: { id: { in: createdStatements } },
  });
  if (createdAccount) {
    await prisma.account.delete({ where: { id: accountId } });
  }
  await prisma.$disconnect();
});

describe("FluxStatement schema — Phase 3 PR 1", () => {
  it("round-trips a FluxStatement with frozen threshold + status fields", async () => {
    const stmt = await prisma.fluxStatement.create({
      data: {
        tenantId,
        entityId,
        bookId,
        fromPeriodId,
        toPeriodId,
        absoluteThreshold: "5000.00" as never,
        percentThreshold: "10.00" as never,
        status: "DRAFT",
      },
      select: {
        id: true,
        absoluteThreshold: true,
        percentThreshold: true,
        status: true,
      },
    });
    createdStatements.push(stmt.id);
    expect(stmt.status).toBe("DRAFT");
    expect(stmt.absoluteThreshold.toString()).toBe("5000");
    expect(stmt.percentThreshold.toString()).toBe("10");
  });

  it("blocks duplicate statement on the (entity, book, from, to) composite", async () => {
    await expect(
      prisma.fluxStatement.create({
        data: {
          tenantId,
          entityId,
          bookId,
          fromPeriodId,
          toPeriodId,
          absoluteThreshold: "9999" as never,
          percentThreshold: "99" as never,
        },
      })
    ).rejects.toThrow(/unique/i);
  });

  it("idempotent re-run via upsert refreshes thresholds without duplicating", async () => {
    // The application-layer regenerator (PR 2) will use upsert; pin
    // that the composite key supports it cleanly.
    const upserted = await prisma.fluxStatement.upsert({
      where: {
        entityId_bookId_fromPeriodId_toPeriodId: {
          entityId,
          bookId,
          fromPeriodId,
          toPeriodId,
        },
      },
      update: { absoluteThreshold: "7500.00" as never },
      create: {
        tenantId,
        entityId,
        bookId,
        fromPeriodId,
        toPeriodId,
        absoluteThreshold: "7500.00" as never,
        percentThreshold: "12.00" as never,
      },
      select: { id: true, absoluteThreshold: true },
    });
    expect(upserted.id).toBe(createdStatements[0]);
    expect(upserted.absoluteThreshold.toString()).toBe("7500");
  });
});

describe("FluxLine schema — Phase 3 PR 1", () => {
  it("stores frozen snapshots + cascade-deletes when the statement is removed", async () => {
    const stmt = await prisma.fluxStatement.findUnique({
      where: { id: createdStatements[0] },
      select: { id: true },
    });
    if (!stmt) throw new Error("missing parent");

    const line = await prisma.fluxLine.create({
      data: {
        tenantId,
        statementId: stmt.id,
        accountId,
        priorAmount: "1000.00" as never,
        currentAmount: "1500.00" as never,
        deltaAmount: "500.00" as never,
        deltaPercent: "50.00" as never,
        status: "EXPLAINED",
        commentary: "Marketing spend ramp for Q4 launch",
      },
      select: {
        id: true,
        status: true,
        priorAmount: true,
        currentAmount: true,
        deltaAmount: true,
        deltaPercent: true,
        commentary: true,
      },
    });
    expect(line.status).toBe("EXPLAINED");
    expect(line.priorAmount.toString()).toBe("1000");
    expect(line.currentAmount.toString()).toBe("1500");
    expect(line.deltaAmount.toString()).toBe("500");
    expect(line.deltaPercent?.toString()).toBe("50");
    expect(line.commentary).toBe("Marketing spend ramp for Q4 launch");

    // Sanity check the cascade: deleting the parent statement removes
    // its lines without a manual deleteMany.
    const beforeCount = await prisma.fluxLine.count({
      where: { statementId: stmt.id },
    });
    expect(beforeCount).toBe(1);
    await prisma.fluxStatement.delete({ where: { id: stmt.id } });
    const afterCount = await prisma.fluxLine.count({
      where: { statementId: stmt.id },
    });
    expect(afterCount).toBe(0);
    // Drop from cleanup list since it's gone.
    createdStatements.shift();
  });

  it("allows deltaPercent NULL for the division-by-zero (new-account) case", async () => {
    const stmt = await prisma.fluxStatement.create({
      data: {
        tenantId,
        entityId,
        bookId,
        fromPeriodId,
        toPeriodId,
        absoluteThreshold: "0" as never,
        percentThreshold: "0" as never,
      },
      select: { id: true },
    });
    createdStatements.push(stmt.id);

    // priorAmount = 0 → no percent computable. The line still exists;
    // status is whatever the resolver decides (PR 2). Here we just
    // pin that the column accepts NULL on insert.
    const line = await prisma.fluxLine.create({
      data: {
        tenantId,
        statementId: stmt.id,
        accountId,
        priorAmount: "0" as never,
        currentAmount: "1234.56" as never,
        deltaAmount: "1234.56" as never,
        deltaPercent: null,
        status: "NEEDS_COMMENT",
      },
      select: { deltaPercent: true, status: true },
    });
    expect(line.deltaPercent).toBeNull();
    expect(line.status).toBe("NEEDS_COMMENT");
  });

  it("blocks duplicate (statementId, accountId) lines", async () => {
    const stmt = await prisma.fluxStatement.findFirst({
      where: { id: { in: createdStatements } },
      select: { id: true },
    });
    if (!stmt) throw new Error("missing parent");
    await expect(
      prisma.fluxLine.create({
        data: {
          tenantId,
          statementId: stmt.id,
          accountId,
          priorAmount: "0" as never,
          currentAmount: "999" as never,
          deltaAmount: "999" as never,
        },
      })
    ).rejects.toThrow(/unique/i);
  });
});
