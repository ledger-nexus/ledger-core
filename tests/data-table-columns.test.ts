// The column contract.
//
// Pure — no database, no rendering. The properties worth pinning are the ones
// that decide what a hand-edited or stale URL does, because a column choice is
// a URL parameter and therefore something a person can type, bookmark, share,
// and store in a saved view that outlives the column it names.
//
// The one that matters most: `?cols=` can never produce a table with no
// columns. A saved view from before a column was renamed, a truncated link, a
// typo — each of those must land on the default table, not on a header row
// with nothing underneath it.

import { describe, it, expect } from "vitest";

import {
  columnsParam,
  defaultVisible,
  duplicateKeys,
  resolveVisible,
  serializeVisible,
  toggleVisible,
  type ColumnMeta,
} from "@/lib/surfaces/columns";
import { buildUrl, defaultsOf, parseUrlState } from "@/lib/url-state";
import { TRANSACTIONS_SPEC, TRANSACTION_COLUMNS, TRANSACTIONS_PATH } from "@/lib/surfaces/transactions";

/** A miniature surface: two required, two default-on, one opt-in. */
const COLS: ColumnMeta[] = [
  { key: "date", label: "Date", required: true },
  { key: "entry", label: "Entry", required: true },
  { key: "account", label: "Account" },
  { key: "amount", label: "Amount" },
  { key: "memo", label: "Memo", defaultHidden: true },
];

describe("defaultVisible", () => {
  it("is the declared order, minus the opt-in columns", () => {
    expect(defaultVisible(COLS)).toEqual(["date", "entry", "account", "amount"]);
  });
});

describe("resolveVisible", () => {
  it("returns the defaults when no parameter is present", () => {
    expect(resolveVisible(COLS, undefined)).toEqual(defaultVisible(COLS));
    expect(resolveVisible(COLS, "")).toEqual(defaultVisible(COLS));
    expect(resolveVisible(COLS, "  ,  , ")).toEqual(defaultVisible(COLS));
  });

  it("⚠️ keeps required columns even when the URL omits them", () => {
    // A link that hides both identity columns would render rows nobody can
    // tell apart. The parameter is not permitted to express that.
    expect(resolveVisible(COLS, "memo")).toEqual(["date", "entry", "memo"]);
  });

  it("⚠️ orders by the DECLARATION, not by the URL", () => {
    // Otherwise two links showing the same data render differently, and column
    // order becomes a feature that fell out of a parser instead of a design.
    expect(resolveVisible(COLS, "memo,amount,account")).toEqual([
      "date",
      "entry",
      "account",
      "amount",
      "memo",
    ]);
  });

  it("ignores keys it does not know, and keeps the ones it does", () => {
    expect(resolveVisible(COLS, "account,ghost,amount")).toEqual([
      "date",
      "entry",
      "account",
      "amount",
    ]);
  });

  it("⚠️ falls back to defaults when EVERY key is unknown", () => {
    // The stale-saved-view case: the view names columns that were renamed. The
    // required-columns rule alone would leave a two-column table and no hint
    // that anything was wrong; defaults are the honest recovery.
    expect(resolveVisible(COLS, "ghost,phantom")).toEqual(defaultVisible(COLS));
  });

  it("never returns an empty list, for any input", () => {
    for (const raw of ["", " ", ",", "ghost", "GHOST,,ghost", "date", "memo"]) {
      expect(resolveVisible(COLS, raw).length).toBeGreaterThan(0);
    }
  });
});

describe("serializeVisible", () => {
  it("omits the parameter entirely when the choice is the default", () => {
    // A table nobody has touched carries no column parameter, so a shared link
    // does not paste five redundant keys.
    expect(serializeVisible(COLS, defaultVisible(COLS))).toBeUndefined();
  });

  it("writes declared order regardless of the order it is handed", () => {
    expect(serializeVisible(COLS, ["memo", "date", "entry"])).toBe("date,entry,memo");
  });

  it("round-trips: resolve(serialize(v)) === v", () => {
    const picks = [
      ["date", "entry", "memo"],
      ["date", "entry", "account"],
      ["date", "entry", "account", "amount", "memo"],
    ];
    for (const v of picks) {
      const raw = serializeVisible(COLS, v);
      expect(resolveVisible(COLS, raw)).toEqual(v);
    }
  });
});

describe("toggleVisible", () => {
  it("turns a column on, in its declared position", () => {
    expect(toggleVisible(COLS, ["date", "entry", "amount"], "account")).toEqual([
      "date",
      "entry",
      "account",
      "amount",
    ]);
  });

  it("turns a column off", () => {
    expect(toggleVisible(COLS, defaultVisible(COLS), "amount")).toEqual([
      "date",
      "entry",
      "account",
    ]);
  });

  it("⚠️ is a no-op on a required column rather than an error", () => {
    // It feeds an <a href>. A link that renders a broken table is worse than a
    // link that renders the same table.
    const before = defaultVisible(COLS);
    expect(toggleVisible(COLS, before, "date")).toEqual(before);
  });

  it("⚠️ refuses to turn off the last visible column", () => {
    const bare: ColumnMeta[] = [
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ];
    expect(toggleVisible(bare, ["a"], "a")).toEqual(["a"]);
    expect(toggleVisible(bare, ["a", "b"], "b")).toEqual(["a"]);
  });

  it("ignores a key that is not a column", () => {
    const before = defaultVisible(COLS);
    expect(toggleVisible(COLS, before, "ghost")).toEqual(before);
  });
});

describe("columnsParam, through the url-state machinery", () => {
  const SPEC = { cols: columnsParam(COLS) };

  it("reads and writes through parseUrlState / buildUrl", () => {
    const state = parseUrlState(SPEC, { cols: "memo" });
    expect(state.cols).toEqual(["date", "entry", "memo"]);
    expect(buildUrl("/x", SPEC, state)).toBe("/x?cols=date%2Centry%2Cmemo");
  });

  it("a default surface has no query string at all", () => {
    expect(buildUrl("/x", SPEC, defaultsOf(SPEC))).toBe("/x");
  });

  it("shows no chip — a hidden column is not a filter", () => {
    // Chips answer "why am I seeing fewer ROWS than I expect". Columns do not
    // change the row count, so a chip there would mislead.
    expect(SPEC.cols.chip?.(["date"])).toBeNull();
  });
});

describe("the transactions surface's own columns", () => {
  it("has no duplicate keys", () => {
    // A duplicate silently drops a column from the picker.
    expect(duplicateKeys(TRANSACTION_COLUMNS)).toEqual([]);
  });

  it("declares at least one required column", () => {
    expect(TRANSACTION_COLUMNS.some((c) => c.required)).toBe(true);
  });

  it("keeps the drill-down href free of a column parameter", () => {
    // The income statement builds `/transactions?account=…`. Adding `cols` to
    // the spec must not start appending nine column keys to every drill-down.
    const url = buildUrl(TRANSACTIONS_PATH, TRANSACTIONS_SPEC, {
      ...defaultsOf(TRANSACTIONS_SPEC),
      account: "4000",
    });
    expect(url).toBe("/transactions?account=4000");
    expect(url).not.toContain("cols");
  });

  it("every key survives a round-trip through the URL", () => {
    for (const col of TRANSACTION_COLUMNS) {
      const visible = resolveVisible(TRANSACTION_COLUMNS, col.key);
      expect(visible).toContain(col.key);
    }
  });
});
