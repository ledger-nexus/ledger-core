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

// ─── v0.8 FX Phase 4b — translation rate per ASC 830 category ──────────
//
// The consolidation report (Phase 4c) translates each account's period-
// end balance from the sub's functional currency to the parent's
// reporting currency. ASC 830 dictates a different rate per account
// category — see TranslationCategory in the schema for the four
// possible values.
//
// This helper centralizes the rate selection so the consolidation
// report doesn't have to know which rate to use for each account. It
// returns:
//   - CURRENT_RATE   → the rate at periodEnd (looks up SPOT)
//   - WEIGHTED_AVG   → the average of (rate at periodStart, rate at
//                      periodEnd). When only one rate exists in the
//                      seeded FxRate table within the period, WA = CR
//                      (mathematically correct given the data).
//   - HISTORICAL     → null. The caller MUST walk each posting line
//                      and use that line's transaction-date rate (the
//                      rate that was in effect when the equity
//                      contribution was originally recorded). Equity
//                      contributions don't translate at the period-end
//                      rate; they're frozen at the contribution rate.
//   - EXCLUDED       → Decimal(1). The account is already in
//                      reporting currency at posting time (e.g.
//                      Realized FX Gain/Loss). Multiplication by 1 is
//                      a no-op.

export interface TranslationContext {
  /** Source: the sub's functional currency (e.g. "GBP"). */
  fromCurrencyId: string;
  /** Target: the parent's reporting currency (e.g. "USD"). */
  toCurrencyId: string;
  /** First day of the consolidation period. */
  periodStart: Date;
  /** Last day of the consolidation period (= the as-of date for CR). */
  periodEnd: Date;
}

/**
 * Source of the rate, surfaced for tests + audit-log telemetry.
 *
 *   - "current_rate"        : CURRENT_RATE category; rate from periodEnd lookup
 *   - "weighted_avg"        : WEIGHTED_AVG category; mean of period start + end
 *   - "historical_per_line" : HISTORICAL category; caller computes per line
 *   - "excluded"            : EXCLUDED category; rate locked to 1
 *   - "same_currency"       : transactionCurrency === reportingCurrency;
 *                             no lookup needed, rate = 1 (short-circuit
 *                             that fires regardless of category)
 */
export type TranslationRateSource =
  | "current_rate"
  | "weighted_avg"
  | "historical_per_line"
  | "excluded"
  | "same_currency";

export interface TranslationRateResult {
  /**
   * The rate to apply, or null when HISTORICAL (caller walks lines).
   * For CURRENT_RATE + WEIGHTED_AVG: the looked-up rate.
   * For EXCLUDED + same-currency: Decimal(1).
   */
  rate: Decimal | null;
  /** Where this rate came from — useful for tests + audit telemetry. */
  source: TranslationRateSource;
}

/**
 * Look up the ASC 830 translation rate for an account category.
 *
 * Same-currency short-circuit fires regardless of category: if the sub
 * already posts in the parent's reporting currency, no translation
 * needed, rate = 1.
 */
export async function getTranslationRate(
  prisma: PrismaClient,
  input: {
    category: "CURRENT_RATE" | "HISTORICAL" | "WEIGHTED_AVG" | "EXCLUDED";
    ctx: TranslationContext;
  }
): Promise<TranslationRateResult> {
  // Universal short-circuit: same currency → no translation, rate = 1.
  // Fires regardless of category — a USD sub of a USD parent never
  // translates anything, no matter how the chart classifies each account.
  if (input.ctx.fromCurrencyId === input.ctx.toCurrencyId) {
    return { rate: new Decimal(1), source: "same_currency" };
  }

  if (input.category === "EXCLUDED") {
    // The account is already in reporting currency at posting time
    // (e.g. Realized FX Gain/Loss, 8300). No translation.
    return { rate: new Decimal(1), source: "excluded" };
  }

  if (input.category === "HISTORICAL") {
    // Equity items are translated at the rate when each contribution
    // was ORIGINALLY recorded. The consolidation report's caller must
    // walk each line and use line.entry.fxRate. We return null so the
    // caller can detect this path explicitly — no per-account rate
    // lookup is sensible.
    return { rate: null, source: "historical_per_line" };
  }

  if (input.category === "CURRENT_RATE") {
    const rate = await getFxRateOrDefault(prisma, {
      fromCurrencyId: input.ctx.fromCurrencyId,
      toCurrencyId: input.ctx.toCurrencyId,
      asOf: input.ctx.periodEnd,
      rateType: "SPOT",
    });
    return { rate, source: "current_rate" };
  }

  // WEIGHTED_AVG: simple average of (start rate, end rate). A more
  // sophisticated implementation would weight by transaction activity
  // within the period, but the simple average matches ASC 830's
  // intent (the spirit is "approximate average rate over the period")
  // and works correctly when operators seed daily/weekly rates.
  const startRate = await getFxRateOrDefault(prisma, {
    fromCurrencyId: input.ctx.fromCurrencyId,
    toCurrencyId: input.ctx.toCurrencyId,
    asOf: input.ctx.periodStart,
    rateType: "SPOT",
  });
  const endRate = await getFxRateOrDefault(prisma, {
    fromCurrencyId: input.ctx.fromCurrencyId,
    toCurrencyId: input.ctx.toCurrencyId,
    asOf: input.ctx.periodEnd,
    rateType: "SPOT",
  });
  // Use Decimal arithmetic throughout — never reach for Number per
  // CLAUDE.md money-math rules.
  const avg = startRate.plus(endRate).dividedBy(2);
  return { rate: avg, source: "weighted_avg" };
}
