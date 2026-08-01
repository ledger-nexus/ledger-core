// The control matrix is an evidence map an auditor spot-checks. Its
// entire value is that the citations resolve — a matrix with dead paths
// is worse than no matrix, because the first bad path teaches the
// auditor to hand-verify everything else in the document.
//
// Version 1.0 shipped with four dead citations. They went stale not
// because anyone was careless but because the code moved and the
// document didn't: an action migrated from src/app/actions/ to
// src/lib/, a backfill script was never landed under the name it was
// promised by. That is the normal fate of a hand-maintained evidence
// map, and it is exactly what a test prevents.
//
// So: every repo-relative path cited in the matrix must exist. Move a
// file, and CI tells you which control just lost its evidence.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");
const MATRIX = join(REPO_ROOT, "docs/SOC2_CONTROL_MATRIX.md");

/** Companion repos can't be checked from here; the matrix says so. */
const CROSS_REPO_PREFIXES = [
  "integrations/",
  "recon/",
  "revenue-rec/",
  "fa-amort/",
];

/**
 * Anything in backticks that looks like a source path. Deliberately
 * conservative: it must carry a known code/doc extension, so prose in
 * backticks (`tenantId`, `POSTED`, `requirePermitted`) is ignored.
 */
function citedPaths(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    if (/^[\w./@-]+\.(ts|tsx|sql|md|js|mjs|json|sh|yml|yaml)$/.test(raw)) {
      out.add(raw);
    }
  }
  return [...out].sort();
}

describe("SOC 2 control matrix", () => {
  const markdown = readFileSync(MATRIX, "utf8");
  const paths = citedPaths(markdown);

  it("cites a meaningful number of paths (guards against the regex silently matching nothing)", () => {
    // If a future edit reformats the matrix away from backticked paths,
    // every other assertion here would pass vacuously.
    expect(paths.length).toBeGreaterThan(30);
  });

  it("every cited repo-relative path resolves", () => {
    const dead = paths.filter((p) => {
      if (CROSS_REPO_PREFIXES.some((prefix) => p.startsWith(prefix))) {
        return false;
      }
      return !existsSync(join(REPO_ROOT, p));
    });
    expect(
      dead,
      `Dead citations in docs/SOC2_CONTROL_MATRIX.md — an auditor following ` +
        `these finds nothing. Fix the path or drop the row:\n  ${dead.join("\n  ")}`
    ).toEqual([]);
  });

  it("discloses that the system is not yet deployed", () => {
    // The single most misleading thing this document could do is present
    // designed-but-never-operated controls as operating. If someone
    // removes the preamble, that disclosure has to fail loudly.
    expect(markdown).toMatch(/never served a real user|not deployed/i);
  });

  it("discloses that RLS is enabled but not FORCEd", () => {
    // "RLS enabled" reads as database-enforced isolation. It isn't —
    // the app's role owns the tables and bypasses every policy. The
    // matrix must keep saying so for as long as it stays true.
    expect(markdown).toMatch(/0 forced|not FORCE|inert/i);
  });

  it("carries a version and an effective date", () => {
    expect(markdown).toMatch(/\*\*Version:\*\*\s*\d+\.\d+/);
    expect(markdown).toMatch(/\*\*Effective date:\*\*\s*\d{4}-\d{2}-\d{2}/);
  });
});
