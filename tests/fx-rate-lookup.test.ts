// FX rate lookup tests (src/lib/accounting/fx.ts).
//
// Pins resolveFxRate + convertAmount against a real Postgres:
//   1. Same-currency pair → rate 1, no DB row required
//   2. Exact-date direct rate → returns that rate, inverted=false
//   3. On-or-before resolution → a mid-month date picks the latest rate
//      dated <= the request (not a future rate)
//   4. rateType selects the curve → CLOSE vs AVG return different rows
//   5. Inverse fallback → only USD->EUR stored, asking EUR->USD returns 1/rate
//   6. Direct beats inverse → when both legs exist, the direct row wins
//   7. Missing rate → FxRateNotFoundError (no silent stale/assumed rate)
//   8. convertAmount → multiplies the amount by the resolved rate, full precision
//
// Isolation: a dedicated currency pair (XTA/XTB — private-use ISO codes)
// seeded fresh per suite so we don't collide with the Northwind EUR/GBP
// rates. Cleaned up in afterAll.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

import {
  resolveFxRate,
  convertAmount,
  FxRateNotFoundError,
} from "@/lib/accounting/fx";

const prisma = new PrismaClient();

// Private-use-ish codes that won't collide with seeded majors.
const A = "XTA";
const B = "XTB";
const C = "XTC"; // a third with no rates at all → missing-rate case

beforeAll(async () => {
  for (const code of [A, B, C]) {
    await prisma.currency.upsert({
      where: { code },
      create: { code, name: `Test ${code}`, decimals: 2 },
      update: {},
    });
  }

  // A->B CLOSE curve across three month-ends.
  const rows: Array<[string, string, string, "CLOSE" | "AVG", string]> = [
    [A, B, "2026-01-31", "CLOSE", "2.0000"],
    [A, B, "2026-02-28", "CLOSE", "2.5000"],
    [A, B, "2026-03-31", "CLOSE", "3.0000"],
    // A different curve (AVG) on the same date → must not be confused with CLOSE.
    [A, B, "2026-03-31", "AVG", "2.7000"],
    // Only ONE direction for B->A inverse test: store A's reverse via a
    // separate pair below.
  ];
  for (const [from, to, asOf, rateType, rate] of rows) {
    await prisma.fxRate.upsert({
      where: {
        fromCurrencyId_toCurrencyId_asOf_rateType: {
          fromCurrencyId: from,
          toCurrencyId: to,
          asOf: new Date(asOf),
          rateType,
        },
      },
      create: { fromCurrencyId: from, toCurrencyId: to, asOf: new Date(asOf), rateType, rate },
      update: { rate },
    });
  }
});

afterAll(async () => {
  await prisma.fxRate.deleteMany({
    where: { fromCurrencyId: { in: [A, B, C] } },
  });
  await prisma.fxRate.deleteMany({
    where: { toCurrencyId: { in: [A, B, C] } },
  });
  // Currencies may be referenced elsewhere only if a test created rows;
  // we cleaned rates above, so deleting the test currencies is safe.
  await prisma.currency.deleteMany({ where: { code: { in: [A, B, C] } } });
  await prisma.$disconnect();
});

describe("resolveFxRate", () => {
  it("same-currency pair returns rate 1 without needing a DB row", async () => {
    const r = await resolveFxRate(prisma, {
      fromCurrency: C, // C has no rates at all — proves no row is read
      toCurrency: C,
      asOf: new Date("2026-06-30"),
    });
    expect(r.rate.equals(new Decimal(1))).toBe(true);
    expect(r.inverted).toBe(false);
  });

  it("exact-date direct rate returns that rate", async () => {
    const r = await resolveFxRate(prisma, {
      fromCurrency: A,
      toCurrency: B,
      asOf: new Date("2026-02-28"),
      rateType: "CLOSE",
    });
    expect(r.rate.equals(new Decimal("2.5"))).toBe(true);
    expect(r.inverted).toBe(false);
    expect(r.effectiveDate.toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("resolves on-or-before: a mid-month date picks the latest prior rate", async () => {
    // 2026-03-15 has no exact row; the latest CLOSE <= that date is 2026-02-28.
    const r = await resolveFxRate(prisma, {
      fromCurrency: A,
      toCurrency: B,
      asOf: new Date("2026-03-15"),
      rateType: "CLOSE",
    });
    expect(r.rate.equals(new Decimal("2.5"))).toBe(true);
    expect(r.effectiveDate.toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("rateType selects the curve: CLOSE and AVG differ on the same date", async () => {
    const close = await resolveFxRate(prisma, {
      fromCurrency: A,
      toCurrency: B,
      asOf: new Date("2026-03-31"),
      rateType: "CLOSE",
    });
    const avg = await resolveFxRate(prisma, {
      fromCurrency: A,
      toCurrency: B,
      asOf: new Date("2026-03-31"),
      rateType: "AVG",
    });
    expect(close.rate.equals(new Decimal("3.0"))).toBe(true);
    expect(avg.rate.equals(new Decimal("2.7"))).toBe(true);
  });

  it("inverse fallback: B->A returns 1/rate when only A->B is stored", async () => {
    const r = await resolveFxRate(prisma, {
      fromCurrency: B,
      toCurrency: A,
      asOf: new Date("2026-01-31"),
      rateType: "CLOSE",
    });
    // A->B on 2026-01-31 is 2.0, so B->A = 0.5.
    expect(r.rate.equals(new Decimal("0.5"))).toBe(true);
    expect(r.inverted).toBe(true);
  });

  it("direct rate beats inverse when both legs exist", async () => {
    // Seed an explicit B->A rate that is NOT the inverse of A->B, then
    // confirm the direct one wins (proves we don't invert when a direct
    // row is present). Clean it up in the same test so it doesn't leak
    // into later B->A inverse-path assertions (on-or-before would
    // otherwise resolve this direct row for them).
    const created = await prisma.fxRate.create({
      data: {
        fromCurrencyId: B,
        toCurrencyId: A,
        asOf: new Date("2026-01-31"),
        rateType: "CLOSE",
        rate: "0.4900", // deliberately != 1/2.0 = 0.5
      },
      select: { id: true },
    });
    try {
      const r = await resolveFxRate(prisma, {
        fromCurrency: B,
        toCurrency: A,
        asOf: new Date("2026-01-31"),
        rateType: "CLOSE",
      });
      expect(r.rate.equals(new Decimal("0.49"))).toBe(true);
      expect(r.inverted).toBe(false);
    } finally {
      await prisma.fxRate.delete({ where: { id: created.id } });
    }
  });

  it("throws FxRateNotFoundError when neither direct nor inverse exists", async () => {
    await expect(
      resolveFxRate(prisma, {
        fromCurrency: A,
        toCurrency: C, // no A->C or C->A rate anywhere
        asOf: new Date("2026-06-30"),
        rateType: "CLOSE",
      })
    ).rejects.toBeInstanceOf(FxRateNotFoundError);
  });

  it("throws when the only rate is dated AFTER the requested date", async () => {
    // Earliest A->B CLOSE is 2026-01-31; asking as-of 2026-01-01 → nothing prior.
    await expect(
      resolveFxRate(prisma, {
        fromCurrency: A,
        toCurrency: B,
        asOf: new Date("2026-01-01"),
        rateType: "CLOSE",
      })
    ).rejects.toBeInstanceOf(FxRateNotFoundError);
  });
});

describe("convertAmount", () => {
  it("multiplies the amount by the resolved rate at full precision", async () => {
    const { converted, resolved } = await convertAmount(prisma, "1000", {
      fromCurrency: A,
      toCurrency: B,
      asOf: new Date("2026-03-31"),
      rateType: "CLOSE",
    });
    // 1000 * 3.0 = 3000
    expect(converted.equals(new Decimal("3000"))).toBe(true);
    expect(resolved.rate.equals(new Decimal("3.0"))).toBe(true);
  });

  it("accepts a Decimal input and preserves precision through the inverse path", async () => {
    const { converted } = await convertAmount(prisma, new Decimal("300"), {
      fromCurrency: B,
      toCurrency: A,
      asOf: new Date("2026-02-28"),
      rateType: "CLOSE",
    });
    // B->A on 2026-02-28 inverts A->B 2.5 → 0.4; 300 * 0.4 = 120.
    expect(converted.equals(new Decimal("120"))).toBe(true);
  });
});
