// Reassignment rules — evaluator unit tests. Pure functions, no DB.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { evaluate, resolveFieldPath, EvaluatorError } from "../src/lib/rules/evaluator";
import type { Clause } from "../src/lib/rules/types";

describe("resolveFieldPath", () => {
  it("direct field", () => {
    expect(resolveFieldPath("amount", { amount: 100 })).toBe(100);
  });
  it("nested one-level", () => {
    expect(
      resolveFieldPath("customer.creditRating", {
        customer: { creditRating: "AAA" },
      })
    ).toBe("AAA");
  });
  it("returns undefined for missing leaf field", () => {
    expect(resolveFieldPath("amount", {})).toBe(undefined);
  });
  it("returns null when traversing through an undefined intermediate", () => {
    expect(resolveFieldPath("customer.creditRating", {})).toBe(null);
  });
  it("returns null when intermediate is null", () => {
    expect(resolveFieldPath("customer.creditRating", { customer: null })).toBe(null);
  });
});

describe("evaluate: EQ / NEQ", () => {
  it("EQ on strings", () => {
    const c: Clause = { field: "status", op: "EQ", value: "OPEN" };
    expect(evaluate(c, { status: "OPEN" })).toBe(true);
    expect(evaluate(c, { status: "CLOSED" })).toBe(false);
  });
  it("EQ coerces number ↔ numeric string", () => {
    const c: Clause = { field: "n", op: "EQ", value: 5 };
    expect(evaluate(c, { n: "5" })).toBe(true);
    expect(evaluate(c, { n: 5 })).toBe(true);
  });
  it("EQ on Decimal", () => {
    const c: Clause = { field: "amount", op: "EQ", value: new Decimal("100.00") };
    expect(evaluate(c, { amount: new Decimal("100") })).toBe(true);
    expect(evaluate(c, { amount: "100" })).toBe(true);
    expect(evaluate(c, { amount: 100 })).toBe(true);
  });
  it("EQ on Date", () => {
    const c: Clause = { field: "d", op: "EQ", value: new Date("2026-03-15") };
    expect(evaluate(c, { d: new Date("2026-03-15") })).toBe(true);
    expect(evaluate(c, { d: "2026-03-15" })).toBe(true);
    expect(evaluate(c, { d: new Date("2026-03-16") })).toBe(false);
  });
  it("NEQ on strings", () => {
    const c: Clause = { field: "status", op: "NEQ", value: "OPEN" };
    expect(evaluate(c, { status: "CLOSED" })).toBe(true);
    expect(evaluate(c, { status: "OPEN" })).toBe(false);
  });
});

describe("evaluate: IN / NOT_IN", () => {
  it("IN matches", () => {
    const c: Clause = { field: "bookCode", op: "IN", value: ["US_GAAP", "IFRS"] };
    expect(evaluate(c, { bookCode: "US_GAAP" })).toBe(true);
    expect(evaluate(c, { bookCode: "US_TAX" })).toBe(false);
  });
  it("NOT_IN", () => {
    const c: Clause = { field: "rating", op: "NOT_IN", value: ["AAA", "AA"] };
    expect(evaluate(c, { rating: "BBB" })).toBe(true);
    expect(evaluate(c, { rating: "AAA" })).toBe(false);
  });
  it("IN requires array", () => {
    const c: Clause = { field: "x", op: "IN", value: "not-an-array" };
    expect(() => evaluate(c, { x: "a" })).toThrow(EvaluatorError);
  });
});

describe("evaluate: numeric comparisons", () => {
  it("GT on numbers", () => {
    const c: Clause = { field: "amount", op: "GT", value: 1000 };
    expect(evaluate(c, { amount: 1500 })).toBe(true);
    expect(evaluate(c, { amount: 1000 })).toBe(false);
    expect(evaluate(c, { amount: 500 })).toBe(false);
  });
  it("GTE on numbers", () => {
    const c: Clause = { field: "n", op: "GTE", value: 100 };
    expect(evaluate(c, { n: 100 })).toBe(true);
    expect(evaluate(c, { n: 99 })).toBe(false);
  });
  it("LT on Decimal", () => {
    const c: Clause = { field: "amount", op: "LT", value: 5000 };
    expect(evaluate(c, { amount: new Decimal("4999.99") })).toBe(true);
    expect(evaluate(c, { amount: new Decimal("5000.00") })).toBe(false);
  });
  it("comparisons accept numeric strings", () => {
    const c: Clause = { field: "amount", op: "GT", value: "1000" };
    expect(evaluate(c, { amount: "1500" })).toBe(true);
  });
});

describe("evaluate: date comparisons", () => {
  it("GT on dates", () => {
    const c: Clause = { field: "d", op: "GT", value: new Date("2026-01-01") };
    expect(evaluate(c, { d: new Date("2026-06-01") })).toBe(true);
    expect(evaluate(c, { d: new Date("2025-12-31") })).toBe(false);
  });
  it("OLDER_THAN_DAYS", () => {
    const longAgo = new Date();
    longAgo.setUTCDate(longAgo.getUTCDate() - 100);
    const c: Clause = { field: "createdAt", op: "OLDER_THAN_DAYS", value: 60 };
    expect(evaluate(c, { createdAt: longAgo })).toBe(true);
    const recent = new Date();
    recent.setUTCDate(recent.getUTCDate() - 30);
    expect(evaluate(c, { createdAt: recent })).toBe(false);
  });
  it("WITHIN_LAST_DAYS", () => {
    const recent = new Date();
    recent.setUTCDate(recent.getUTCDate() - 5);
    const c: Clause = { field: "createdAt", op: "WITHIN_LAST_DAYS", value: 30 };
    expect(evaluate(c, { createdAt: recent })).toBe(true);
    const old = new Date();
    old.setUTCDate(old.getUTCDate() - 60);
    expect(evaluate(c, { createdAt: old })).toBe(false);
  });
});

describe("evaluate: null handling", () => {
  it("IS_NULL on null and undefined", () => {
    const c: Clause = { field: "x", op: "IS_NULL" };
    expect(evaluate(c, { x: null })).toBe(true);
    expect(evaluate(c, {})).toBe(true);
    expect(evaluate(c, { x: 0 })).toBe(false);
    expect(evaluate(c, { x: "" })).toBe(false);
  });
  it("IS_NOT_NULL", () => {
    const c: Clause = { field: "x", op: "IS_NOT_NULL" };
    expect(evaluate(c, { x: 1 })).toBe(true);
    expect(evaluate(c, { x: null })).toBe(false);
  });
  it("EQ against null field is false (matches SQL semantics)", () => {
    const c: Clause = { field: "x", op: "EQ", value: "y" };
    expect(evaluate(c, { x: null })).toBe(false);
  });
  it("NEQ against null field returns true when comparing to non-null", () => {
    const c: Clause = { field: "x", op: "NEQ", value: "y" };
    expect(evaluate(c, { x: null })).toBe(true);
  });
});

describe("evaluate: STARTS_WITH / CONTAINS", () => {
  it("STARTS_WITH matches", () => {
    const c: Clause = { field: "vendor", op: "STARTS_WITH", value: "AT&T" };
    expect(evaluate(c, { vendor: "AT&T Mobility" })).toBe(true);
    expect(evaluate(c, { vendor: "Verizon" })).toBe(false);
  });
  it("CONTAINS matches", () => {
    const c: Clause = { field: "memo", op: "CONTAINS", value: "wire" };
    expect(evaluate(c, { memo: "ACH wire payment" })).toBe(true);
    expect(evaluate(c, { memo: "check 1042" })).toBe(false);
  });
  it("STARTS_WITH on non-string returns false (no throw)", () => {
    const c: Clause = { field: "x", op: "STARTS_WITH", value: "abc" };
    expect(evaluate(c, { x: 123 })).toBe(false);
  });
});

describe("evaluate: boolean composition", () => {
  it("AND with all matching", () => {
    const c: Clause = {
      op: "AND",
      clauses: [
        { field: "status", op: "EQ", value: "OPEN" },
        { field: "amount", op: "GT", value: 100 },
      ],
    };
    expect(evaluate(c, { status: "OPEN", amount: 500 })).toBe(true);
    expect(evaluate(c, { status: "OPEN", amount: 50 })).toBe(false);
  });
  it("empty AND is vacuously true (catch-all rule)", () => {
    const c: Clause = { op: "AND", clauses: [] };
    expect(evaluate(c, {})).toBe(true);
  });
  it("OR matches if any clause matches", () => {
    const c: Clause = {
      op: "OR",
      clauses: [
        { field: "amount", op: "GT", value: 100000 },
        { field: "bookCode", op: "EQ", value: "US_TAX" },
      ],
    };
    expect(evaluate(c, { amount: 50000, bookCode: "US_TAX" })).toBe(true);
    expect(evaluate(c, { amount: 200000, bookCode: "US_GAAP" })).toBe(true);
    expect(evaluate(c, { amount: 50, bookCode: "US_GAAP" })).toBe(false);
  });
  it("empty OR is vacuously false", () => {
    expect(evaluate({ op: "OR", clauses: [] }, {})).toBe(false);
  });
  it("NOT inverts", () => {
    const c: Clause = {
      op: "NOT",
      clauses: [{ field: "status", op: "EQ", value: "OPEN" }],
    };
    expect(evaluate(c, { status: "CLOSED" })).toBe(true);
    expect(evaluate(c, { status: "OPEN" })).toBe(false);
  });
  it("NOT with wrong clause count throws", () => {
    const c: Clause = {
      op: "NOT",
      clauses: [
        { field: "a", op: "EQ", value: 1 },
        { field: "b", op: "EQ", value: 2 },
      ],
    };
    expect(() => evaluate(c, {})).toThrow(EvaluatorError);
  });
  it("nested: (A AND (B OR C))", () => {
    const c: Clause = {
      op: "AND",
      clauses: [
        { field: "status", op: "EQ", value: "OPEN" },
        {
          op: "OR",
          clauses: [
            { field: "amount", op: "GT", value: 10000 },
            { field: "priority", op: "EQ", value: "HIGH" },
          ],
        },
      ],
    };
    expect(evaluate(c, { status: "OPEN", amount: 50000, priority: "LOW" })).toBe(true);
    expect(evaluate(c, { status: "OPEN", amount: 100, priority: "HIGH" })).toBe(true);
    expect(evaluate(c, { status: "OPEN", amount: 100, priority: "LOW" })).toBe(false);
    expect(evaluate(c, { status: "CLOSED", amount: 100000, priority: "HIGH" })).toBe(false);
  });
});

describe("evaluate: realistic ERP scenarios", () => {
  it("AR aging escalate-to-senior at 60-90 days", () => {
    const c: Clause = {
      op: "AND",
      clauses: [
        { field: "status", op: "EQ", value: "OPEN" },
        { field: "daysOverdue", op: "GT", value: 60 },
        { field: "daysOverdue", op: "LTE", value: 90 },
        { field: "amount", op: "GT", value: 1000 },
      ],
    };
    expect(evaluate(c, { status: "OPEN", daysOverdue: 75, amount: 5000 })).toBe(true);
    expect(evaluate(c, { status: "OPEN", daysOverdue: 100, amount: 5000 })).toBe(false);
    expect(evaluate(c, { status: "OPEN", daysOverdue: 75, amount: 500 })).toBe(false);
  });
  it("Large-amount JE routes to Controller", () => {
    const c: Clause = {
      op: "OR",
      clauses: [
        { field: "totalDebits", op: "GT", value: 100000 },
        { field: "bookCode", op: "EQ", value: "US_TAX" },
      ],
    };
    expect(evaluate(c, { totalDebits: 200000, bookCode: "US_GAAP" })).toBe(true);
    expect(evaluate(c, { totalDebits: 5000, bookCode: "US_TAX" })).toBe(true);
    expect(evaluate(c, { totalDebits: 5000, bookCode: "US_GAAP" })).toBe(false);
  });
  it("Joined customer field: high-credit-rating customer gets fast-track", () => {
    const c: Clause = {
      op: "AND",
      clauses: [
        { field: "amount", op: "GT", value: 50000 },
        { field: "customer.creditRating", op: "IN", value: ["AAA", "AA"] },
      ],
    };
    expect(
      evaluate(c, { amount: 100000, customer: { creditRating: "AAA" } })
    ).toBe(true);
    expect(
      evaluate(c, { amount: 100000, customer: { creditRating: "BBB" } })
    ).toBe(false);
    expect(evaluate(c, { amount: 100000, customer: null })).toBe(false);
  });
});
