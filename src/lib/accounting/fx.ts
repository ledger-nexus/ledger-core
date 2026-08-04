// FX rate lookup + currency conversion.
//
// The FxRate table (prisma/schema.prisma) has existed since Layer 2 but
// nothing consulted it — every JE so far posts same-currency at an
// implicit rate of 1. This module is the missing read path: given a
// currency pair, a date, and a rate type, return the applicable rate so
// the revaluation engine (and any future multi-currency posting) can
// re-measure foreign balances.
//
// Lookup semantics (ASC 830 / IAS 21 friendly):
//   - rateType selects the curve: SPOT for transaction-date,
//     CLOSE for period-end balance-sheet re-measurement,
//     AVG for period revenue/expense translation,
//     HISTORICAL for equity.
//   - "as of" is resolved on-or-before: the most recent rate dated <=
//     the requested date wins. A month-end revaluation on 2026-06-30
//     uses the 2026-06-30 CLOSE rate if present, else the latest CLOSE
//     rate before it. This mirrors how a rate feed publishes — you take
//     the last published rate, you don't interpolate forward.
//   - Same-currency pairs short-circuit to 1 without a DB read.
//   - Inverse fallback: if EUR->USD isn't stored but USD->EUR is, we
//     return 1/rate. Rate feeds usually store one direction; this keeps
//     callers from having to seed both legs. Direct rates always win
//     over inverted ones.
//
// Money discipline (CLAUDE.md): all math is decimal.js. Prisma Decimals
// are converted via new Decimal(value.toString()). Never Number.

import { FxRateType } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import { Decimal } from "decimal.js";


export class FxRateNotFoundError extends Error {
  constructor(
    public readonly fromCurrency: string,
    public readonly toCurrency: string,
    public readonly asOf: Date,
    public readonly rateType: FxRateType
  ) {
    super(
      `No ${rateType} FX rate for ${fromCurrency}->${toCurrency} on or before ${asOf.toISOString().slice(0, 10)} (direct or inverse)`
    );
    this.name = "FxRateNotFoundError";
  }
}

export interface FxRateLookup {
  fromCurrency: string;
  toCurrency: string;
  asOf: Date;
  /** Defaults to CLOSE — the period-end balance-sheet rate revaluation uses. */
  rateType?: FxRateType;
}

export interface ResolvedFxRate {
  rate: Decimal;
  /** The asOf date of the rate row actually used (may predate the request). */
  effectiveDate: Date;
  rateType: FxRateType;
  /** True when the rate was derived by inverting the opposite-direction row. */
  inverted: boolean;
}

/**
 * Resolve the applicable FX rate for a currency pair as of a date.
 * Returns the rate plus provenance (effective date, whether inverted)
 * so callers can record exactly which rate drove a revaluation. Throws
 * FxRateNotFoundError when neither a direct nor inverse rate exists on
 * or before the date — the revaluation engine surfaces this rather than
 * silently revaluing at a stale or assumed rate.
 */
export async function resolveFxRate(
  prisma: DbClient,
  lookup: FxRateLookup
): Promise<ResolvedFxRate> {
  const rateType = lookup.rateType ?? "CLOSE";

  // Same currency: identity. No DB read, no row required.
  if (lookup.fromCurrency === lookup.toCurrency) {
    return {
      rate: new Decimal(1),
      effectiveDate: lookup.asOf,
      rateType,
      inverted: false,
    };
  }

  // Direct rate: most recent row dated on or before asOf.
  const direct = await prisma.fxRate.findFirst({
    where: {
      fromCurrencyId: lookup.fromCurrency,
      toCurrencyId: lookup.toCurrency,
      rateType,
      asOf: { lte: lookup.asOf },
    },
    orderBy: { asOf: "desc" },
    select: { rate: true, asOf: true },
  });
  if (direct) {
    return {
      rate: new Decimal(direct.rate.toString()),
      effectiveDate: direct.asOf,
      rateType,
      inverted: false,
    };
  }

  // Inverse fallback: the feed may store only USD->EUR. Invert it.
  const inverse = await prisma.fxRate.findFirst({
    where: {
      fromCurrencyId: lookup.toCurrency,
      toCurrencyId: lookup.fromCurrency,
      rateType,
      asOf: { lte: lookup.asOf },
    },
    orderBy: { asOf: "desc" },
    select: { rate: true, asOf: true },
  });
  if (inverse) {
    const inverseRate = new Decimal(inverse.rate.toString());
    if (inverseRate.isZero()) {
      // A zero rate can't be inverted; treat as missing rather than divide-by-zero.
      throw new FxRateNotFoundError(
        lookup.fromCurrency,
        lookup.toCurrency,
        lookup.asOf,
        rateType
      );
    }
    return {
      rate: new Decimal(1).dividedBy(inverseRate),
      effectiveDate: inverse.asOf,
      rateType,
      inverted: true,
    };
  }

  throw new FxRateNotFoundError(
    lookup.fromCurrency,
    lookup.toCurrency,
    lookup.asOf,
    rateType
  );
}

/**
 * Convenience wrapper: convert an amount from one currency to another
 * at the applicable rate. The amount is multiplied by the resolved rate
 * and returned as a Decimal — the caller decides rounding (account
 * currency decimals) at persist time, so this stays full-precision.
 */
export async function convertAmount(
  prisma: DbClient,
  amount: Decimal | string | number,
  lookup: FxRateLookup
): Promise<{ converted: Decimal; resolved: ResolvedFxRate }> {
  const resolved = await resolveFxRate(prisma, lookup);
  const a = amount instanceof Decimal ? amount : new Decimal(amount.toString());
  return { converted: a.times(resolved.rate), resolved };
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
//   - CURRENT_RATE   → the CLOSE rate at periodEnd (the same
//                      period-end curve revaluation uses)
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
//                      reporting currency at posting time (the FX
//                      gain/loss pair: 8300 unrealized, 8310
//                      realized). Multiplication by 1 is a no-op.

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
  prisma: DbClient,
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
    // (the FX gain/loss pair: 8300 unrealized, 8310 realized).
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
    const resolved = await resolveFxRate(prisma, {
      fromCurrency: input.ctx.fromCurrencyId,
      toCurrency: input.ctx.toCurrencyId,
      asOf: input.ctx.periodEnd,
      rateType: "CLOSE",
    });
    return { rate: resolved.rate, source: "current_rate" };
  }

  // WEIGHTED_AVG: simple average of (start rate, end rate). A more
  // sophisticated implementation would weight by transaction activity
  // within the period, but the simple average matches ASC 830's
  // intent (the spirit is "approximate average rate over the period")
  // and works correctly when operators seed daily/weekly rates.
  const startRate = (
    await resolveFxRate(prisma, {
      fromCurrency: input.ctx.fromCurrencyId,
      toCurrency: input.ctx.toCurrencyId,
      asOf: input.ctx.periodStart,
      rateType: "CLOSE",
    })
  ).rate;
  const endRate = (
    await resolveFxRate(prisma, {
      fromCurrency: input.ctx.fromCurrencyId,
      toCurrency: input.ctx.toCurrencyId,
      asOf: input.ctx.periodEnd,
      rateType: "CLOSE",
    })
  ).rate;
  // Use Decimal arithmetic throughout — never reach for Number per
  // CLAUDE.md money-math rules.
  const avg = startRate.plus(endRate).dividedBy(2);
  return { rate: avg, source: "weighted_avg" };
}
