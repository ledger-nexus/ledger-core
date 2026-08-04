"use server";

// Commodity master data + price entry.
//
// These are the two missing surfaces that made the whole commodity/lots arc
// unreachable from the app:
//
//   1. NOTHING created a Commodity row. `commodity-trade.ts` throws
//      UnknownTradeReferenceError when a symbol isn't on file — deliberately,
//      because the substrate does not invent master data — so the trade form
//      could only ever fail. Only tests had been creating commodities.
//
//   2. NOTHING recorded a price. /holdings already renders market value and
//      unrealized gain, so those columns simply always read "—".
//
// Commodity is tenant master data, like Party and Item: created explicitly,
// never auto-vivified on first use. A typo'd symbol should fail loudly rather
// than silently mint "APPL" alongside "AAPL" and split a position in two.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { Prisma } from "@prisma/client";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { auditPrivilegedAction, auditAccessDenied } from "@/lib/audit/log";
import { recordCommodityPrice } from "@/lib/accounting/commodity-price";
import { prisma } from "@/lib/db";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Create a commodity
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateCommodityInput {
  symbol: string;
  name: string;
  assetClass?: string;
}

export interface CommodityActionState {
  ok: boolean;
  message?: string;
  commodityId?: string;
}

export async function createCommodityAction(
  input: CreateCommodityInput
): Promise<CommodityActionState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      await auditAccessDenied({
        attemptedAction: "create-commodity",
        actor: null,
        reason: "Not authenticated",
        resource: "Commodity",
      });
      return { ok: false, message: "You must be signed in." };
    }
    throw e;
  }

  let tenant;
  try {
    tenant = await requireCurrentTenant();
  } catch {
    return { ok: false, message: "No active tenant." };
  }

  // Symbols are compared exactly by the trade path, so normalise on the way in.
  // "aapl" and "AAPL" must not become two positions in the same security.
  const symbol = input.symbol?.trim().toUpperCase();
  const name = input.name?.trim();
  if (!symbol) return { ok: false, message: "A symbol is required." };
  if (!name) return { ok: false, message: "A name is required." };

  const assetClass = input.assetClass?.trim().toUpperCase() || null;

  let commodityId: string;
  try {
    const created = await prisma.commodity.create({
      data: { tenantId: tenant.id, symbol, name, assetClass },
      select: { id: true },
    });
    commodityId = created.id;
  } catch (e) {
    // @@unique([tenantId, symbol])
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, message: `${symbol} is already on file.` };
    }
    throw e;
  }

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    tenantId: tenant.id,
    action: "COMMODITY_CREATED",
    resource: "Commodity",
    resourceId: commodityId,
    metadata: { symbol, name, assetClass },
  });

  revalidatePath("/commodities");
  revalidatePath("/holdings");
  return { ok: true, commodityId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Record a price
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordPriceInput {
  symbol: string;
  currencyCode: string;
  /** ISO YYYY-MM-DD. */
  asOf: string;
  price: string;
}

export async function recordCommodityPriceAction(
  input: RecordPriceInput
): Promise<CommodityActionState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      await auditAccessDenied({
        attemptedAction: "record-commodity-price",
        actor: null,
        reason: "Not authenticated",
        resource: "CommodityPrice",
      });
      return { ok: false, message: "You must be signed in." };
    }
    throw e;
  }

  let tenant;
  try {
    tenant = await requireCurrentTenant();
  } catch {
    return { ok: false, message: "No active tenant." };
  }

  const symbol = input.symbol?.trim().toUpperCase();
  const currencyCode = input.currencyCode?.trim().toUpperCase();
  if (!symbol) return { ok: false, message: "A symbol is required." };
  if (!currencyCode) return { ok: false, message: "A currency is required." };
  if (!ISO_DATE.test(input.asOf ?? "")) {
    return { ok: false, message: "Date must be YYYY-MM-DD." };
  }

  let price: Decimal;
  try {
    price = new Decimal(input.price);
  } catch {
    return { ok: false, message: "Price must be a number." };
  }
  // Zero is allowed — a worthless position is a real state worth marking.
  // Negative is not: a price is what one unit is worth, and nothing is worth
  // less than nothing. (Negative *positions* are a different question, carried
  // by the lots.)
  if (!price.isFinite() || price.isNegative()) {
    return { ok: false, message: "Price must be zero or positive." };
  }

  // Tenant-pinned: symbols are unique only per tenant.
  const commodity = await prisma.commodity.findFirst({
    where: { tenantId: tenant.id, symbol },
    select: { id: true },
  });
  if (!commodity) {
    return {
      ok: false,
      message: `${symbol} is not on file. Add the commodity first.`,
    };
  }

  const currency = await prisma.currency.findUnique({
    where: { code: currencyCode },
    select: { code: true },
  });
  if (!currency) return { ok: false, message: `Unknown currency ${currencyCode}.` };

  const asOf = new Date(`${input.asOf}T00:00:00.000Z`);
  if (Number.isNaN(asOf.getTime())) {
    return { ok: false, message: "Date is not a real calendar date." };
  }

  // Last write wins per (commodity, currency, date) — matching Beancount, where
  // the last price declaration on a day is the one retained.
  await recordCommodityPrice(prisma, {
    tenantId: tenant.id,
    commodityId: commodity.id,
    currencyCode,
    asOf,
    price,
    source: "MANUAL",
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    tenantId: tenant.id,
    action: "COMMODITY_PRICE_RECORDED",
    resource: "CommodityPrice",
    resourceId: commodity.id,
    metadata: {
      symbol,
      currencyCode,
      asOf: input.asOf,
      // A quoted market price is public information, not a customer financial
      // value — recording it is the auditable act here.
      price: price.toString(),
      source: "MANUAL",
    },
  });

  revalidatePath("/commodities");
  revalidatePath("/holdings");
  return { ok: true, commodityId: commodity.id };
}
