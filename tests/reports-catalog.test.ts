// The reports catalog is a SECOND list of routes the nav already names.
//
// Second lists drift. `src/components/nav/catalog.ts` names every report so it
// is reachable from the sidebar; `src/lib/surfaces/reports-catalog.ts` adds the
// category and the sentence a card needs. Neither can be derived from the
// other — the nav has nowhere to put a description, and the catalog has no
// business owning sidebar order — so the guard is that they agree.
//
// Both directions matter, and they fail differently:
//   * in the catalog, not in the nav → a report reachable only by knowing the
//     URL of the catalog, which defeats the point of a front door
//   * in the nav, not in the catalog → a report the sidebar offers and the
//     catalog claims does not exist
//   * in either, with no route directory → a card that 404s
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_SECTIONS } from "@/components/nav/catalog";
import {
  CATEGORY_ORDER,
  REPORTS,
  populatedCategories,
  reportsByCategory,
} from "@/lib/surfaces/reports-catalog";

const ROOT = path.join(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "src", "app", "reports");

/** Report hrefs the sidebar offers, derived from the nav itself. */
function navReportHrefs(): string[] {
  return NAV_SECTIONS.flatMap((s) => s.items)
    .map((i) => i.href)
    .filter((h) => h.startsWith("/reports/"))
    .sort();
}

const catalogHrefs = () => REPORTS.map((r) => `/reports/${r.slug}`).sort();

describe("reports catalog", () => {
  it("finds both lists at all", () => {
    // Guards the guard: a rename of either module, or of the nav section,
    // would otherwise leave the comparisons below matching two empty lists.
    expect(REPORTS.length).toBeGreaterThan(8);
    expect(navReportHrefs().length).toBeGreaterThan(8);
  });

  it("every catalog entry resolves to a real route directory", () => {
    const missing = REPORTS.filter(
      (r) => !fs.existsSync(path.join(REPORTS_DIR, r.slug, "page.tsx"))
    ).map((r) => r.slug);
    expect(missing, "catalog entries with no page.tsx — these cards would 404").toEqual([]);
  });

  it("offers the same reports as the sidebar, in both directions", () => {
    const nav = navReportHrefs();
    const cat = catalogHrefs();
    expect(cat.filter((h) => !nav.includes(h)), "in the catalog, missing from the nav").toEqual([]);
    expect(nav.filter((h) => !cat.includes(h)), "in the nav, missing from the catalog").toEqual([]);
  });

  it("gives every report a description that is not just the title again", () => {
    // "Trial balance for the selected period" tells a reader nothing the title
    // did not. A description earns its place by saying when to open the thing.
    const weak = REPORTS.filter((r) => {
      const d = r.description.toLowerCase();
      return d.length < 40 || d.startsWith(r.title.toLowerCase() + " for");
    }).map((r) => r.slug);
    expect(weak, "descriptions that restate the title").toEqual([]);
  });

  it("renders no empty category tab", () => {
    // A tab that opens onto nothing reads as a broken feature, not an honest
    // gap. `populatedCategories` derives from the entries, so this holds as
    // categories are added and emptied.
    for (const c of populatedCategories()) {
      expect(reportsByCategory(c).length, `category ${c} is offered but empty`).toBeGreaterThan(0);
    }
  });

  it("assigns every report a category the tab strip knows", () => {
    const unknown = REPORTS.filter((r) => !CATEGORY_ORDER.includes(r.category)).map((r) => r.slug);
    expect(unknown, "reports whose category is not in CATEGORY_ORDER — unreachable by tab").toEqual([]);
  });

  it("has no duplicate slugs", () => {
    const slugs = REPORTS.map((r) => r.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });
});
