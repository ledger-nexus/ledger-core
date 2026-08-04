// Commodity trade posting — buy opens a lot, sell draws lots down and posts the
// realized-gain JE, all atomic. This is the accounting proof for part 3.
//
// Accounts: INVEST (asset), CASH (asset), GAIN (revenue), LOSS (expense).
// AAPL is bought in two lots (10 @ 100, 10 @ 120), then sold.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  recordCommodityPurchase,
  recordCommoditySale,
} from "@/lib/accounting/commodity-trade";
import { InsufficientUnitsError } from "@/lib/accounting/inventory";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("TRD" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `TRD-${SUFFIX}`;

let tenantId: string;
let userId: string;
let entityId: string;

const scope = () => ({ tenantId, entityCode: ENTITY_CODE, bookCode: "US_GAAP" });

async function linesOf(entryId: string) {
  const e = await prisma.journalEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: { lines: { include: { account: { select: { code: true } } }, orderBy: { lineNo: "asc" } } },
  });
  return e.lines.map((l) => ({ code: l.account.code, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2) }));
}

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });

  const u = await prisma.user.create({
    data: { email: `trd-${SUFFIX}@example.test`, displayName: "Trade tester", isActive: true },
  });
  userId = u.id;
  const tenant = await prisma.tenant.create({
    data: { slug: `trd-${SUFFIX.toLowerCase()}`, name: "Trade tenant", ownerUserId: u.id },
  });
  tenantId = tenant.id;
  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY_CODE, name: "Trade Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;

  await prisma.account.createMany({
    data: [
      { tenantId, entityId, code: "INVEST", name: "Investments", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId, entityId, code: "CASH", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId, entityId, code: "GAIN", name: "Realized gain", type: "REVENUE", normalBalance: "CREDIT" },
      { tenantId, entityId, code: "LOSS", name: "Realized loss", type: "EXPENSE", normalBalance: "DEBIT" },
    ],
  });
  await prisma.commodity.create({ data: { tenantId, symbol: "AAPL", name: "Apple Inc.", assetClass: "EQUITY" } });
});

afterAll(async () => {
  await prisma.lot.deleteMany({ where: { tenantId } });
  await prisma.commodity.deleteMany({ where: { tenantId } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({ where: { OR: [{ tenantId }, { actorUserId: userId }] } });
    await tx.tenant.delete({ where: { id: tenantId } });
    await tx.user.delete({ where: { id: userId } });
  });
  await prisma.$disconnect();
});

async function buy(units: string, unitCost: string, date: string) {
  return recordCommodityPurchase(prisma, scope(), {
    commoditySymbol: "AAPL",
    units,
    unitCost,
    currencyCode: "USD",
    tradeDate: new Date(date),
    investmentAccountCode: "INVEST",
    cashAccountCode: "CASH",
  });
}

describe("recordCommodityPurchase", () => {
  it("posts Dr Investment / Cr Cash and opens a lot linked to that JE", async () => {
    const r = await buy("10", "100", "2026-01-01");
    expect(await linesOf(r.entryId)).toEqual([
      { code: "INVEST", debit: "1000.00", credit: "0.00" },
      { code: "CASH", debit: "0.00", credit: "1000.00" },
    ]);
    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: r.lotId } });
    expect(lot.status).toBe("OPEN");
    expect(lot.remainingUnits.toFixed(0)).toBe("10");
    expect(lot.unitCost.toFixed(0)).toBe("100");
    expect(lot.openedByEntryId).toBe(r.entryId); // lot is tied to its purchase JE
  });
});

describe("recordCommoditySale", () => {
  it("FIFO sale at a gain: Dr Cash / Cr Investment(cost) / Cr Gain, and draws the lots down", async () => {
    await buy("10", "120", "2026-02-01"); // second lot

    const r = await recordCommoditySale(prisma, scope(), {
      commoditySymbol: "AAPL",
      units: "15",
      salePrice: "130",
      currencyCode: "USD",
      tradeDate: new Date("2026-03-01"),
      investmentAccountCode: "INVEST",
      cashAccountCode: "CASH",
      gainAccountCode: "GAIN",
      lossAccountCode: "LOSS",
      method: "FIFO",
    });

    // 10 @100 + 5 @120 => cost 1600, proceeds 1950, gain 350.
    expect(r.costRelieved.toFixed(2)).toBe("1600.00");
    expect(r.proceeds.toFixed(2)).toBe("1950.00");
    expect(r.realizedGain.toFixed(2)).toBe("350.00");
    expect(await linesOf(r.entryId)).toEqual([
      { code: "CASH", debit: "1950.00", credit: "0.00" },
      { code: "INVEST", debit: "0.00", credit: "1600.00" },
      { code: "GAIN", debit: "0.00", credit: "350.00" },
    ]);

    // First lot CLOSED, second lot has 5 left.
    const open = await prisma.lot.findMany({ where: { tenantId, status: "OPEN" }, select: { remainingUnits: true, unitCost: true } });
    expect(open).toHaveLength(1);
    expect(open[0].unitCost.toFixed(0)).toBe("120");
    expect(open[0].remainingUnits.toFixed(0)).toBe("5");
  });

  it("sale at a loss debits the loss account", async () => {
    // 5 remain @120. Sell 5 @ 100 -> cost 600, proceeds 500, loss 100.
    const r = await recordCommoditySale(prisma, scope(), {
      commoditySymbol: "AAPL",
      units: "5",
      salePrice: "100",
      currencyCode: "USD",
      tradeDate: new Date("2026-03-02"),
      investmentAccountCode: "INVEST",
      cashAccountCode: "CASH",
      gainAccountCode: "GAIN",
      lossAccountCode: "LOSS",
      method: "FIFO",
    });
    expect(r.realizedGain.toFixed(2)).toBe("-100.00");
    expect(await linesOf(r.entryId)).toEqual([
      { code: "CASH", debit: "500.00", credit: "0.00" },
      { code: "INVEST", debit: "0.00", credit: "600.00" },
      { code: "LOSS", debit: "100.00", credit: "0.00" },
    ]);
    // Position fully closed.
    expect(await prisma.lot.count({ where: { tenantId, status: "OPEN" } })).toBe(0);
  });

  it("rolls back atomically when the sale exceeds the holding — no JE, no lot change", async () => {
    // Re-buy a single lot so there is something (but not enough) to sell.
    const purchase = await buy("3", "50", "2026-04-01");
    const jeBefore = await prisma.journalEntry.count({ where: { entityId } });

    await expect(
      recordCommoditySale(prisma, scope(), {
        commoditySymbol: "AAPL",
        units: "10", // only 3 held
        salePrice: "60",
        currencyCode: "USD",
        tradeDate: new Date("2026-04-02"),
        investmentAccountCode: "INVEST",
        cashAccountCode: "CASH",
        gainAccountCode: "GAIN",
        lossAccountCode: "LOSS",
        method: "FIFO",
      })
    ).rejects.toBeInstanceOf(InsufficientUnitsError);

    // Nothing posted, and the lot is untouched — the transaction rolled back.
    expect(await prisma.journalEntry.count({ where: { entityId } })).toBe(jeBefore);
    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: purchase.lotId } });
    expect(lot.remainingUnits.toFixed(0)).toBe("3");
    expect(lot.status).toBe("OPEN");
  });
});
