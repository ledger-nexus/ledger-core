// A query on a tenant-scoped model must say which tenant it means.
//
// WHY THIS EXISTS. #370 found `exportToNs` reading every tenant's dimensions;
// #371 found the QBO mapper doing the same and writing as well. Both were
// found by hand, one file at a time, and both had been sitting in a file
// whose own comment described the hazard. This guard is the thing that stops
// the next one needing a person to notice it.
//
// ⚠️ IT IS A RATCHET, NOT A GATE, and that is a deliberate concession to the
// measurement. 521 query sites in `src/` touch a tenant-scoped model; 68 of
// them carry an inline `where` that names no tenant. A guard that fails on
// all 68 would be turned off within a day. So the current set is recorded in
// a generated baseline and the assertion is "no NEW ones, and the old ones
// only go away". Fixing a site and forgetting to regenerate also fails —
// otherwise the baseline would quietly ossify.
//
// ⚠️ WHAT IT DOES NOT CLAIM. Only an inline object literal can be read here.
// `where: whereClause` and `where: tenantScopeOrNone(tenant?.id)` are both
// correctly scoped and both unreadable, so they are classified `indirect` and
// never counted. The first draft of this scanner took "the next `{` after
// `where:`" — which finds the `select:` block — and confidently reported 100
// unbounded sites. Two spot-checks killed that number. A third correction
// followed: a `where` bounded by a UUID foreign key (`statementId`,
// `entryId`) is transitively scoped, because that id was resolved upstream
// under a tenant filter and cannot be guessed. Counting those took the number
// from 100 to 53. Every one of those three passes made the tool report LESS,
// which is the direction a measurement usually does not move on its own.
//
// So: this catches the class where a query is bounded by something another
// tenant can hold — a code, a source record id, a boolean — or by nothing.
// That is exactly the class #370 and #371 were.
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const BASELINE = path.join(__dirname, "fixtures", "tenant-scope-baseline.json");

const READ_METHODS = ["findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy"];
const WRITE_METHODS = ["updateMany", "deleteMany"];

/** Models carrying a tenantId column — DERIVED, never listed by hand. */
function tenantScopedModels(): string[] {
  const schema = fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  const out: string[] = [];
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    if (/^\s*tenantId\s+/m.test(m[2])) out.push(m[1][0].toLowerCase() + m[1].slice(1));
  }
  return out.sort();
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

function balanced(s: string, start: number, open: string, close: string): string {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return s.slice(start, i + 1);
  }
  return "";
}

/** `file::model.method` — line numbers churn on every edit above them. */
type Site = string;

function scan(): { unbounded: Site[]; scanned: number; models: number } {
  const models = tenantScopedModels();
  const call = new RegExp(
    `\\b(?:prisma|tx|db|client)\\.(${models.join("|")})\\.(${[...READ_METHODS, ...WRITE_METHODS].join("|")})\\s*\\(`,
    "g"
  );

  const unbounded: Site[] = [];
  let scanned = 0;

  for (const file of walk(path.join(ROOT, "src"))) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    for (const m of src.matchAll(call)) {
      scanned++;
      const args = balanced(src, src.indexOf("(", m.index! + m[0].length - 1), "(", ")");
      const site: Site = `${rel}::${m[1]}.${m[2]}`;

      if (!/\S/.test(args.slice(1, -1))) {
        unbounded.push(site); // no arguments at all
        continue;
      }
      const wIdx = args.search(/\bwhere\s*:/);
      if (wIdx === -1) {
        unbounded.push(site); // no where clause
        continue;
      }
      // Only an inline literal is readable — see the header note.
      if (!args.slice(wIdx).replace(/^\s*where\s*:\s*/, "").startsWith("{")) continue;

      const where = balanced(args, args.indexOf("{", args.indexOf(":", wIdx)), "{", "}");
      const inner = where.slice(1, -1);
      if (/\btenantId\b/.test(inner)) continue;
      if (/^\s*id\s*:/.test(inner) || /\bid\s*:\s*\{\s*in\b/.test(inner)) continue; // primary key
      if (/\bentityId\b|\bentity\s*:/.test(inner)) continue; // entity-scoped
      if (/\b\w+Id\s*:/.test(inner)) continue; // transitively scoped via a UUID FK

      unbounded.push(site);
    }
  }
  return { unbounded: [...new Set(unbounded)].sort(), scanned, models: models.length };
}

describe("tenant scoping", () => {
  const { unbounded, scanned, models } = scan();

  it("finds the models and the call sites at all", () => {
    // Guards the guard. A rename of the Prisma client variable, or of the
    // schema's tenantId column, would otherwise leave every check below
    // iterating an empty list and passing for the wrong reason — the exact
    // failure #370 was made of.
    expect(models).toBeGreaterThan(40);
    expect(scanned).toBeGreaterThan(400);
  });

  it("adds no new query that names no tenant", () => {
    const baseline: Site[] = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

    if (process.env.UPDATE_TENANT_SCOPE_BASELINE === "1") {
      fs.writeFileSync(BASELINE, JSON.stringify(unbounded, null, 2) + "\n");
      return;
    }

    const added = unbounded.filter((s) => !baseline.includes(s));
    expect(added, "new unscoped query site(s) — add a tenantId filter").toEqual([]);
  });

  it("keeps the baseline honest as sites get fixed", () => {
    // Without this the baseline never shrinks: a site could be fixed, or the
    // file deleted, and the entry would sit there forever silently licensing
    // a future regression at the same location.
    const baseline: Site[] = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    if (process.env.UPDATE_TENANT_SCOPE_BASELINE === "1") return;

    const stale = baseline.filter((s) => !unbounded.includes(s));
    expect(
      stale,
      "baseline entries that no longer exist — re-run with UPDATE_TENANT_SCOPE_BASELINE=1"
    ).toEqual([]);
  });
});
