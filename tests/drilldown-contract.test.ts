// The drill-down contract: a report cell links to the lines behind it.
//
// This is the payoff phase 0 was built for. Because the transactions surface
// keeps its whole state in the URL, "show me what makes up this number" is an
// `<a href>` — no modal, no shared client store, no endpoint. The link is built
// by one function so the report and the destination cannot disagree about
// parameter names.
//
// Two things are worth pinning, and only one of them is about strings.
//
// ⚠️ SUBTOTAL ROWS MUST NOT DRILL. A group row's amount is the sum of its
// children, so a link filtered to the group's own account code opens a list
// whose total does not match the number that was clicked. That is the specific
// way a drill-down loses a reader's trust: not by failing, by disagreeing. The
// income statement gates on `isGroup`; this file pins the reason in a place
// someone refactoring the tree will read.
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseUrlState, defaultsOf } from "@/lib/url-state";
import { TRANSACTIONS_SPEC, transactionsHref } from "@/lib/surfaces/transactions";

const ROOT = path.join(__dirname, "..");

describe("drill-down href", () => {
  it("round-trips into exactly the filter the cell described", () => {
    const href = transactionsHref({
      accountCode: "4010",
      from: "2026-04-01",
      to: "2026-06-30",
    });
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/transactions");

    const state = parseUrlState(TRANSACTIONS_SPEC, Object.fromEntries(url.searchParams));
    expect(state.account).toBe("4010");
    expect(state.from).toBe("2026-04-01");
    expect(state.to).toBe("2026-06-30");
    // Lands on page 1 with no stray search — a drill-down is a fresh question.
    expect(state.page).toBe(1);
    expect(state.q).toBe("");
  });

  it("carries the account CODE and never a display name", () => {
    // Campfire's URL carries `account=2001&accountName=Usage-BasedRevenue` —
    // two sources of truth for one fact, and the name is the half that drifts
    // when an account is renamed. See campfire-product-surface.md §13.
    const href = transactionsHref({ accountCode: "4010", from: "2026-01-01", to: "2026-12-31" });
    expect(href).toContain("account=4010");
    expect(href.toLowerCase()).not.toContain("name");
  });

  it("omits parameters left at their defaults", () => {
    // A drill-down over the surface's default period is just ?account=…, not a
    // link pasting the whole default state.
    const d = defaultsOf(TRANSACTIONS_SPEC);
    const href = transactionsHref({ accountCode: "1000", from: d.from, to: d.to });
    expect(href).toBe("/transactions?account=1000");
  });

  it("degrades on a malformed period instead of throwing", () => {
    // A caller passing a bad date gets a wider range, not a 500.
    const href = transactionsHref({ accountCode: "1000", from: "not-a-date", to: "2026-06-30" });
    const state = parseUrlState(
      TRANSACTIONS_SPEC,
      Object.fromEntries(new URL(href, "http://x").searchParams)
    );
    expect(state.from).toBe(defaultsOf(TRANSACTIONS_SPEC).from);
    expect(state.to).toBe("2026-06-30");
  });
});

describe("the income statement's use of it", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "app", "reports", "income-statement", "page.tsx"),
    "utf8"
  );

  it("builds links through the shared helper, not by hand", () => {
    // A hand-built `/transactions?account=${code}` here would work today and
    // silently stop matching the moment the spec renames a parameter — which
    // is the whole reason the spec is a module.
    expect(src).toContain("transactionsHref(");
    expect(src).not.toMatch(/["'`]\/transactions\?/);
  });

  it("gates the drill-down on a leaf row", () => {
    // Pins the subtotal rule described in this file's header. If someone
    // removes the guard, this fails and the comment explains why it exists.
    expect(src).toMatch(/isGroup \?[\s\S]{0,120}formatMoney/);
    expect(src).toContain("DrilldownAmount");
  });

  it("gives the link an accessible name, not just an amount", () => {
    // "$1,234.00" as a link name tells a screen-reader user nothing about
    // where it goes.
    const comp = fs.readFileSync(
      path.join(ROOT, "src", "components", "ui", "drilldown-amount.tsx"),
      "utf8"
    );
    expect(comp).toContain("aria-label");
    expect(comp).toContain("Show transactions for");
  });
});
