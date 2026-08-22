// No `deleteMany()` without a `where`.
//
// The test database is shared and persistent — CLAUDE.md says so, and every
// suite's self-healing `beforeAll` exists because of it. A `deleteMany()` with
// no filter does not clean up after a suite; it empties a table for everyone:
// every other suite's fixtures, every other tenant's rows, and whatever a
// developer had seeded to look at in the browser.
//
// ⚠️ THIS WAS NOT HYPOTHETICAL AND IT WAS NOT NEW.
//
//   * `tests/sub-ledgers.test.ts` did it, was diagnosed on 2026-07-16, and its
//     header still documents the fallout — including an FK failure from the
//     recon companion repo holding references to journal lines the global wipe
//     tried to delete. All 9 of its tests died in cleanup, not on the logic
//     under test.
//   * `tests/cash-flow.test.ts` did the same thing, from a `beforeEach`, and
//     was still doing it. Measured 2026-08-21: running that ONE file took the
//     Northwind dataset from JE=182 / AR=21 to 0 / 0 — while all five of its
//     tests passed.
//   * `src/lib/seed/northwind.ts` cleared `record_event` and
//     `reassignment_rule` for every tenant on each re-seed.
//
// The fix for the first one was applied to the file that was reported rather
// than to the class, which is the same shape as deficiency #32 and #33. This
// guard is the class.
//
// ⚠️ It is a source-shape check, so it cannot see `deleteMany(buildWhere())`
// where the helper returns `{}`. It catches the literal form, which is the
// form all eight real occurrences took.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const ROOTS = [path.join(ROOT, "src"), path.join(ROOT, "tests"), path.join(ROOT, "scripts")];

/** `deleteMany()`, `deleteMany({})`, `deleteMany( { } )` — no filter. */
const UNSCOPED = /\.deleteMany\(\s*(\{\s*\})?\s*\)/;

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(): { hits: Hit[]; files: number; deletes: number } {
  const hits: Hit[] = [];
  let files = 0;
  let deletes = 0;

  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      // ⚠️ This file contains the pattern as DATA — the positive control below
      // asserts the regex matches `deleteMany()` — so scanning itself reports
      // its own test strings. Excluding it is the narrow, honest fix; making
      // the control less literal would make it prove less.
      if (file === __filename) continue;
      files++;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\.deleteMany\(/.test(line)) return;
        deletes++;
        // A comment describing the hazard is not the hazard.
        const code = line.replace(/\/\/.*$/, "").trimStart();
        if (code.startsWith("*") || code.startsWith("//")) return;
        if (!UNSCOPED.test(code)) return;
        hits.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim().slice(0, 80) });
      });
    }
  }
  return { hits, files, deletes };
}

describe("unscoped deletes", () => {
  const { hits, files, deletes } = scan();

  it("finds the files and the delete calls at all", () => {
    // Guards the guard: if the scan roots or the Prisma call shape changed,
    // this would report nothing and pass while checking nothing.
    expect(files).toBeGreaterThan(300);
    expect(deletes).toBeGreaterThan(100);
  });

  it("matches the shapes it claims to, and not the ones it does not", () => {
    // A positive control on the PATTERN, so a green result means "no unscoped
    // deletes" rather than "the regex never matches".
    expect(UNSCOPED.test("await prisma.journalEntry.deleteMany();")).toBe(true);
    expect(UNSCOPED.test("await prisma.journalEntry.deleteMany({});")).toBe(true);
    expect(UNSCOPED.test("await prisma.journalEntry.deleteMany( { } );")).toBe(true);
    expect(UNSCOPED.test("await prisma.journalEntry.deleteMany({ where: { id } });")).toBe(false);
    expect(UNSCOPED.test("await prisma.journalEntry.deleteMany({ where });")).toBe(false);
  });

  it("⚠️ no delete runs without a filter", () => {
    const report = hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n");
    expect(
      hits,
      `deleteMany with no where — on a SHARED database this empties the table for every other suite, tenant and dev session:\n${report}`
    ).toEqual([]);
  });
});
