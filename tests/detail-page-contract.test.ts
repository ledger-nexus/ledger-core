// Every field shows, even when null.
//
// §5 of docs/design/campfire-product-surface.md, and the rule that most needs
// a guard rather than a convention, because the shape that breaks it —
// `{value && <Field … />}` — is the natural thing to type and looks tidier
// than the alternative. It is not tidier. It makes two different situations
// render identically: "this entry has not been reversed", and "this screen
// does not show reversals". On an accounting document the first is a fact a
// reviewer needs stated.
//
// Six such guards existed across the three detail pages when this landed:
// two on the journal entry (Source record ID, Mapping version), four more
// wrapping its lineage relationships, and one `{row.actor && <>…</>}` on the
// audit-log detail hiding two fields at once.
//
// ⚠️ A TERNARY IS NOT A COLLAPSE, and this guard deliberately does not flag
// one. `{row.resource ? <FieldGrid…/> : <p>No resource attached…</p>}` on the
// audit-log page renders an explanation in place of the fields — the reader
// still learns what is going on. `&&` renders NOTHING. The distinction is the
// whole rule, so the scanner encodes it rather than exempting the file.
//
// ⚠️ Scanner discipline (four of these have been wrong in this codebase; see
// tests/tenant-scope-guard.test.ts and tests/table-alignment-guard.test.ts):
// this one matches on PARENS rather than braces, because braces appear inside
// JSX expressions constantly and parens almost never appear in JSX prose. It
// also carries a positive control, because a scanner that finds nothing
// because it is looking for the wrong token passes silently forever.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (e.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Files that render fields — i.e. the pages this contract governs. */
function fieldPages(): string[] {
  return sourceFiles(SRC).filter((f) => {
    const s = fs.readFileSync(f, "utf8");
    return /<Field[\s/>]/.test(s) && !f.endsWith("field-grid.tsx");
  });
}

const FIELD = /<(?:Lineage)?Field[\s/>]/;

interface Collapse {
  file: string;
  line: number;
  guard: string;
}

/**
 * `{expr && ( … )}` blocks, and single-line `{expr && <Field … />}`, whose
 * body renders a field.
 */
function collapses(src: string, rel: string): Collapse[] {
  const found: Collapse[] = [];
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    // Single-line form.
    if (/&&\s*<(?:Lineage)?Field[\s/>]/.test(line)) {
      found.push({ file: rel, line: i + 1, guard: line.trim().slice(0, 70) });
      return;
    }
    // Multi-line form: `{expr && (` opening a paren that closes at `)}`.
    const open = line.match(/\{[^{}]*&&\s*\(\s*$/);
    if (!open) return;

    // Walk forward counting parens from the one this line opened.
    let depth = 0;
    let body = "";
    for (let j = i; j < lines.length; j++) {
      const from = j === i ? line.lastIndexOf("(") : 0;
      for (let k = from; k < lines[j].length; k++) {
        const ch = lines[j][k];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            if (FIELD.test(body)) {
              found.push({ file: rel, line: i + 1, guard: line.trim().slice(0, 70) });
            }
            return;
          }
        }
      }
      body += lines[j] + "\n";
    }
  });

  return found;
}

describe("detail-page field contract", () => {
  it("finds the pages that render fields (the guard is not vacuously green)", () => {
    // A positive control. If `<Field>` were renamed, this scan would find no
    // files, report no collapses, and pass while checking nothing.
    const pages = fieldPages();
    expect(pages.length).toBeGreaterThanOrEqual(3);
  });

  it("can see a collapse when there is one (the scanner works)", () => {
    // The scanner run against a known-bad sample, so a green result on the
    // real files means "no collapses" and not "the pattern never matches".
    const sample = [
      "<FieldGrid>",
      "  <Field label=\"Kept\" value={x} />",
      "  {entry.sourceRecordId && (",
      "    <Field label=\"Source record ID\" value={entry.sourceRecordId} />",
      "  )}",
      "  {entry.mappingVersion && <Field label=\"Mapping version\" value={v} />}",
      "</FieldGrid>",
    ].join("\n");
    expect(collapses(sample, "sample.tsx")).toHaveLength(2);
  });

  it("does not flag a ternary, which renders an alternative rather than nothing", () => {
    const sample = [
      "{row.resource ? (",
      "  <FieldGrid>",
      "    <Field label=\"Type\" value={row.resource} />",
      "  </FieldGrid>",
      ") : (",
      "  <p>No resource attached.</p>",
      ")}",
    ].join("\n");
    expect(collapses(sample, "sample.tsx")).toEqual([]);
  });

  it("has no field hidden behind a `&&` guard", () => {
    const found = fieldPages().flatMap((f) =>
      collapses(fs.readFileSync(f, "utf8"), path.relative(ROOT, f))
    );
    const report = found.map((c) => `${c.file}:${c.line}  ${c.guard}`).join("\n");
    expect(found, `Field collapsed when empty — use <Field value={…}/>, which renders a dash:\n${report}`).toEqual([]);
  });

  it("no page defines its own Field component any more", () => {
    // Three existed, with three signatures and three visual treatments, and
    // the never-blank rule implemented in exactly one of them.
    const local = fieldPages().filter((f) => /function Field\b/.test(fs.readFileSync(f, "utf8")));
    expect(local.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
