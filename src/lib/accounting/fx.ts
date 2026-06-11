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
