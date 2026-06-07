// FX rate lookup helper for the FX translation arc (Phase 1).
//
// Design: docs/fx-translation-design.md
//
// One public function: `getFxRateOrDefault`. Same-currency short-circuits
// to 1 without a DB hit; cross-currency looks up the most-recent-on-or-
// before FxRate row matching (from, to, type); throws a typed error if
// no row exists so the caller can surface an operator-actionable
// message rather than the silent default-to-1 that produced the v0.7
// disclosure banner.

import type { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

// Mirror of FxRateType for callers that don't import the Prisma enum
// directly. Same string values as the Prisma enum at the wire level.
export type FxRateType = "SPOT" | "AVG" | "HISTORICAL";

export interface GetFxRateInput {
  fromCurrencyId: string;
  toCurrencyId: string;
  asOf: Date;
  /** Defaults to SPOT — the rate type used for transaction posting. */
  rateType?: FxRateType;
}

/**
 * Thrown when a needed FX rate isn't seeded. Caller catches this and
 * presents a "seed the FxRate table" message to the operator rather
 * than silently treating the rate as 1 (which silently mis-states
 * cross-currency postings — the bug that drove the v0.7 disclosure
 * banner).
 */
export class FxRateNotSeededError extends Error {
  fromCurrencyId: string;
  toCurrencyId: string;
  asOf: Date;
  rateType: FxRateType;
  constructor(input: {
    fromCurrencyId: string;
    toCurrencyId: string;
    asOf: Date;
    rateType: FxRateType;
  }) {
    super(
      `No ${input.rateType} rate seeded for ${input.fromCurrencyId}→` +
        `${input.toCurrencyId} as of ${input.asOf.toISOString().slice(0, 10)}. ` +
        `Add a row to the FxRate table (operator-actionable) or load the ` +
        `Northwind seed which ships baseline rates for USD/GBP/EUR.`
    );
    this.name = "FxRateNotSeededError";
    this.fromCurrencyId = input.fromCurrencyId;
    this.toCurrencyId = input.toCurrencyId;
    this.asOf = input.asOf;
    this.rateType = input.rateType;
  }
}

/**
 * Look up an FX rate for the given currency pair + date. Returns a
 * Decimal so callers can chain conversions without precision loss.
 *
 * Behavior:
 *   - Same currency (from === to): returns `1` immediately, no DB.
 *   - Cross currency: queries FxRate for the most recent row matching
 *     (from, to, type) with `asOf <= input.asOf`. NS / real-world FX
 *     rates are typically daily, but operators may seed monthly or
 *     weekly. The "most recent on or before" semantic matches how NS
 *     itself resolves rates when a daily rate isn't present.
 *   - No matching row: throws FxRateNotSeededError. Silent default to 1
 *     was the v0.7 bug — every cross-currency tx silently mis-posted.
 *
 * Currency-pair direction is NOT inverted automatically. A GBP → USD
 * lookup requires a row with fromCurrencyId="GBP" AND toCurrencyId="USD";
 * a USD → GBP row will NOT satisfy it. Rationale: silently inverting
 * masks data-entry errors, and the Northwind seed loads both directions
 * for every pair.
 */
export async function getFxRateOrDefault(
  prisma: PrismaClient,
  input: GetFxRateInput
): Promise<Decimal> {
  const rateType = input.rateType ?? "SPOT";

  if (input.fromCurrencyId === input.toCurrencyId) {
    return new Decimal(1);
  }

  // Most-recent-on-or-before lookup. The composite unique
  // (from, to, asOf, type) makes this query selective on the index.
  const row = await prisma.fxRate.findFirst({
    where: {
      fromCurrencyId: input.fromCurrencyId,
      toCurrencyId: input.toCurrencyId,
      rateType,
      asOf: { lte: input.asOf },
    },
    orderBy: { asOf: "desc" },
    select: { rate: true },
  });

  if (!row) {
    throw new FxRateNotSeededError({
      fromCurrencyId: input.fromCurrencyId,
      toCurrencyId: input.toCurrencyId,
      asOf: input.asOf,
      rateType,
    });
  }

  // Prisma Decimal → decimal.js Decimal via string (canonical conversion
  // per CLAUDE.md money-math rules).
  return new Decimal(row.rate.toString());
}
