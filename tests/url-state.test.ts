// The URL is the state — the contract, and the convention it pins.
//
// Two halves:
//   1. Properties of `src/lib/url-state.ts` — round-trip, clean URLs, garbage
//      tolerance, and the chip/filter pairing that is the whole reason the
//      helper exists.
//   2. A convention guard over `src/app` asserting every query parameter is
//      camelCase. Campfire ships `start_date` on their transactions screen and
//      `startDate` on their income statement, in one product — see
//      docs/design/campfire-product-surface.md §13. An unpinned convention
//      does not stay consistent, it just stays unmeasured.
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  bool,
  buildUrl,
  defaultsOf,
  filterChips,
  int,
  isoDate,
  oneOf,
  parseUrlState,
  str,
  type SurfaceSpec,
} from "@/lib/url-state";

const ROOT = path.join(__dirname, "..");

/** A representative surface: one of every builder. */
const SPEC = {
  from: isoDate("2026-01-01", { chip: (v) => (v === "2026-01-01" ? null : `From ${v}`) }),
  to: isoDate("2026-12-31", { chip: (v) => (v === "2026-12-31" ? null : `To ${v}`) }),
  q: str("", { chip: (v) => (v ? `Search: ${v}` : null) }),
  status: oneOf(["all", "posted", "draft"] as const, "all", {
    chip: (v) => (v === "all" ? null : `Status: ${v}`),
  }),
  rollup: bool(false, { chip: (v) => (v ? "Rolled up" : null) }),
  page: int(1, { min: 1 }),
} satisfies SurfaceSpec;

describe("url-state: the contract", () => {
  it("an untouched surface has no query string at all", () => {
    // The clean-URL property. Campfire's own URLs carry redundant params
    // (`account=2001&accountName=Usage-BasedRevenue`); a link that pastes
    // twelve defaults is a link nobody reads.
    expect(buildUrl("/journal-entries", SPEC, defaultsOf(SPEC))).toBe("/journal-entries");
  });

  it("round-trips every non-default value through the URL", () => {
    const state = {
      from: "2026-04-01",
      to: "2026-06-30",
      q: "acme",
      status: "posted" as const,
      rollup: true,
      page: 3,
    };
    const href = buildUrl("/t", SPEC, state);
    const parsed = parseUrlState(SPEC, Object.fromEntries(new URL(href, "http://x").searchParams));
    expect(parsed).toEqual(state);
  });

  it("emits parameters in spec order, so equal state gives an identical string", () => {
    const a = buildUrl("/t", SPEC, { ...defaultsOf(SPEC), q: "x", page: 2 });
    const b = buildUrl("/t", SPEC, { ...defaultsOf(SPEC), page: 2, q: "x" });
    expect(a).toBe(b);
    expect(a).toBe("/t?q=x&page=2");
  });

  it("falls back to defaults on garbage rather than throwing", () => {
    // A hand-edited URL is a normal thing for a user to do. `page=NaN` must
    // not reach a database query, and a malformed date must not become an
    // Invalid Date that silently widens the range to everything.
    const parsed = parseUrlState(SPEC, {
      from: "not-a-date",
      to: "2026-13-45",
      status: "nonsense",
      page: "abc",
      rollup: "maybe",
    });
    expect(parsed).toEqual(defaultsOf(SPEC));
  });

  it("rejects an out-of-range page instead of clamping it silently", () => {
    expect(parseUrlState(SPEC, { page: "0" }).page).toBe(1);
    expect(parseUrlState(SPEC, { page: "-4" }).page).toBe(1);
  });

  it("takes the first value when a parameter is repeated", () => {
    expect(parseUrlState(SPEC, { q: ["first", "second"] }).q).toBe("first");
  });

  describe("chips", () => {
    it("shows one chip per non-default filter, and none at rest", () => {
      expect(filterChips("/t", SPEC, defaultsOf(SPEC), defaultsOf(SPEC))).toEqual([]);

      const state = { ...defaultsOf(SPEC), q: "acme", status: "posted" as const };
      const chips = filterChips("/t", SPEC, state, defaultsOf(SPEC));
      expect(chips.map((c) => c.label)).toEqual(["Search: acme", "Status: posted"]);
    });

    it("clearing one chip preserves every sibling filter", () => {
      // THE reason chips are derived from the spec rather than assembled per
      // page: a hand-written clear link forgets a sibling, and the bug shows
      // up as "clearing the search also reset my date range".
      const state = {
        from: "2026-04-01",
        to: "2026-06-30",
        q: "acme",
        status: "posted" as const,
        rollup: false,
        page: 1,
      };
      const chips = filterChips("/t", SPEC, state, defaultsOf(SPEC));
      const clearQ = chips.find((c) => c.key === "q")!;
      const after = parseUrlState(
        SPEC,
        Object.fromEntries(new URL(clearQ.clearHref, "http://x").searchParams)
      );
      expect(after.q).toBe("");
      expect(after.from).toBe("2026-04-01");
      expect(after.to).toBe("2026-06-30");
      expect(after.status).toBe("posted");
    });

    it("clearing a filter returns to page 1", () => {
      // A filtered page 7 that becomes an unfiltered page 7 is a confusing
      // place to land — usually an empty one.
      const state = { ...defaultsOf(SPEC), q: "acme", page: 7 };
      const chips = filterChips("/t", SPEC, state, defaultsOf(SPEC));
      const after = parseUrlState(
        SPEC,
        Object.fromEntries(new URL(chips[0].clearHref, "http://x").searchParams)
      );
      expect(after.page).toBe(1);
    });

    it("a filter with no chip is still applied — and that pairing is deliberate", () => {
      // `page` has no chip by design (it is not a filter). The guard is that
      // it still round-trips, i.e. "no chip" never means "not applied".
      const state = { ...defaultsOf(SPEC), page: 4 };
      expect(filterChips("/t", SPEC, state, defaultsOf(SPEC))).toEqual([]);
      expect(buildUrl("/t", SPEC, state)).toBe("/t?page=4");
    });
  });
});

// ─── The convention guard ─────────────────────────────────────────────────

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

describe("url parameter naming convention", () => {
  // Derived, not listed. A hand-written list of known parameters stops
  // covering the codebase the moment someone adds a page, and never fails —
  // it just quietly checks less.
  const reads = /searchParams(?:\??\.(\w+)|\[["'](\w+)["']\])/g;

  function paramNames(): { name: string; file: string }[] {
    const out: { name: string; file: string }[] = [];
    for (const file of walk(path.join(ROOT, "src", "app"))) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(reads)) {
        const name = m[1] ?? m[2];
        // `.get` is URLSearchParams' method, not a parameter name.
        if (!name || name === "get" || name === "has" || name === "getAll") continue;
        out.push({ name, file: path.relative(ROOT, file) });
      }
    }
    return out;
  }

  it("finds parameters to check at all", () => {
    // Guards the guard: a refactor that renames the `searchParams` prop would
    // otherwise leave the check below iterating an empty list and passing for
    // the wrong reason.
    expect(paramNames().length).toBeGreaterThan(20);
  });

  it("uses camelCase everywhere — no snake_case, no kebab-case", () => {
    const bad = paramNames()
      .filter(({ name }) => !/^[a-z][a-zA-Z0-9]*$/.test(name))
      .map(({ name, file }) => `${file}: ${name}`);
    expect([...new Set(bad)]).toEqual([]);
  });
});
