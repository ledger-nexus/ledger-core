// Unit tests for getFxRateOrDefault.
//
// What we cover:
//   - Same-currency short-circuit (no DB hit)
//   - Cross-currency: most-recent-on-or-before lookup
//   - Cross-currency: throws FxRateNotSeededError when no row exists
//   - Cross-currency: rateType filter honored (SPOT default doesn't
//     surface AVG / HISTORICAL rows)
//   - Cross-currency: direction NOT inverted automatically (silent
//     inversion was deliberately rejected in the design)
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

import {
  getFxRateOrDefault,
  FxRateNotSeededError,
} from "@/lib/accounting/fx";

const prisma = new PrismaClient();

// Use a synthetic currency pair we can fully own in this test, so the
// Northwind-seeded GBP/EUR rates don't interfere. ISO 4217 reserves
// X-prefixed codes for test/private use (XAU = gold, XAG = silver, etc).
const FROM = "XAA"; // synthetic from-currency for this test
const TO = "XAB"; // synthetic to-currency for this test

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

describe("getFxRateOrDefault", () => {
  beforeAll(async () => {
    await ensureTestCurrencies();
    await clearTestRates();
  });

  beforeEach(async () => {
    await clearTestRates();
  });

  afterAll(async () => {
    await clearTestRates();
    await prisma.$disconnect();
  });

  it("returns 1 immediately when from === to (no DB hit needed)", async () => {
    const rate = await getFxRateOrDefault(prisma, {
      fromCurrencyId: "USD",
      toCurrencyId: "USD",
      asOf: new Date("2026-04-15"),
    });
    expect(rate.equals(new Decimal(1))).toBe(true);
  });

  it("returns the most-recent-on-or-before rate", async () => {
    await prisma.fxRate.createMany({
      data: [
        {
          fromCurrencyId: FROM,
          toCurrencyId: TO,
          asOf: new Date("2026-01-01"),
          rate: "1.25",
          rateType: "SPOT",
        },
        {
          fromCurrencyId: FROM,
          toCurrencyId: TO,
          asOf: new Date("2026-03-01"),
          rate: "1.30",
          rateType: "SPOT",
        },
        {
          fromCurrencyId: FROM,
          toCurrencyId: TO,
          asOf: new Date("2026-06-01"),
          rate: "1.35",
          rateType: "SPOT",
        },
      ],
    });

    // Query for 2026-04-15: most recent on or before is 2026-03-01 → 1.30.
    const rate = await getFxRateOrDefault(prisma, {
      fromCurrencyId: FROM,
      toCurrencyId: TO,
      asOf: new Date("2026-04-15"),
    });
    expect(rate.equals(new Decimal("1.30"))).toBe(true);

    // Query for 2026-06-01: exact match returns 1.35.
    const rate2 = await getFxRateOrDefault(prisma, {
      fromCurrencyId: FROM,
      toCurrencyId: TO,
      asOf: new Date("2026-06-01"),
    });
    expect(rate2.equals(new Decimal("1.35"))).toBe(true);

    // Query for 2025-12-31: no row on or before → throws.
    await expect(
      getFxRateOrDefault(prisma, {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        asOf: new Date("2025-12-31"),
      })
    ).rejects.toBeInstanceOf(FxRateNotSeededError);
  });

  it("throws FxRateNotSeededError when no row exists for the pair", async () => {
    // No rates seeded — every cross-currency query throws.
    await expect(
      getFxRateOrDefault(prisma, {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        asOf: new Date("2026-04-15"),
      })
    ).rejects.toBeInstanceOf(FxRateNotSeededError);

    try {
      await getFxRateOrDefault(prisma, {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        asOf: new Date("2026-04-15"),
      });
    } catch (err) {
      const e = err as FxRateNotSeededError;
      expect(e.fromCurrencyId).toBe(FROM);
      expect(e.toCurrencyId).toBe(TO);
      expect(e.rateType).toBe("SPOT");
      // Operator-actionable message includes the pair + date.
      expect(e.message).toContain(FROM);
      expect(e.message).toContain(TO);
      expect(e.message).toContain("2026-04-15");
      expect(e.message).toMatch(/seed|Northwind/i);
    }
  });

  it("honors rateType — SPOT default doesn't surface AVG rows", async () => {
    await prisma.fxRate.create({
      data: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        asOf: new Date("2026-01-01"),
        rate: "1.40",
        rateType: "AVG",
      },
    });

    // SPOT lookup (default) finds nothing — the AVG row is the wrong
    // type. This matters because the consolidation report uses AVG
    // for the income statement (weighted-average period rate) and
    // SPOT for the balance sheet (current rate). Mixing them produces
    // a wrong consolidated TB.
    await expect(
      getFxRateOrDefault(prisma, {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        asOf: new Date("2026-06-01"),
      })
    ).rejects.toBeInstanceOf(FxRateNotSeededError);

    // Explicit AVG lookup finds it.
    const avg = await getFxRateOrDefault(prisma, {
      fromCurrencyId: FROM,
      toCurrencyId: TO,
      asOf: new Date("2026-06-01"),
      rateType: "AVG",
    });
    expect(avg.equals(new Decimal("1.40"))).toBe(true);
  });

  it("does NOT invert direction automatically — design says explicit only", async () => {
    // Seed FROM → TO @ 1.25 only.
    await prisma.fxRate.create({
      data: {
        fromCurrencyId: FROM,
        toCurrencyId: TO,
        asOf: new Date("2026-01-01"),
        rate: "1.25",
        rateType: "SPOT",
      },
    });

    // Lookup TO → FROM must NOT silently return 1/1.25. Throws instead.
    // Rationale: silent inversion masks data-entry errors. Operators
    // seed both directions when they need them; Northwind ships both.
    await expect(
      getFxRateOrDefault(prisma, {
        fromCurrencyId: TO,
        toCurrencyId: FROM,
        asOf: new Date("2026-06-01"),
      })
    ).rejects.toBeInstanceOf(FxRateNotSeededError);
  });
});
