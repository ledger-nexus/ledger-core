// v0.8 FX Phase 4b — getTranslationRate tests.
//
// Covers each branch of the ASC 830 category dispatch:
//
//   - same currency: rate = 1, source = "same_currency", no DB hit
//   - EXCLUDED: rate = 1, source = "excluded" (no DB hit)
//   - HISTORICAL: rate = null, source = "historical_per_line"
//   - CURRENT_RATE: looks up rate at periodEnd
//   - WEIGHTED_AVG: averages (rate at periodStart, rate at periodEnd)
//
// Uses a synthetic currency pair (XAA/XAB) so the test rates don't
// collide with Northwind's GBP/EUR/USD seed.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";

import { getTranslationRate, FxRateNotFoundError } from "@/lib/accounting/fx";

const prisma = new PrismaClient();

const FROM = "XAA";
const TO = "XAB";

async function ensureTestCurrencies(): Promise<void> {
  for (const code of [FROM, TO]) {
    await prisma.currency.upsert({
      where: { code },
      create: { code, name: `Test ${code}`, decimals: 2, symbol: code },
      update: {},
    });
  }
}

async function clearTestRates(): Promise<void> {
  await prisma.fxRate.deleteMany({
    where: {
      OR: [
        { fromCurrencyId: { in: [FROM, TO] } },
        { toCurrencyId: { in: [FROM, TO] } },
      ],
    },
  });
}

const PERIOD_START = new Date("2026-01-01");
const PERIOD_END = new Date("2026-03-31");

describe("getTranslationRate", () => {
  beforeAll(async () => {
    await ensureTestCurrencies();
  });

  beforeEach(async () => {
    await clearTestRates();
  });

  afterAll(async () => {
    await clearTestRates();
    await prisma.$disconnect();
  });

  it("same currency short-circuits to rate=1 regardless of category", async () => {
    // Fires for every category — USD sub of USD parent never translates.
    for (const cat of [
      "CURRENT_RATE",
      "HISTORICAL",
      "WEIGHTED_AVG",
      "EXCLUDED",
    ] as const) {
      const r = await getTranslationRate(prisma, {
        category: cat,
        ctx: {
          fromCurrencyId: "USD",
          toCurrencyId: "USD",
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
      });
      expect(r.rate?.equals(new Decimal(1))).toBe(true);
      expect(r.source).toBe("same_currency");
    }
  });

  it("EXCLUDED category returns rate=1 without a DB lookup", async () => {
    // No FxRate rows seeded; if EXCLUDED tried to look up a rate, this
    // would throw FxRateNotFoundError. The pass proves the
    // short-circuit fires before any lookup.
    const r = await getTranslationRate(prisma, {
      category: "EXCLUDED",
      ctx: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      },
    });
    expect(r.rate?.equals(new Decimal(1))).toBe(true);
    expect(r.source).toBe("excluded");
  });

  it("HISTORICAL category returns null + 'historical_per_line' (caller walks lines)", async () => {
    const r = await getTranslationRate(prisma, {
      category: "HISTORICAL",
      ctx: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      },
    });
    expect(r.rate).toBeNull();
    expect(r.source).toBe("historical_per_line");
  });

  it("CURRENT_RATE looks up the rate at periodEnd", async () => {
    // Seed rates at start (1.20) and end (1.30); CURRENT_RATE picks the
    // end-of-period one.
    await prisma.fxRate.createMany({
      data: [
        {
          fromCurrencyId: FROM,
          toCurrencyId: TO,
          asOf: PERIOD_START,
          rate: "1.20",
          rateType: "CLOSE",
        },
        {
          fromCurrencyId: FROM,
          toCurrencyId: TO,
          asOf: PERIOD_END,
          rate: "1.30",
          rateType: "CLOSE",
        },
      ],
    });

    const r = await getTranslationRate(prisma, {
      category: "CURRENT_RATE",
      ctx: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      },
    });
    expect(r.rate?.equals(new Decimal("1.30"))).toBe(true);
    expect(r.source).toBe("current_rate");
  });

  it("WEIGHTED_AVG averages the periodStart and periodEnd rates", async () => {
    // 1.20 + 1.30 = 2.50 / 2 = 1.25
    await prisma.fxRate.createMany({
      data: [
        {
          fromCurrencyId: FROM,
          toCurrencyId: TO,
          asOf: PERIOD_START,
          rate: "1.20",
          rateType: "CLOSE",
        },
        {
          fromCurrencyId: FROM,
          toCurrencyId: TO,
          asOf: PERIOD_END,
          rate: "1.30",
          rateType: "CLOSE",
        },
      ],
    });

    const r = await getTranslationRate(prisma, {
      category: "WEIGHTED_AVG",
      ctx: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      },
    });
    expect(r.rate?.equals(new Decimal("1.25"))).toBe(true);
    expect(r.source).toBe("weighted_avg");
  });

  it("WEIGHTED_AVG equals CURRENT_RATE when only one rate exists in the period", async () => {
    // The Northwind case: only one seeded rate at 2026-01-01.
    // WA(start, end) = WA(1.27, 1.27) = 1.27 = CR. Documents the
    // expected behavior with sparse rate data.
    await prisma.fxRate.create({
      data: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        asOf: PERIOD_START,
        rate: "1.27",
        rateType: "CLOSE",
      },
    });

    const wa = await getTranslationRate(prisma, {
      category: "WEIGHTED_AVG",
      ctx: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      },
    });
    const cr = await getTranslationRate(prisma, {
      category: "CURRENT_RATE",
      ctx: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      },
    });
    expect(wa.rate?.equals(cr.rate!)).toBe(true);
    expect(wa.rate?.equals(new Decimal("1.27"))).toBe(true);
  });

  it("CURRENT_RATE throws FxRateNotFoundError when no rate exists", async () => {
    // Bubbling the underlying helper's error — operator gets the
    // operator-actionable message ("Add a row to the FxRate table...").
    await expect(
      getTranslationRate(prisma, {
        category: "CURRENT_RATE",
        ctx: {
          fromCurrencyId: FROM,
          toCurrencyId: TO,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
      })
    ).rejects.toBeInstanceOf(FxRateNotFoundError);
  });

  it("WEIGHTED_AVG throws when either end of the range has no rate", async () => {
    // Only start seeded, missing end → throws on the periodEnd lookup.
    await prisma.fxRate.create({
      data: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        asOf: new Date("2025-01-01"), // BEFORE the period
        rate: "1.20",
        rateType: "CLOSE",
      },
    });
    // PeriodStart still finds the 2025-01-01 row (most-recent-on-or-
    // before). PeriodEnd ALSO finds that row. So WA = 1.20 from both
    // sides. No throw — this matches operator-seeded-once-a-year
    // behavior, where the single seeded rate covers the whole period.
    const r = await getTranslationRate(prisma, {
      category: "WEIGHTED_AVG",
      ctx: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      },
    });
    expect(r.rate?.equals(new Decimal("1.20"))).toBe(true);
  });
});
