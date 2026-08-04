// Inventory booking engine — pure unit tests (no DB).
//
// Two acquisitions of AAPL: 10 @ $100 on Jan 1 (lot A), 10 @ $120 on Feb 1
// (lot B). Various reductions exercise FIFO / LIFO / STRICT, cost relief, and
// realized gain.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  bookReduction,
  totalUnits,
  totalCost,
  averageCost,
  InsufficientUnitsError,
  AmbiguousLotError,
  UnknownLotError,
  InvalidReductionError,
  type Lot,
} from "@/lib/accounting/inventory";

function held(): Lot[] {
  return [
    { id: "A", units: new Decimal(10), unitCost: new Decimal(100), acquisitionDate: new Date("2026-01-01") },
    { id: "B", units: new Decimal(10), unitCost: new Decimal(120), acquisitionDate: new Date("2026-02-01") },
  ];
}

describe("inventory summaries", () => {
  it("totals units and cost, and averages", () => {
    expect(totalUnits(held()).toFixed(0)).toBe("20");
    expect(totalCost(held()).toFixed(0)).toBe("2200"); // 10*100 + 10*120
    expect(averageCost(held())!.toFixed(0)).toBe("110");
  });

  it("averageCost is null for an empty holding", () => {
    expect(averageCost([])).toBeNull();
  });
});

describe("FIFO", () => {
  it("draws the oldest lot first, spilling into the next", () => {
    // Sell 15: 10 from A ($100) + 5 from B ($120).
    const r = bookReduction(held(), 15, "FIFO", { reductionPrice: 130 });
    expect(r.consumed).toEqual([
      { lotId: "A", units: new Decimal(10), unitCost: new Decimal(100) },
      { lotId: "B", units: new Decimal(5), unitCost: new Decimal(120) },
    ]);
    // cost relieved = 10*100 + 5*120 = 1600
    expect(r.costRelieved.toFixed(0)).toBe("1600");
    // proceeds = 15*130 = 1950; gain = 1950 - 1600 = 350
    expect(r.proceeds!.toFixed(0)).toBe("1950");
    expect(r.realizedGain!.toFixed(0)).toBe("350");
    // A gone, B down to 5.
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0].id).toBe("B");
    expect(r.remaining[0].units.toFixed(0)).toBe("5");
  });
});

describe("LIFO", () => {
  it("draws the newest lot first", () => {
    // Sell 15: 10 from B ($120) + 5 from A ($100).
    const r = bookReduction(held(), 15, "LIFO", { reductionPrice: 130 });
    expect(r.consumed.map((c) => c.lotId)).toEqual(["B", "A"]);
    // cost relieved = 10*120 + 5*100 = 1700 (higher basis first -> smaller gain)
    expect(r.costRelieved.toFixed(0)).toBe("1700");
    expect(r.realizedGain!.toFixed(0)).toBe("250"); // 1950 - 1700
    // remaining preserves INPUT order: A (reduced to 5) stays first.
    expect(r.remaining.map((l) => l.id)).toEqual(["A"]);
    expect(r.remaining[0].units.toFixed(0)).toBe("5");
  });
});

describe("realized gain sign", () => {
  it("reports a loss when proceeds are below cost", () => {
    // Sell 10 FIFO (from A @ $100) at $90 -> loss of 100.
    const r = bookReduction(held(), 10, "FIFO", { reductionPrice: 90 });
    expect(r.realizedGain!.toFixed(0)).toBe("-100");
  });

  it("leaves proceeds/gain null when no price is given (e.g. a transfer)", () => {
    const r = bookReduction(held(), 10, "FIFO");
    expect(r.proceeds).toBeNull();
    expect(r.realizedGain).toBeNull();
    expect(r.costRelieved.toFixed(0)).toBe("1000"); // cost relief still computed
  });
});

describe("STRICT", () => {
  it("consumes the only lot when there is exactly one", () => {
    const one: Lot[] = [held()[0]];
    const r = bookReduction(one, 4, "STRICT");
    expect(r.consumed.map((c) => c.lotId)).toEqual(["A"]);
    expect(r.remaining[0].units.toFixed(0)).toBe("6");
  });

  it("allows selling the WHOLE position across multiple lots (unambiguous)", () => {
    const r = bookReduction(held(), 20, "STRICT", { reductionPrice: 130 });
    expect(r.consumed.map((c) => c.lotId).sort()).toEqual(["A", "B"]);
    expect(r.remaining).toHaveLength(0);
    // gain = 20*130 - 2200 = 400
    expect(r.realizedGain!.toFixed(0)).toBe("400");
  });

  it("refuses an ambiguous partial reduction across multiple lots", () => {
    expect(() => bookReduction(held(), 5, "STRICT")).toThrow(AmbiguousLotError);
  });

  it("draws from a named lot", () => {
    const r = bookReduction(held(), 6, "STRICT", { lotId: "B", reductionPrice: 130 });
    expect(r.consumed).toEqual([{ lotId: "B", units: new Decimal(6), unitCost: new Decimal(120) }]);
    // remaining: A untouched (10), B down to 4 — input order preserved.
    expect(r.remaining.map((l) => l.id)).toEqual(["A", "B"]);
    expect(r.remaining[1].units.toFixed(0)).toBe("4");
  });

  it("refuses a named-lot reduction larger than that lot", () => {
    expect(() => bookReduction(held(), 12, "STRICT", { lotId: "A" })).toThrow(
      InsufficientUnitsError
    );
  });

  it("throws on an unknown named lot", () => {
    expect(() => bookReduction(held(), 1, "STRICT", { lotId: "ZZZ" })).toThrow(UnknownLotError);
  });
});

describe("guards", () => {
  it("refuses more units than are held", () => {
    expect(() => bookReduction(held(), 21, "FIFO")).toThrow(InsufficientUnitsError);
  });

  it("refuses a non-positive reduction", () => {
    expect(() => bookReduction(held(), 0, "FIFO")).toThrow(InvalidReductionError);
    expect(() => bookReduction(held(), -3, "FIFO")).toThrow(InvalidReductionError);
  });

  it("does not mutate the input lots", () => {
    const input = held();
    bookReduction(input, 15, "FIFO", { reductionPrice: 130 });
    expect(input[0].units.toFixed(0)).toBe("10");
    expect(input[1].units.toFixed(0)).toBe("10");
  });
});

describe("fractional units + precision", () => {
  it("handles fractional draw-downs exactly (decimal, not float)", () => {
    // 0.1 + 0.2 territory: 0.3 * 0.1 must be exactly 0.03, and 1.5 - 0.3
    // exactly 1.2 — decimal, not IEEE float.
    const lots: Lot[] = [
      { id: "X", units: new Decimal("1.5"), unitCost: new Decimal("0.1"), acquisitionDate: new Date("2026-01-01") },
    ];
    const r = bookReduction(lots, "0.3", "FIFO", { reductionPrice: "0.5" });
    expect(r.costRelieved.equals(new Decimal("0.03"))).toBe(true); // 0.3 * 0.1
    expect(r.proceeds!.equals(new Decimal("0.15"))).toBe(true); // 0.3 * 0.5
    expect(r.realizedGain!.equals(new Decimal("0.12"))).toBe(true); // 0.15 - 0.03
    expect(r.remaining[0].units.equals(new Decimal("1.2"))).toBe(true); // 1.5 - 0.3
  });
});
