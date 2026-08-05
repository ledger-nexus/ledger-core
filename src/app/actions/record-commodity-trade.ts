"use server";

// Record a securities trade — the gated entry point to the lots machinery.
//
// The posting itself lives in src/lib/accounting/commodity-trade.ts (domain
// commands). This action is the CONTROL around it, and is the reason those
// commands were left unreachable until now:
//
//   - authenticates (requireCurrentUser) and resolves the tenant-verified
//     (entity, book) from the session — never from client input;
//   - runs the trade through postJournalEntry via the domain command, so the
//     substrate's balance / account / period-close guarantees apply;
//   - writes a privileged-action audit row naming who traded what.
//
// "AI suggests, humans approve, the system posts": a trade only happens because
// a signed-in human invoked this action. Nothing auto-trades.

import { revalidatePath } from "next/cache";
import { Decimal } from "@/lib/utils/decimal";
import {
  recordCommodityPurchase,
  recordCommoditySale,
  UnknownTradeReferenceError,
} from "@/lib/accounting/commodity-trade";
import type { BookingMethod } from "@/lib/accounting/inventory";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { requireCurrentScope, NoScopeError } from "@/lib/scope";
import { auditPrivilegedAction, auditAccessDenied } from "@/lib/audit/log";
import { prisma } from "@/lib/db";

export interface RecordCommodityTradeInput {
  side: "BUY" | "SELL";
  commoditySymbol: string;
  units: string;
  /** Per-unit price: the purchase cost on a BUY, the sale price on a SELL. */
  price: string;
  currencyCode: string;
  /** ISO YYYY-MM-DD. */
  tradeDate: string;
  investmentAccountCode: string;
  cashAccountCode: string;
  /** SELL only — where realized gain / loss lands. */
  gainAccountCode?: string;
  lossAccountCode?: string;
  /** SELL only — how lots are drawn down. Defaults to FIFO. */
  method?: BookingMethod;
  /** SELL only — STRICT lot selection. */
  lotId?: string;
  label?: string;
}

export interface RecordCommodityTradeState {
  ok: boolean;
  message?: string;
  entryId?: string;
  entryNumber?: string;
  /** BUY only. */
  lotId?: string;
  /** SELL only, as a fixed-2 string for display. */
  realizedGain?: string;
}

export async function recordCommodityTradeAction(
  input: RecordCommodityTradeInput
): Promise<RecordCommodityTradeState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    await auditAccessDenied({
      attemptedAction: "record-commodity-trade",
      reason: "Not authenticated",
      resource: "Commodity",
      resourceId: input.commoditySymbol,
    });
    return { ok: false, message: "You must be signed in." };
  }

  let scope;
  try {
    scope = await requireCurrentScope();
  } catch {
    return { ok: false, message: "No active scope — pick an entity + book first." };
  }

  const symbol = input.commoditySymbol?.trim();
  if (!symbol) return { ok: false, message: "A commodity symbol is required." };
  if (!input.investmentAccountCode?.trim() || !input.cashAccountCode?.trim()) {
    return { ok: false, message: "Investment and cash account codes are required." };
  }

  let units: Decimal;
  let price: Decimal;
  try {
    units = new Decimal(input.units);
    price = new Decimal(input.price);
  } catch {
    return { ok: false, message: "Units and price must be valid numbers." };
  }
  if (!units.isFinite() || units.lessThanOrEqualTo(0)) {
    return { ok: false, message: "Units must be positive." };
  }
  if (!price.isFinite() || price.isNegative()) {
    return { ok: false, message: "Price must be non-negative." };
  }

  const tradeDate = new Date(input.tradeDate);
  if (isNaN(tradeDate.getTime())) {
    return { ok: false, message: "tradeDate must be a valid date (YYYY-MM-DD)." };
  }

  const tradeScope = {
    tenantId: scope.tenantId,
    entityCode: scope.entityCode,
    bookCode: scope.bookCode,
  };

  try {
    if (input.side === "BUY") {
      const r = await recordCommodityPurchase(prisma, tradeScope, {
        commoditySymbol: symbol,
        units,
        unitCost: price,
        currencyCode: input.currencyCode,
        tradeDate,
        investmentAccountCode: input.investmentAccountCode,
        cashAccountCode: input.cashAccountCode,
        label: input.label,
        createdBy: user.email,
        ownerUserId: user.id,
      });

      await auditPrivilegedAction({
        actor: user,
        action: "record-commodity-trade",
        resource: "Commodity",
        resourceId: symbol,
        tenantId: scope.tenantId,
        metadata: {
          side: "BUY",
          units: units.toString(),
          unitCost: price.toFixed(2),
          entryNumber: r.entryNumber,
          lotId: r.lotId,
        },
      });

      revalidatePath("/holdings");
      revalidatePath("/journal-entries");
      return {
        ok: true,
        entryId: r.entryId,
        entryNumber: r.entryNumber,
        lotId: r.lotId,
        message: `Bought ${units.toString()} ${symbol} → ${r.entryNumber}.`,
      };
    }

    // SELL — the gain/loss accounts are required because a disposal must have
    // somewhere to put the realized result.
    if (!input.gainAccountCode?.trim() || !input.lossAccountCode?.trim()) {
      return { ok: false, message: "Gain and loss account codes are required to sell." };
    }
    const r = await recordCommoditySale(prisma, tradeScope, {
      commoditySymbol: symbol,
      units,
      salePrice: price,
      currencyCode: input.currencyCode,
      tradeDate,
      investmentAccountCode: input.investmentAccountCode,
      cashAccountCode: input.cashAccountCode,
      gainAccountCode: input.gainAccountCode,
      lossAccountCode: input.lossAccountCode,
      method: input.method ?? "FIFO",
      lotId: input.lotId,
      createdBy: user.email,
      ownerUserId: user.id,
    });

    await auditPrivilegedAction({
      actor: user,
      action: "record-commodity-trade",
      resource: "Commodity",
      resourceId: symbol,
      tenantId: scope.tenantId,
      metadata: {
        side: "SELL",
        units: units.toString(),
        salePrice: price.toFixed(2),
        method: input.method ?? "FIFO",
        proceeds: r.proceeds.toFixed(2),
        costRelieved: r.costRelieved.toFixed(2),
        realizedGain: r.realizedGain.toFixed(2),
        lotsConsumed: r.consumed.length,
        entryNumber: r.entryNumber,
      },
    });

    revalidatePath("/holdings");
    revalidatePath("/journal-entries");
    return {
      ok: true,
      entryId: r.entryId,
      entryNumber: r.entryNumber,
      realizedGain: r.realizedGain.toFixed(2),
      message: `Sold ${units.toString()} ${symbol} → ${r.entryNumber} (realized ${r.realizedGain.toFixed(2)}).`,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in." };
    }
    if (e instanceof NoScopeError) {
      return { ok: false, message: "No active scope — pick an entity + book first." };
    }
    // Insufficient units, ambiguous STRICT lot, unknown account/commodity,
    // closed period, unbalanced — all surface with their own message. The
    // transaction rolled back, so nothing was posted.
    if (e instanceof UnknownTradeReferenceError) {
      return { ok: false, message: e.message };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error recording the trade.",
    };
  }
}
