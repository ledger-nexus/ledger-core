// Pure-function unit tests for the account-hierarchy helper. No DB.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  buildHierarchy,
  flattenForDisplay,
  type FlatAccountRow,
} from "@/lib/accounting/account-hierarchy";

function row(
  code: string,
  parentCode: string | null,
  balance: number,
  opts: Partial<FlatAccountRow> = {}
): FlatAccountRow {
  return {
    code,
    name: `Account ${code}`,
    type: opts.type ?? "ASSET",
    parentCode,
    balance: new Decimal(balance),
    debit: new Decimal(balance > 0 ? balance : 0),
    credit: new Decimal(balance < 0 ? -balance : 0),
    isContra: opts.isContra ?? false,
    ...opts,
  };
}

describe("buildHierarchy — structure", () => {
  it("returns roots in code-ascending order", () => {
    const tree = buildHierarchy([
      row("3000", null, 0),
      row("1000", null, 0),
      row("2000", null, 0),
    ]);
    expect(tree.map((n) => n.code)).toEqual(["1000", "2000", "3000"]);
  });

  it("nests children under their parent", () => {
    const tree = buildHierarchy([
      row("1000", null, 0),
      row("1010", "1000", 100),
      row("1020", "1000", 200),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].code).toBe("1000");
    expect(tree[0].children.map((c) => c.code)).toEqual(["1010", "1020"]);
    expect(tree[0].hasChildren).toBe(true);
  });

  it("assigns correct depth at every level", () => {
    const tree = buildHierarchy([
      row("A", null, 0),
      row("B", "A", 0),
      row("C", "B", 100),
    ]);
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("an orphan (parent not in input) becomes a root", () => {
    const tree = buildHierarchy([row("X", "GHOST", 50)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].code).toBe("X");
    expect(tree[0].subtotalBalance.toNumber()).toBe(50);
  });
});

describe("buildHierarchy — subtotals", () => {
  it("a leaf's subtotal equals its own balance", () => {
    const tree = buildHierarchy([row("X", null, 42)]);
    expect(tree[0].subtotalBalance.toNumber()).toBe(42);
    expect(tree[0].ownBalance.toNumber()).toBe(42);
  });

  it("a parent's subtotal is its own balance plus children's subtotals", () => {
    // Parent has 50 of its own + two children with 100 and 200 → 350.
    const tree = buildHierarchy([
      row("P", null, 50),
      row("C1", "P", 100),
      row("C2", "P", 200),
    ]);
    expect(tree[0].ownBalance.toNumber()).toBe(50);
    expect(tree[0].subtotalBalance.toNumber()).toBe(350);
  });

  it("rolls up recursively across multiple levels", () => {
    // Tree:
    //   A (own = 1)
    //     B (own = 2)
    //       C (own = 4)
    //       D (own = 8)
    //     E (own = 16)
    // Total = 31.
    const tree = buildHierarchy([
      row("A", null, 1),
      row("B", "A", 2),
      row("C", "B", 4),
      row("D", "B", 8),
      row("E", "A", 16),
    ]);
    expect(tree[0].subtotalBalance.toNumber()).toBe(31);
    // B's subtotal = 2 + 4 + 8 = 14.
    const b = tree[0].children.find((c) => c.code === "B")!;
    expect(b.subtotalBalance.toNumber()).toBe(14);
  });

  it("subtotal Dr / Cr roll up independently", () => {
    // Parent: own debit 10, no credit. Child: no debit, credit 25.
    // Parent subtotal: debit 10, credit 25.
    const tree = buildHierarchy([
      {
        code: "P",
        name: "Parent",
        type: "ASSET",
        parentCode: null,
        balance: new Decimal(10),
        debit: new Decimal(10),
        credit: new Decimal(0),
        isContra: false,
      },
      {
        code: "C",
        name: "Child",
        type: "ASSET",
        parentCode: "P",
        balance: new Decimal(-25),
        debit: new Decimal(0),
        credit: new Decimal(25),
        isContra: false,
      },
    ]);
    expect(tree[0].subtotalDebit.toNumber()).toBe(10);
    expect(tree[0].subtotalCredit.toNumber()).toBe(25);
  });
});

describe("buildHierarchy — cycle detection", () => {
  it("throws on a direct cycle (A → B → A)", () => {
    expect(() =>
      buildHierarchy([row("A", "B", 0), row("B", "A", 0)])
    ).toThrow(/cycle/i);
  });

  it("throws on a longer cycle (A → B → C → A)", () => {
    expect(() =>
      buildHierarchy([
        row("A", "C", 0),
        row("B", "A", 0),
        row("C", "B", 0),
      ])
    ).toThrow(/cycle/i);
  });

  it("self-referential cycle is rejected", () => {
    expect(() => buildHierarchy([row("A", "A", 0)])).toThrow(/cycle/i);
  });
});

describe("flattenForDisplay", () => {
  it("returns depth-first preorder: each node BEFORE its children", () => {
    const tree = buildHierarchy([
      row("A", null, 0),
      row("B", "A", 0),
      row("C", "A", 0),
      row("D", "B", 100),
    ]);
    const flat = flattenForDisplay(tree);
    expect(flat.map((n) => n.code)).toEqual(["A", "B", "D", "C"]);
  });

  it("empty input returns empty list", () => {
    expect(flattenForDisplay([])).toEqual([]);
    expect(buildHierarchy([])).toEqual([]);
  });
});
