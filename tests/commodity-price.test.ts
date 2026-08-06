// Commodity price DB — record + on-or-before resolution.
//
// No entity/book/account fixtures: a commodity and its prices are standalone
// tenant master data. AAPL is priced in USD across two dates; EUR is left
// unpriced to prove currency specificity.
//
// Verified:
//   - resolve on the exact date of a price
//   - on-or-before: a date between two prices returns the earlier one; on/after
//     the later price returns the later one
//   - a date before any price -> null
//   - unknown commodity symbol -> null
//   - a currency with no price -> null (even though the commodity has others)
//   - upsert: recording the same (commodity, currency, date) twice keeps the
//     last value
//   - tenant isolation: another tenant resolves nothing

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { getCommodityPrice, recordCommodityPrice } from "@/lib/accounting/commodity-price";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("CMDTY" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();

let tenantId: string;
let userId: string;
let commodityId: string;

beforeAll(async () => {
  for (const c of [
    { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    { code: "EUR", name: "Euro", decimals: 2, symbol: "€" },
  ]) {
    await prisma.currency.upsert({ where: { code: c.code }, create: c, update: {} });
  }

  const u = await prisma.user.create({
    data: { email: `cmdty-${SUFFIX}@example.test`, displayName: "Commodity tester", isActive: true },
  });
  userId = u.id;

  const tenant = await prisma.tenant.create({
    data: { slug: `cmdty-${SUFFIX.toLowerCase()}`, name: "Commodity tenant", ownerUserId: u.id },
  });
  tenantId = tenant.id;

  const commodity = await prisma.commodity.create({
    data: { tenantId, symbol: "AAPL", name: "Apple Inc.", assetClass: "EQUITY" },
  });
  commodityId = commodity.id;

  // Two USD prices; EUR intentionally unpriced.
  await recordCommodityPrice(prisma, {
    tenantId, commodityId, currencyCode: "USD", asOf: new Date("2026-01-01"), price: "180.00", source: "MANUAL",
  });
  await recordCommodityPrice(prisma, {
    tenantId, commodityId, currencyCode: "USD", asOf: new Date("2026-02-01"), price: "195.50", source: "MANUAL",
  });
});

afterAll(async () => {
  await prisma.commodityPrice.deleteMany({ where: { tenantId } });
  await prisma.commodity.deleteMany({ where: { tenantId } });
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({ where: { OR: [{ tenantId }, { actorUserId: userId }] } });
    await tx.tenant.delete({ where: { id: tenantId } });
    await tx.user.delete({ where: { id: userId } });
  });
  await prisma.$disconnect();
});

describe("getCommodityPrice — on-or-before resolution", () => {
  it("resolves the price on its exact date", async () => {
    const r = await getCommodityPrice(prisma, {
      tenantId, commoditySymbol: "AAPL", currencyCode: "USD", asOf: new Date("2026-01-01"),
    });
    expect(r).not.toBeNull();
    expect(r!.price.toFixed(2)).toBe("180.00");
    expect(r!.asOf.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("returns the EARLIER price for a date between two prices", async () => {
    const r = await getCommodityPrice(prisma, {
      tenantId, commoditySymbol: "AAPL", currencyCode: "USD", asOf: new Date("2026-01-15"),
    });
    expect(r!.price.toFixed(2)).toBe("180.00");
    // The effective date is the price's date, not the request.
    expect(r!.asOf.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(r!.requestedAsOf.toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("returns the later price on and after its date", async () => {
    const onDate = await getCommodityPrice(prisma, {
      tenantId, commoditySymbol: "AAPL", currencyCode: "USD", asOf: new Date("2026-02-01"),
    });
    expect(onDate!.price.toFixed(2)).toBe("195.50");
    const after = await getCommodityPrice(prisma, {
      tenantId, commoditySymbol: "AAPL", currencyCode: "USD", asOf: new Date("2026-06-30"),
    });
    expect(after!.price.toFixed(2)).toBe("195.50");
  });

  it("returns null for a date before any price exists", async () => {
    const r = await getCommodityPrice(prisma, {
      tenantId, commoditySymbol: "AAPL", currencyCode: "USD", asOf: new Date("2025-12-31"),
    });
    expect(r).toBeNull();
  });

  it("returns null for an unknown commodity", async () => {
    const r = await getCommodityPrice(prisma, {
      tenantId, commoditySymbol: "NOPE", currencyCode: "USD", asOf: new Date("2026-06-30"),
    });
    expect(r).toBeNull();
  });

  it("is currency-specific — a currency with no price resolves to null", async () => {
    const r = await getCommodityPrice(prisma, {
      tenantId, commoditySymbol: "AAPL", currencyCode: "EUR", asOf: new Date("2026-06-30"),
    });
    expect(r).toBeNull();
  });
});

describe("recordCommodityPrice — upsert", () => {
  it("keeps the last value for the same (commodity, currency, date)", async () => {
    await recordCommodityPrice(prisma, {
      tenantId, commodityId, currencyCode: "USD", asOf: new Date("2026-03-01"), price: "200.00",
    });
    await recordCommodityPrice(prisma, {
      tenantId, commodityId, currencyCode: "USD", asOf: new Date("2026-03-01"), price: new Decimal("201.25"),
    });
    const r = await getCommodityPrice(prisma, {
      tenantId, commoditySymbol: "AAPL", currencyCode: "USD", asOf: new Date("2026-03-01"),
    });
    expect(r!.price.toFixed(2)).toBe("201.25");
    // Still one row for that date, not two.
    const count = await prisma.commodityPrice.count({
      where: { tenantId, commodityId, currencyId: "USD", asOf: new Date("2026-03-01") },
    });
    expect(count).toBe(1);
  });
});

describe("getCommodityPrice — tenant isolation", () => {
  it("resolves nothing for another tenant", async () => {
    const r = await getCommodityPrice(prisma, {
      tenantId: "00000000-0000-0000-0000-000000000000",
      commoditySymbol: "AAPL",
      currencyCode: "USD",
      asOf: new Date("2026-06-30"),
    });
    expect(r).toBeNull();
  });
});
