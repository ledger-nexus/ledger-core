#!/usr/bin/env tsx
// Verify CLAUDE.md consistency across the 5-repo portfolio.
//
// CC4 (Monitoring Activities) automation — parallel pattern to
// verify-deficiency-log.ts. This one catches CLAUDE.md DRIFT:
//   - Required sections missing in a repo
//   - "Monitoring shim is canonical" non-negotiable absent
//   - "Adversarial-pass cadence" section absent
//   - SOC 2 readiness % stale (lags the canonical SOC2_READINESS.md)
//
// The 5-PR CLAUDE.md institutional-memory arc (fa-amort #22 + recon
// #25 + revenue-rec #29 + integrations #19 + ledger-core #65) added
// the same patterns to every repo. Over time, some repos may evolve
// (new non-negotiables, new sections) while others drift behind. This
// script catches that drift before it accumulates.
//
// Why this matters for SOC 2:
//   Each CLAUDE.md is auto-loaded on every Claude Code session in
//   that repo. If the patterns drift between repos, future sessions
//   in the lagging repo inherit stale guidance — a different shape of
//   the falsely-completed-task class (#27). The verifier catches
//   that drift at workflow-runtime, parallel to deficiency-log-verify
//   catching deficiency-status drift.
//
// What it checks:
//   1. Each repo's CLAUDE.md exists at `~/Code/<repo>/CLAUDE.md`
//   2. Each contains the required sections:
//      - "## The non-negotiables" or equivalent
//      - A non-negotiable mentioning "monitoring" or "captureError"
//      - "## SOC 2 + adversarial-pass cadence" or "## SOC 2"
//      - The current SOC 2 readiness % matches the canonical doc
//   3. Reports drift per-repo + a portfolio-wide consistency score
//
// Limitations:
//   - Heuristic — section presence is checked by keyword, not by AST.
//     A rewording could fool the check; over time the keywords should
//     be tuned to match the actual canonical wording.
//   - Cross-repo readiness % comparison: this script assumes
//     ledger-core's docs/SOC2_READINESS.md is the canonical source.
//
// Exit codes: 0 — all consistent · 1 — drift detected · 2 — script error.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface RepoCheck {
  repo: string;
  path: string;
  exists: boolean;
  checks: SectionCheck[];
  readinessClaim: string | null;
}

interface SectionCheck {
  /** Human-readable name of the section/pattern checked. */
  name: string;
  /** Keywords that must all be present. */
  required: string[];
  /** Pass/fail. */
  ok: boolean;
  /** Which keywords were missing (only set when !ok). */
  missing?: string[];
}

const REPOS = [
  "ledger-core",
  "recon",
  "revenue-rec",
  "fa-amort",
  "integrations",
];

const PORTFOLIO_ROOT = join(homedir(), "Code");

/** Required sections — each must be present in every repo's CLAUDE.md. */
const REQUIRED_SECTIONS: Array<{ name: string; required: string[] }> = [
  {
    name: "What this project is",
    required: ["## What this project is"],
  },
  {
    name: "The non-negotiables",
    required: ["non-negotiables"],
  },
  // NOTE (2026-06-12 port): three chain-era expectations removed —
  // "monitoring shim" (the ledger-core shim lives in unmerged PR #115),
  // "adversarial-pass cadence section", and the SOC2_READINESS
  // reference. A verifier must check commitments main actually makes;
  // re-add each expectation in the SAME PR that lands its CLAUDE.md
  // section, never before.
];

/** Extract the SOC 2 readiness % claim from a CLAUDE.md (if any). */
function extractReadinessClaim(content: string): string | null {
  // Match "≈ 80%" or "~80%" or "approximately 80%" — heuristic.
  const re = /(?:≈|~|approximately)\s*(\d+)%/i;
  const m = content.match(re);
  return m ? m[1] + "%" : null;
}

/** Extract the canonical readiness % from ledger-core/docs/SOC2_READINESS.md. */
function extractCanonicalReadiness(): string | null {
  const path = join(PORTFOLIO_ROOT, "ledger-core/docs/SOC2_READINESS.md");
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  // Look for "Status: ≈ N% of the way" in the header.
  const re = /Status:\s*\*?\*?≈\s*(\d+)%/;
  const m = content.match(re);
  return m ? m[1] + "%" : null;
}

function checkRepo(repo: string): RepoCheck {
  const path = join(PORTFOLIO_ROOT, repo, "CLAUDE.md");
  const exists = existsSync(path);
  if (!exists) {
    return {
      repo,
      path,
      exists: false,
      checks: [],
      readinessClaim: null,
    };
  }
  const content = readFileSync(path, "utf8");
  const checks: SectionCheck[] = REQUIRED_SECTIONS.map((spec) => {
    const missing = spec.required.filter(
      (kw) => !content.toLowerCase().includes(kw.toLowerCase())
    );
    return {
      name: spec.name,
      required: spec.required,
      ok: missing.length === 0,
      ...(missing.length > 0 && { missing }),
    };
  });
  return {
    repo,
    path,
    exists,
    checks,
    readinessClaim: extractReadinessClaim(content),
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const strict = args.includes("--strict");

  const reports = REPOS.map(checkRepo);
  const canonicalReadiness = extractCanonicalReadiness();

  // Aggregate stats
  let pass = 0;
  let fail = 0;
  const driftItems: Array<{ repo: string; issue: string }> = [];

  for (const r of reports) {
    if (!r.exists) {
      driftItems.push({ repo: r.repo, issue: `CLAUDE.md does not exist at ${r.path}` });
      fail += 1;
      continue;
    }
    for (const c of r.checks) {
      if (c.ok) {
        pass += 1;
      } else {
        fail += 1;
        driftItems.push({
          repo: r.repo,
          issue: `Section "${c.name}" missing keywords: ${c.missing?.join(", ")}`,
        });
      }
    }
    // Readiness % drift check
    if (canonicalReadiness && r.readinessClaim && r.readinessClaim !== canonicalReadiness) {
      driftItems.push({
        repo: r.repo,
        issue: `Readiness % drift: claims ${r.readinessClaim}, canonical is ${canonicalReadiness}`,
      });
      fail += 1;
    } else if (canonicalReadiness && r.readinessClaim) {
      pass += 1;
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          totalRepos: REPOS.length,
          canonicalReadiness,
          pass,
          fail,
          driftItems,
          reports,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Portfolio CLAUDE.md consistency check`);
    console.log(`Canonical readiness: ${canonicalReadiness ?? "<not found>"}`);
    console.log();
    for (const r of reports) {
      if (!r.exists) {
        console.log(`[✗] ${r.repo} — CLAUDE.md missing at ${r.path}`);
        continue;
      }
      const passCount = r.checks.filter((c) => c.ok).length;
      const totalCount = r.checks.length;
      const claimNote = r.readinessClaim
        ? canonicalReadiness && r.readinessClaim !== canonicalReadiness
          ? ` (readiness drift: ${r.readinessClaim} vs ${canonicalReadiness})`
          : ` (readiness ${r.readinessClaim})`
        : ` (no readiness claim found)`;
      const marker = passCount === totalCount ? "✓" : "✗";
      console.log(
        `[${marker}] ${r.repo} — ${passCount}/${totalCount} sections present${claimNote}`
      );
      for (const c of r.checks) {
        if (!c.ok) {
          console.log(`     - missing "${c.name}" (keywords: ${c.missing?.join(", ")})`);
        }
      }
    }

    console.log();
    console.log("Summary:");
    console.log(`  Pass: ${pass}`);
    console.log(`  Fail: ${fail}`);
    console.log(`  Repos checked: ${REPOS.length}`);

    if (driftItems.length > 0) {
      console.log();
      console.log("Drift items:");
      for (const d of driftItems) {
        console.log(`  - ${d.repo}: ${d.issue}`);
      }
    }
  }

  if (fail > 0) process.exit(1);
  if (strict && driftItems.length > 0) process.exit(1);
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(
    `verify-claude-md-consistency.ts crashed: ${e instanceof Error ? e.message : e}`
  );
  process.exit(2);
}
