// Commodity trade posting — the integration between the ledger and lots
// (Beancount adoption item 4, part 3).
//
// Two domain commands, each ATOMIC (JE + lot change in one transaction):
//   - recordCommodityPurchase: post Dr Investment / Cr Cash AND open a lot.
//   - recordCommoditySale:      draw lots down by booking method, post the
//                               proceeds / cost-relieved / realized-gain JE, and
//                               close the depleted lots.
//
// Both post through postJournalEntry — the single write path is NOT modified,
// only called, so its every guarantee (balance, account validity, period close)
// still holds. The realized-gain lines are composed here; if the composition is
// ever wrong, postJournalEntry's debits==credits invariant rejects it.
//
// These are domain commands, not Server Actions: nothing user-facing calls them
// yet. The gated Server Action (auth + auditPrivilegedAction + the human-approval
// gate) is part 4. Until then this code is unreachable in production — inert by
// construction.
//
// v1 concurrency note: the sale reads open lots, plans the reduction, then
// writes — all in one transaction, so it is atomic, but it does not lock the
// lot rows. Two truly-concurrent sales of the same holding could over-draw.
// Acceptable for the single-writer personal-books case; row locking is a
// hardening follow-up.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "./post-journal";
import { bookReduction, type BookingMethod, type Consumption } from "./inventory";
import { augmentLot, getOpenLots, consumeLots } from "./lots";
import { withTenantContext } from "../tenant-context";
import type { DbClient } from "../db";

const DEFAULT_BOOK = "US_GAAP";

export interface CommodityTradeScope {
  tenantId: string;
  entityCode: string;
  bookCode?: string;
}

export class UnknownTradeReferenceError extends Error {
  constructor(kind: string, code: string) {
    super(`Unknown ${kind} "${code}" in this tenant/entity`);
    this.name = "UnknownTradeReferenceError";
  }
}

interface ResolvedTrade {
  entityId: string;
  bookId: string;
  commodityId: string;
  investmentAccountId: string;
}

// Resolve the ids the lot layer needs. postJournalEntry resolves account CODES
// itself for the JE; we additionally need the investment account's id + the
// commodity id for the lot. Entity-specific accounts win over shared
// (entityId=null), matching postJournalEntry's dedup.
async function resolveTrade(
  tx: DbClient,
  scope: CommodityTradeScope,
  bookCode: string,
  commoditySymbol: string,
  investmentAccountCode: string
): Promise<ResolvedTrade> {
  const entity = await tx.legalEntity.findFirst({
    where: { code: scope.entityCode, tenantId: scope.tenantId },
    select: { id: true },
  });
  if (!entity) throw new UnknownTradeReferenceError("entity", scope.entityCode);

  const book = await tx.book.findUnique({ where: { code: bookCode }, select: { id: true } });
  if (!book) throw new UnknownTradeReferenceError("book", bookCode);

  const commodity = await tx.commodity.findFirst({
    where: { tenantId: scope.tenantId, symbol: commoditySymbol },
    select: { id: true },
  });
  if (!commodity) throw new UnknownTradeReferenceError("commodity", commoditySymbol);

  const cands = await tx.account.findMany({
    where: {
      code: investmentAccountCode,
      tenantId: scope.tenantId,
      active: true,
      OR: [{ entityId: entity.id }, { entityId: null }],
    },
    select: { id: true, entityId: true },
  });
  const inv = cands.find((a) => a.entityId === entity.id) ?? cands.find((a) => a.entityId === null);
  if (!inv) throw new UnknownTradeReferenceError("investment account", investmentAccountCode);

  return { entityId: entity.id, bookId: book.id, commodityId: commodity.id, investmentAccountId: inv.id };
}

export interface RecordPurchaseInput {
  commoditySymbol: string;
  units: Decimal | string | number;
  /** Purchase price per unit, in currencyCode. */
  unitCost: Decimal | string | number;
  currencyCode: string;
  tradeDate: Date;
  /** Asset account the security is held in (debited). */
  investmentAccountCode: string;
  /** Account the money came from (credited) — cash / clearing. */
  cashAccountCode: string;
  label?: string;
  createdBy?: string;
  ownerUserId?: string;
}

export interface RecordPurchaseResult {
  entryId: string;
  entryNumber: string;
  lotId: string;
}

/** Buy: Dr Investment (units*cost) / Cr Cash, and open the lot — atomic. */
export async function recordCommodityPurchase(
  prisma: PrismaClient,
  scope: CommodityTradeScope,
  input: RecordPurchaseInput
): Promise<RecordPurchaseResult> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;
  const units = new Decimal(input.units);
  const unitCost = new Decimal(input.unitCost);
  if (units.lessThanOrEqualTo(0)) throw new Error("Purchase units must be positive.");
  if (unitCost.isNegative()) throw new Error("Purchase unit cost must be non-negative.");
  const cost = units.times(unitCost);

  return withTenantContext(prisma, scope.tenantId, async (tx) => {
    const r = await resolveTrade(
      tx,
      scope,
      bookCode,
      input.commoditySymbol,
      input.investmentAccountCode
    );

    const entry = await postJournalEntry(tx, {
      tenantId: scope.tenantId,
      entityCode: scope.entityCode,
      bookCode,
      currencyCode: input.currencyCode,
      documentDate: input.tradeDate,
      memo: `Buy ${units.toString()} ${input.commoditySymbol} @ ${unitCost.toFixed(2)}`,
      source: "SYSTEM",
      createdBy: input.createdBy,
      ownerUserId: input.ownerUserId,
      lines: [
        { accountCode: input.investmentAccountCode, debit: cost.toString(), description: `Buy ${input.commoditySymbol}` },
        { accountCode: input.cashAccountCode, credit: cost.toString(), description: "Cash out" },
      ],
    });

    const lot = await augmentLot(tx, {
      tenantId: scope.tenantId,
      entityId: r.entityId,
      bookId: r.bookId,
      accountId: r.investmentAccountId,
      commodityId: r.commodityId,
      units,
      unitCost,
      costCurrencyId: input.currencyCode,
      acquisitionDate: input.tradeDate,
      label: input.label,
      openedByEntryId: entry.id,
      sourceSystem: "SUBSTRATE",
      sourceRecordType: "Commodity.purchase",
      sourceRecordId: entry.id,
    });

    return { entryId: entry.id, entryNumber: entry.entryNumber, lotId: lot.id };
  });
}

export interface RecordSaleInput {
  commoditySymbol: string;
  units: Decimal | string | number;
  /** Sale price per unit. */
  salePrice: Decimal | string | number;
  currencyCode: string;
  tradeDate: Date;
  investmentAccountCode: string;
  cashAccountCode: string;
  /** Realized gain lands here (credited) when proceeds exceed cost. */
  gainAccountCode: string;
  /** Realized loss lands here (debited) when cost exceeds proceeds. */
  lossAccountCode: string;
  method: BookingMethod;
  /** STRICT lot selection. */
  lotId?: string;
  createdBy?: string;
  ownerUserId?: string;
}

export interface RecordSaleResult {
  entryId: string;
  entryNumber: string;
  proceeds: Decimal;
  costRelieved: Decimal;
  realizedGain: Decimal;
  consumed: Consumption[];
}

/**
 * Sell: draw lots down by booking method and post the disposal JE.
 *   Dr Cash        proceeds (units * salePrice)
 *   Cr Investment  cost relieved (from the lots consumed)
 *   Cr Gain        realized gain   (when proceeds > cost)   OR
 *   Dr Loss        realized loss   (when cost > proceeds)
 * All atomic with the lot consumption. Capital gain is driven by cost BASIS,
 * not price — the lots supply the basis, the sale price supplies proceeds.
 */
export async function recordCommoditySale(
  prisma: PrismaClient,
  scope: CommodityTradeScope,
  input: RecordSaleInput
): Promise<RecordSaleResult> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;
  const units = new Decimal(input.units);
  const salePrice = new Decimal(input.salePrice);
  if (units.lessThanOrEqualTo(0)) throw new Error("Sale units must be positive.");
  if (salePrice.isNegative()) throw new Error("Sale price must be non-negative.");

  return withTenantContext(prisma, scope.tenantId, async (tx) => {
    const r = await resolveTrade(
      tx,
      scope,
      bookCode,
      input.commoditySymbol,
      input.investmentAccountCode
    );

    // Plan the reduction against the persisted open lots. bookReduction throws
    // InsufficientUnitsError / AmbiguousLotError, which propagate — the whole
    // transaction rolls back and nothing is posted or consumed.
    const openLots = await getOpenLots(tx, {
      tenantId: scope.tenantId,
      entityId: r.entityId,
      bookId: r.bookId,
      accountId: r.investmentAccountId,
      commodityId: r.commodityId,
    });
    const plan = bookReduction(openLots, units, input.method, {
      reductionPrice: salePrice,
      lotId: input.lotId,
    });
    const proceeds = plan.proceeds!; // reductionPrice was supplied, so non-null
    const realizedGain = plan.realizedGain!;
    const costRelieved = plan.costRelieved;

    // Compose the disposal lines. Proceeds always == costRelieved + gain, so
    // the entry balances by construction (and postJournalEntry re-checks).
    const lines: {
      accountCode: string;
      debit?: string;
      credit?: string;
      description?: string;
    }[] = [
      { accountCode: input.cashAccountCode, debit: proceeds.toString(), description: "Sale proceeds" },
      { accountCode: input.investmentAccountCode, credit: costRelieved.toString(), description: `Sell ${input.commoditySymbol} (cost basis)` },
    ];
    if (realizedGain.greaterThan(0)) {
      lines.push({ accountCode: input.gainAccountCode, credit: realizedGain.toString(), description: "Realized gain" });
    } else if (realizedGain.lessThan(0)) {
      lines.push({ accountCode: input.lossAccountCode, debit: realizedGain.abs().toString(), description: "Realized loss" });
    }

    const entry = await postJournalEntry(tx, {
      tenantId: scope.tenantId,
      entityCode: scope.entityCode,
      bookCode,
      currencyCode: input.currencyCode,
      documentDate: input.tradeDate,
      memo: `Sell ${units.toString()} ${input.commoditySymbol} @ ${salePrice.toFixed(2)}`,
      source: "SYSTEM",
      createdBy: input.createdBy,
      ownerUserId: input.ownerUserId,
      sourceSystem: "SUBSTRATE",
      sourceRecordType: "Commodity.sale",
      lines,
    });

    await consumeLots(tx, plan.consumed);

    return {
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      proceeds,
      costRelieved,
      realizedGain,
      consumed: plan.consumed,
    };
  });
}
