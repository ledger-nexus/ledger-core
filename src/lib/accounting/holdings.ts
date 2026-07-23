// Holdings — what you actually own, derived from the OPEN lots.
//
// A holding is the roll-up of every open lot of one commodity in one account:
// units still held, the cost basis behind them, and (when a price exists) the
// mark-to-market value and unrealized gain. This is the read side of the lots
// arc — the disposal path (commodity-trade.ts) is the write side.
//
// Cost basis comes from the lots themselves, never from a price: two parcels of
// the same security bought at different prices keep their own basis, so the
// average cost here is the weighted average of what was actually paid.
// Unrealized gain is market value minus that basis, and is null when no price
// is on file — an unpriced holding is reported at cost rather than guessed at.

import type { DbClient } from "../db";
import { Decimal } from "decimal.js";
import { getCommodityPrice } from "./commodity-price";

const DEFAULT_BOOK = "US_GAAP";

export interface Holding {
  commoditySymbol: string;
  commodityName: string;
  accountCode: string;
  /** Units still held across all open lots. */
  units: Decimal;
  /** Σ remainingUnits × unitCost — the basis behind those units. */
  totalCost: Decimal;
  /** Weighted average of what was actually paid. */
  averageCost: Decimal;
  costCurrencyId: string;
  /** How many open parcels make up this position. */
  lotCount: number;
  /** Price used for the mark, or null when none is on file. */
  marketPrice: Decimal | null;
  marketValue: Decimal | null;
  /** marketValue − totalCost, or null when unpriced. */
  unrealizedGain: Decimal | null;
}

/**
 * Roll up open lots into holdings for one (entity, book).
 *
 * `asOf` bounds the price lookup (on-or-before, per getCommodityPrice); it does
 * NOT filter the lots themselves — a holding is what is open now.
 */
export async function getHoldings(
  db: DbClient,
  args: { tenantId: string; entityCode: string; bookCode?: string; asOf?: Date }
): Promise<Holding[]> {
  const bookCode = args.bookCode ?? DEFAULT_BOOK;

  // Tenant-pinned: entity codes are unique only per (tenantId, code).
  const entity = await db.legalEntity.findFirst({
    where: { code: args.entityCode, tenantId: args.tenantId },
    select: { id: true },
  });
  if (!entity) return [];
  const book = await db.book.findUnique({ where: { code: bookCode }, select: { id: true } });
  if (!book) return [];

  const lots = await db.lot.findMany({
    where: {
      tenantId: args.tenantId,
      entityId: entity.id,
      bookId: book.id,
      status: "OPEN",
    },
    select: {
      remainingUnits: true,
      unitCost: true,
      costCurrencyId: true,
      commodity: { select: { symbol: true, name: true } },
      account: { select: { code: true } },
    },
  });
  if (lots.length === 0) return [];

  // Group by (commodity, account, cost currency). Summing in JS with decimal.js
  // keeps the arithmetic exact and auditable, matching getTrialBalance.
  type Acc = {
    commoditySymbol: string;
    commodityName: string;
    accountCode: string;
    costCurrencyId: string;
    units: Decimal;
    totalCost: Decimal;
    lotCount: number;
  };
  const groups = new Map<string, Acc>();
  for (const l of lots) {
    const key = `${l.commodity.symbol}|${l.account.code}|${l.costCurrencyId}`;
    const units = new Decimal(l.remainingUnits.toString());
    const cost = units.times(new Decimal(l.unitCost.toString()));
    const g = groups.get(key);
    if (g) {
      g.units = g.units.plus(units);
      g.totalCost = g.totalCost.plus(cost);
      g.lotCount += 1;
    } else {
      groups.set(key, {
        commoditySymbol: l.commodity.symbol,
        commodityName: l.commodity.name,
        accountCode: l.account.code,
        costCurrencyId: l.costCurrencyId,
        units,
        totalCost: cost,
        lotCount: 1,
      });
    }
  }

  const asOf = args.asOf ?? new Date();
  const holdings: Holding[] = [];
  for (const g of groups.values()) {
    // Mark to market only if a price is actually on file. No price => report at
    // cost with nulls, never an invented mark.
    const priced = await getCommodityPrice(db, {
      tenantId: args.tenantId,
      commoditySymbol: g.commoditySymbol,
      currencyCode: g.costCurrencyId,
      asOf,
    });
    const marketPrice = priced?.price ?? null;
    const marketValue = marketPrice ? g.units.times(marketPrice) : null;
    holdings.push({
      commoditySymbol: g.commoditySymbol,
      commodityName: g.commodityName,
      accountCode: g.accountCode,
      units: g.units,
      totalCost: g.totalCost,
      averageCost: g.units.isZero() ? new Decimal(0) : g.totalCost.dividedBy(g.units),
      costCurrencyId: g.costCurrencyId,
      lotCount: g.lotCount,
      marketPrice,
      marketValue,
      unrealizedGain: marketValue ? marketValue.minus(g.totalCost) : null,
    });
  }

  holdings.sort((a, b) => a.commoditySymbol.localeCompare(b.commoditySymbol));
  return holdings;
}
