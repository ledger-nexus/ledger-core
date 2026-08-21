// A header must sit over its own numbers.
//
// Alignment in this codebase is declared PER CELL — 183 hand-written
// `text-right` classes across 43 files and 54 `<Table>` blocks. Nothing ties a
// `<TH>` to the `<TD>`s beneath it, so they drift: this scan found three
// columns whose header was left-aligned above a right-aligned number column
// (`/recurring-entries` Lines and Due, `/recurring-entries/[id]` Line). All
// three are fixed; this keeps them fixed.
//
// ⚠️ THE REAL FIX IS THE CONTRACT, NOT THIS TEST. `<DataTable>` derives both
// cells from one `align` declaration, which makes the mismatch unrepresentable
// rather than merely detected. This guard covers the 53 tables still written
// by hand, and should shrink as they migrate.
//
// ⚠️ THE FIRST VERSION OF THIS SCAN OVER-REPORTED 2 OF 5. A `<TH className=
// "text-right">` above a cell whose `<Input className="text-right">` fills it
// is aligned; and a header built by `.map()` above a `colSpan` spacer row has
// no position-wise correspondence at all. Both are handled structurally below
// rather than by an allowlist, because an allowlist of "known fine" sites is a
// place for a real defect to be filed away. That makes four scanner patterns
// this codebase has caught being narrower or wider than the language — see
// tests/tenant-scope-guard.test.ts for the previous three.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (e.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const RIGHT = /text-right/;

/** Top-level `<TH …>` openings, in order, with their attribute text. */
function cellOpenings(chunk: string, tag: "TH" | "TD"): { attrs: string; body: string }[] {
  const re = new RegExp(`<${tag}(\\s[^>]*?)?/?>`, "g");
  const out: { attrs: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) {
    const close = chunk.indexOf(`</${tag}>`, re.lastIndex);
    out.push({
      attrs: m[1] ?? "",
      body: chunk.slice(re.lastIndex, close === -1 ? undefined : close),
    });
  }
  return out;
}

interface Mismatch {
  file: string;
  block: number;
  column: number;
  head: string;
  cell: string;
}

function scan(): Mismatch[] {
  const found: Mismatch[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(path.join(__dirname, ".."), file);
    const blocks = src.split(/<Table(?:\s[^>]*)?>/).slice(1);

    for (const [bi, rest] of blocks.entries()) {
      const end = rest.indexOf("</Table>");
      const block = end === -1 ? rest : rest.slice(0, end);

      const hIdx = block.indexOf("<THead>");
      const bIdx = block.indexOf("<TBody>");
      if (hIdx === -1 || bIdx === -1) continue;
      const head = block.slice(hIdx, bIdx);
      const body = block.slice(bIdx);

      // A header assembled by `.map()` has no fixed column count, so nothing
      // here corresponds position-wise. Those tables are exactly the ones a
      // column spec should own; a positional scan cannot judge them.
      if (head.includes(".map(")) continue;

      const firstTR = body.indexOf("<TR");
      if (firstTR === -1) continue;
      const trEnd = body.indexOf("</TR>", firstTR);
      const row = body.slice(firstTR, trEnd === -1 ? undefined : trEnd);

      // A spanning row (spacer, section header, totals) is not one cell per
      // column by construction.
      if (row.includes("colSpan")) continue;

      const ths = cellOpenings(head, "TH");
      const tds = cellOpenings(row, "TD");
      if (!ths.length || !tds.length || ths.length !== tds.length) continue;

      for (let i = 0; i < ths.length; i++) {
        const headRight = RIGHT.test(ths[i].attrs);
        // The CELL counts as right-aligned if its own class says so or if the
        // control filling it does — a right-aligned `<Input>` in a form cell
        // is aligned under a right-aligned header.
        const cellRight = RIGHT.test(tds[i].attrs) || RIGHT.test(tds[i].body);
        if (headRight !== cellRight) {
          found.push({
            file: rel,
            block: bi,
            column: i,
            head: ths[i].attrs.trim(),
            cell: tds[i].attrs.trim(),
          });
        }
      }
    }
  }
  return found;
}

describe("table column alignment", () => {
  it("scans a meaningful number of tables (the guard is not vacuously green)", () => {
    // A positive control. If a refactor renamed `<Table>` or `<THead>`, this
    // scan would find nothing and pass while checking nothing — the failure
    // mode an empty result always has.
    const tables = sourceFiles(SRC).reduce(
      (n, f) => n + (fs.readFileSync(f, "utf8").split(/<Table(?:\s[^>]*)?>/).length - 1),
      0
    );
    expect(tables).toBeGreaterThan(40);
  });

  it("has no header aligned differently from its own column", () => {
    const found = scan();
    const report = found
      .map((m) => `${m.file} block#${m.block} col${m.column}  TH[${m.head}] / TD[${m.cell}]`)
      .join("\n");
    expect(found, `Header/column alignment mismatch:\n${report}`).toEqual([]);
  });
});
