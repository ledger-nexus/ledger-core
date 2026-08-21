// A page that renders a table should not fetch an unbounded number of rows.
//
// The survey behind #383 counted **46 `findMany` calls with no `take`, across
// 26 pages that render a table**. Most are fine — a tenant has five entities,
// three books, twenty-four periods, and a handful of users, so reading all of
// them is correct and paging them would be silly. The ones that matter are the
// queries over tables that grow with business activity: journal lines, open
// AR/AP items, bank transactions.
//
// ⚠️ WHICH MODELS ARE "VOLUME-BEARING" IS NOT DERIVABLE FROM THE SCHEMA, and a
// hand-written list of them is the failure mode this codebase keeps finding:
// it never fails, it just quietly stops covering whatever was added after it.
// So this guard does not classify models at all. It records TODAY'S unbounded
// sites as a baseline and fails on new ones, the same ratchet as
// tests/tenant-scope-guard.test.ts. Judgement about whether a given site needs
// paging belongs to whoever adds it — the guard's job is to make sure someone
// is asked.
//
// To fix a site: add `take` (and a <Pagination/>), then run
// `UPDATE_UNBOUNDED_LIST_BASELINE=1 npx vitest run tests/unbounded-list-query-guard.test.ts`
// so the baseline shrinks. It is not allowed to grow silently in either
// direction — a stale entry fails too.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "src", "app");
const BASELINE = path.join(__dirname, "fixtures", "unbounded-list-baseline.json");

type Site = string; // "<page path>::<model>.findMany"

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...pageFiles(full));
    else if (e.name === "page.tsx") out.push(full);
  }
  return out;
}

/** The balanced `{...}` starting at `from`. */
function balanced(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

function scan(): { unbounded: Site[]; pages: number; calls: number } {
  const unbounded: Site[] = [];
  let pages = 0;
  let calls = 0;

  for (const file of pageFiles(APP)) {
    const src = fs.readFileSync(file, "utf8");
    // Only pages that actually render rows. A page that fetches a list to
    // build a <select> is not the concern.
    if (!/<Table\b|<DataTable\b/.test(src)) continue;
    pages++;
    const rel = path.relative(path.join(ROOT, "src", "app"), file);

    for (const m of src.matchAll(/prisma\.(\w+)\.findMany\(\s*\{/g)) {
      calls++;
      const args = balanced(src, src.indexOf("{", m.index + m[0].length - 1));
      // `take` anywhere in the call's own argument object. A nested `take`
      // inside a relation `select` would be a false negative here; none exist
      // today, and the baseline would catch the site anyway.
      if (/\btake\s*:/.test(args)) continue;
      unbounded.push(`${rel}::${m[1]}.findMany`);
    }
  }
  return { unbounded: [...new Set(unbounded)].sort(), pages, calls };
}

describe("unbounded list queries", () => {
  const { unbounded, pages, calls } = scan();

  it("finds the pages and the calls at all", () => {
    // Guards the guard. If `page.tsx` were renamed, or the prisma client
    // variable were, this scan would find nothing and pass forever while
    // checking nothing — the empty-result failure this codebase has hit
    // repeatedly. See tests/table-alignment-guard.test.ts for the same note.
    expect(pages).toBeGreaterThan(20);
    expect(calls).toBeGreaterThan(40);
  });

  it("adds no new page that reads a whole table", () => {
    const baseline: Site[] = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

    if (process.env.UPDATE_UNBOUNDED_LIST_BASELINE === "1") {
      fs.writeFileSync(BASELINE, JSON.stringify(unbounded, null, 2) + "\n");
      return;
    }

    const added = unbounded.filter((s) => !baseline.includes(s));
    expect(
      added,
      "new unbounded list query — add `take` + <Pagination/>, or record why it is bounded in practice"
    ).toEqual([]);
  });

  it("keeps the baseline honest as sites get paged", () => {
    // Without this the baseline never shrinks and stops describing the code.
    if (process.env.UPDATE_UNBOUNDED_LIST_BASELINE === "1") return;
    const baseline: Site[] = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const stale = baseline.filter((s) => !unbounded.includes(s));
    expect(stale, "baseline entries no longer present — re-run with UPDATE_UNBOUNDED_LIST_BASELINE=1").toEqual([]);
  });

  it("⚠️ the AR and AP worklists are paged", () => {
    // Named explicitly rather than left to the baseline, because these two are
    // the reason the guard exists: they are the surfaces whose row count grows
    // with how much the business is owed, which is not a bound.
    expect(unbounded).not.toContain("ar/page.tsx::arOpenItem.findMany");
    expect(unbounded).not.toContain("ap/page.tsx::apOpenItem.findMany");
  });
});
