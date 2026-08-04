// Holdings roll-up — open lots aggregated per commodity, with mark-to-market
// only where a price exists.
//
// Fixture: AAPL in two lots (10 @ 100, 10 @ 120) and MSFT in one (5 @ 200).
// AAPL is priced at 130; MSFT is deliberately left UNPRICED so the "report at
// cost, never guess a mark" behaviour is covered.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getHoldings } from "@/lib/accounting/holdings";
import { augmentLot } from "@/lib/accounting/lots";
import { recordCommodityPrice } from "@/lib/accounting/commodity-price";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("HLD" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `HLD-${SUFFIX}`;

let tenantId: string;
let userId: string;
let entityId: string;
let bookId: string;
let accountId: string;
let aaplId: string;
let msftId: string;

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
    data: { email: `hld-${SUFFIX}@example.test`, displayName: "Holdings tester", isActive: true },
  });
  userId = u.id;
  const tenant = await prisma.tenant.create({
    data: { slug: `hld-${SUFFIX.toLowerCase()}`, name: "Holdings tenant", ownerUserId: u.id },
  });
  tenantId = tenant.id;
  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY_CODE, name: "Holdings Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;
  const account = await prisma.account.create({
    data: { tenantId, entityId, code: "INVEST", name: "Investments", type: "ASSET", normalBalance: "DEBIT" },
  });
  accountId = account.id;

  const aapl = await prisma.commodity.create({ data: { tenantId, symbol: "AAPL", name: "Apple Inc." } });
  const msft = await prisma.commodity.create({ data: { tenantId, symbol: "MSFT", name: "Microsoft Corp." } });
  aaplId = aapl.id;
  msftId = msft.id;

  const base = { tenantId, entityId, bookId, accountId, costCurrencyId: "USD" };
  await augmentLot(prisma, { ...base, commodityId: aaplId, units: "10", unitCost: "100", acquisitionDate: new Date("2026-01-01") });
  await augmentLot(prisma, { ...base, commodityId: aaplId, units: "10", unitCost: "120", acquisitionDate: new Date("2026-02-01") });
  await augmentLot(prisma, { ...base, commodityId: msftId, units: "5", unitCost: "200", acquisitionDate: new Date("2026-01-15") });

  // AAPL priced; MSFT intentionally left with no price.
  await recordCommodityPrice(prisma, {
    tenantId, commodityId: aaplId, currencyCode: "USD", asOf: new Date("2026-03-01"), price: "130",
  });
});

afterAll(async () => {
  await prisma.commodityPrice.deleteMany({ where: { tenantId } });
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

describe("getHoldings", () => {
  it("rolls lots up per commodity with weighted-average cost", async () => {
    const h = await getHoldings(prisma, { tenantId, entityCode: ENTITY_CODE, asOf: new Date("2026-06-30") });
    expect(h.map((x) => x.commoditySymbol)).toEqual(["AAPL", "MSFT"]); // sorted

    const aapl = h[0];
    expect(aapl.units.toFixed(0)).toBe("20");
    expect(aapl.totalCost.toFixed(0)).toBe("2200"); // 10*100 + 10*120
    expect(aapl.averageCost.toFixed(0)).toBe("110");
    expect(aapl.lotCount).toBe(2);
    expect(aapl.accountCode).toBe("INVEST");
  });

  it("marks to market where a price exists", async () => {
    const h = await getHoldings(prisma, { tenantId, entityCode: ENTITY_CODE, asOf: new Date("2026-06-30") });
    const aapl = h[0];
    expect(aapl.marketPrice!.toFixed(0)).toBe("130");
    expect(aapl.marketValue!.toFixed(0)).toBe("2600"); // 20 * 130
    expect(aapl.unrealizedGain!.toFixed(0)).toBe("400"); // 2600 - 2200
  });

  it("reports an unpriced holding at cost — no invented mark", async () => {
    const h = await getHoldings(prisma, { tenantId, entityCode: ENTITY_CODE, asOf: new Date("2026-06-30") });
    const msft = h[1];
    expect(msft.totalCost.toFixed(0)).toBe("1000");
    expect(msft.marketPrice).toBeNull();
    expect(msft.marketValue).toBeNull();
    expect(msft.unrealizedGain).toBeNull();
  });

  it("excludes CLOSED lots", async () => {
    await prisma.lot.updateMany({ where: { tenantId, commodityId: msftId }, data: { status: "CLOSED" } });
    const h = await getHoldings(prisma, { tenantId, entityCode: ENTITY_CODE });
    expect(h.map((x) => x.commoditySymbol)).toEqual(["AAPL"]);
    // restore for isolation between tests
    await prisma.lot.updateMany({ where: { tenantId, commodityId: msftId }, data: { status: "OPEN" } });
  });

  it("is tenant-scoped", async () => {
    const h = await getHoldings(prisma, {
      tenantId: "00000000-0000-0000-0000-000000000000",
      entityCode: ENTITY_CODE,
    });
    expect(h).toHaveLength(0);
  });
});
