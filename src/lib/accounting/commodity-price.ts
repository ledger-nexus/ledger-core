// Commodity price database — record and resolve prices for tradeable
// instruments that are not currencies (stocks, ETFs, crypto).
//
// FxRate covers currency->currency; this covers commodity->currency. Resolution
// is on-or-before, the same convention as resolveFxRate (the FX engine): the
// most recent price dated on or before the target date. This is the seam that
// mark-to-market / holdings valuation and per-commodity balance assertions can
// build on; nothing here posts to the ledger.
//
// Tenant-scoped throughout — a commodity and its prices belong to a tenant
// (master data, like Item / Party), so every lookup pins tenantId.

import type { DbClient } from "../db";
import { Decimal } from "decimal.js";

export interface ResolvedCommodityPrice {
  price: Decimal;
  currencyId: string;
  /** The date of the price row actually used (may predate the request). */
  asOf: Date;
  /** The date that was asked for. */
  requestedAsOf: Date;
}

/**
 * Resolve a commodity's price in a currency, on or before `asOf`.
 *
 * Returns null when the commodity is unknown in this tenant, or when it has no
 * price in that currency on or before the date. Never throws for "no price" —
 * absence is a normal answer a caller decides how to handle (e.g. leave a
 * holding unvalued rather than guess).
 */
export async function getCommodityPrice(
  db: DbClient,
  args: { tenantId: string; commoditySymbol: string; currencyCode: string; asOf: Date }
): Promise<ResolvedCommodityPrice | null> {
  const commodity = await db.commodity.findFirst({
    where: { tenantId: args.tenantId, symbol: args.commoditySymbol },
    select: { id: true },
  });
  if (!commodity) return null;

  const row = await db.commodityPrice.findFirst({
    where: {
      tenantId: args.tenantId,
      commodityId: commodity.id,
      currencyId: args.currencyCode,
      asOf: { lte: args.asOf },
    },
    orderBy: { asOf: "desc" },
    select: { price: true, currencyId: true, asOf: true },
  });
  if (!row) return null;

  return {
    price: new Decimal(row.price.toString()),
    currencyId: row.currencyId,
    asOf: row.asOf,
    requestedAsOf: args.asOf,
  };
}

/**
 * Record (upsert) a price point. Last write for a given
 * (commodity, currency, date) wins — matching Beancount's rule that the last
 * price declaration on a day is the one retained.
 */
export async function recordCommodityPrice(
  db: DbClient,
  args: {
    tenantId: string;
    commodityId: string;
    currencyCode: string;
    asOf: Date;
    price: Decimal | string | number;
    source?: string;
  }
): Promise<void> {
  const price = new Decimal(args.price).toString();
  await db.commodityPrice.upsert({
    where: {
      commodityId_currencyId_asOf: {
        commodityId: args.commodityId,
        currencyId: args.currencyCode,
        asOf: args.asOf,
      },
    },
    create: {
      tenantId: args.tenantId,
      commodityId: args.commodityId,
      currencyId: args.currencyCode,
      asOf: args.asOf,
      price,
      source: args.source,
    },
    update: { price, source: args.source },
  });
}
