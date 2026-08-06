// Lot persistence — augment / read / consume, and the end-to-end proof that
// persistence composes with the pure booking engine.
//
// Fixture: an entity with an INVEST account and an AAPL commodity, no JEs (the
// lots are seeded directly — openedByEntryId is nullable until posting is
// wired). Two purchases: 10 @ $100 (Jan 1), 10 @ $120 (Feb 1).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { augmentLot, getOpenLots, consumeLots } from "@/lib/accounting/lots";
import { bookReduction } from "@/lib/accounting/inventory";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("LOT" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `LOT-${SUFFIX}`;

let tenantId: string;
let userId: string;
let entityId: string;
let bookId: string;
let accountId: string;
let commodityId: string;

async function seedLot(units: string, unitCost: string, date: string) {
  return augmentLot(prisma, {
    tenantId, entityId, bookId, accountId, commodityId,
    units, unitCost, costCurrencyId: "USD", acquisitionDate: new Date(date),
  });
}

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const book = await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });
  bookId = book.id;

  const u = await prisma.user.create({
    data: { email: `lot-${SUFFIX}@example.test`, displayName: "Lot tester", isActive: true },
  });
  userId = u.id;

  const tenant = await prisma.tenant.create({
    data: { slug: `lot-${SUFFIX.toLowerCase()}`, name: "Lot tenant", ownerUserId: u.id },
  });
  tenantId = tenant.id;

  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY_CODE, name: "Lot Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;

  const account = await prisma.account.create({
    data: { tenantId, entityId, code: "INVEST", name: "Investments", type: "ASSET", normalBalance: "DEBIT" },
  });
  accountId = account.id;

  const commodity = await prisma.commodity.create({
    data: { tenantId, symbol: "AAPL", name: "Apple Inc.", assetClass: "EQUITY" },
  });
  commodityId = commodity.id;
});

afterAll(async () => {
  await prisma.lot.deleteMany({ where: { tenantId } });
  await prisma.commodity.deleteMany({ where: { tenantId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({ where: { OR: [{ tenantId }, { actorUserId: userId }] } });
    await tx.tenant.delete({ where: { id: tenantId } });
    await tx.user.delete({ where: { id: userId } });
  });
  await prisma.$disconnect();
});

describe("augmentLot + getOpenLots", () => {
  it("creates an OPEN lot with remaining == original, and reads it back as an engine Lot", async () => {
    const { id } = await seedLot("10", "100", "2026-01-01");
    const row = await prisma.lot.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("OPEN");
    expect(row.originalUnits.toString()).toBe(row.remainingUnits.toString());

    const open = await getOpenLots(prisma, { tenantId, entityId, bookId, accountId, commodityId });
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(id);
    expect(open[0].units.toFixed(0)).toBe("10");
    expect(open[0].unitCost.toFixed(0)).toBe("100");
  });
});

describe("engine + persistence compose end-to-end", () => {
  it("augment two lots, FIFO-reduce via the engine, consume, and re-read the remainder", async () => {
    // Second lot (the first exists from the test above): 10 @ 120 on Feb 1.
    await seedLot("10", "120", "2026-02-01");

    // Sell 15 FIFO at 130. Draw the engine's plan from the persisted open lots.
    const openBefore = await getOpenLots(prisma, { tenantId, entityId, bookId, accountId, commodityId });
    expect(openBefore).toHaveLength(2);
    const result = bookReduction(openBefore, 15, "FIFO", { reductionPrice: 130 });
    // 10 from lot@100 + 5 from lot@120 => cost 1600, proceeds 1950, gain 350.
    expect(result.realizedGain!.toFixed(0)).toBe("350");

    // Apply the plan to persistence.
    await consumeLots(prisma, result.consumed);

    // The $100 lot is fully consumed (CLOSED), the $120 lot has 5 left.
    const openAfter = await getOpenLots(prisma, { tenantId, entityId, bookId, accountId, commodityId });
    expect(openAfter).toHaveLength(1);
    expect(openAfter[0].unitCost.toFixed(0)).toBe("120");
    expect(openAfter[0].units.toFixed(0)).toBe("5");

    // The consumed lot is CLOSED, not deleted (history preserved).
    const closed = await prisma.lot.count({ where: { tenantId, status: "CLOSED" } });
    expect(closed).toBe(1);
  });
});

describe("tenant isolation", () => {
  it("getOpenLots returns nothing for another tenant", async () => {
    const open = await getOpenLots(prisma, {
      tenantId: "00000000-0000-0000-0000-000000000000",
      entityId, bookId, accountId, commodityId,
    });
    expect(open).toHaveLength(0);
  });
});
