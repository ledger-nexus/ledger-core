#!/usr/bin/env tsx
// Verify the deficiency log's Closed rows actually cite merged PRs.
//
// CC4 (Monitoring Activities) automation — closes the remediation
// plan promise of deficiency #27 ("Task-completion attestations
// diverge from main"). Today's mitigation is the row's existence
// + manual process; this script is the future-proofing trigger that
// flips #27 from Open → Remediated once it runs in CI.
//
// What it does:
//   1. Reads docs/policies/control-deficiency-log.md
//   2. For each row with status=Closed (or Remediated), extracts
//      every PR URL of the form
//        https://github.com/<owner>/<repo>/pull/<n>
//      from the Remediation cell.
//   3. Calls `gh pr view <n> --repo <owner>/<repo> --json state,mergedAt`
//      for each. State must be MERGED. mergedAt must be non-null.
//   4. Prints a per-row pass/fail table + a final summary.
//   5. Exits 0 on all-pass, exits 1 if any cited PR is OPEN, DRAFT,
//      or CLOSED-unmerged.
//
// SOC 2 audit value:
//   - Auditor question: "How do you know the deficiency log is
//     accurate?"
//   - Answer: "We run this script nightly; output goes to
//     docs/operational-evidence/deficiency-verify-{YYYY-MM-DD}.log;
//     last 90 days retained as evidence."
//   - When the row says Closed but the PR is unmerged, the script
//     flags it loudly. Auditors love loud failure modes.
//
// Limitations (documented honestly):
//   - Cross-repo PR refs require `gh` to be authenticated against
//     a token with read access to the cited orgs.
//   - PRs cited only by number (not URL) are skipped + flagged.
//   - Rows that cite COMMITS instead of PRs (e.g. "commit fe4bb6a")
//     are skipped — that's the right behavior, commit-citation is
//     a separate evidence channel.
//
// Usage:
//   pnpm tsx scripts/verify-deficiency-log.ts
//   pnpm tsx scripts/verify-deficiency-log.ts --json    # machine-readable
//   pnpm tsx scripts/verify-deficiency-log.ts --strict  # fail on skipped

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

interface DeficiencyRow {
  num: string;
  status: string;
  title: string;
  remediation: string;
  prRefs: PrRef[];
}

interface PrRef {
  /** Full URL as cited */
  url: string;
  owner: string;
  repo: string;
  number: number;
}

interface VerifyResult {
  pr: PrRef;
  state: "MERGED" | "OPEN" | "DRAFT" | "CLOSED" | "ERROR" | "SKIPPED";
  mergedAt: string | null;
  error?: string;
}

const ROOT = join(import.meta.dirname, "..");
const LOG_PATH = join(ROOT, "docs/policies/control-deficiency-log.md");

function parseLog(): DeficiencyRow[] {
  const raw = readFileSync(LOG_PATH, "utf8");
  const lines = raw.split("\n");
  const rows: DeficiencyRow[] = [];

  // Find the deficiency-log table — markdown rows starting with "| N | "
  // where N is the row number. The cell separator is " | " (with spaces).
  for (const line of lines) {
    const m = line.match(/^\| (\d+) \| /);
    if (!m) continue;
    // Split on " | " keeping the boundary cells empty.
    const cells = line.split(" | ");
    if (cells.length < 8) continue;
    // Status is always 2nd-to-last cell, regardless of v1.0 (10-column,
    // includes Owner) vs v2.x (9-column, no Owner). Title is always
    // cells[3]. Remediation is cells[6] in BOTH layouts — counting from
    // the END is wrong for v1.0, where Owner sits between Remediation
    // and Status (3rd-to-last would read the Owner cell and skip every
    // row as "no PR URLs").
    const num = m[1];
    const status = cells[cells.length - 2].trim().replace(/\*\*/g, "");
    const title = cells[3].trim();
    const remediation = cells[6];

    rows.push({
      num,
      status,
      title,
      remediation,
      prRefs: extractPrRefs(remediation),
    });
  }
  return rows;
}

function extractPrRefs(remediationCell: string): PrRef[] {
  // Match BOTH full URL and shorthand:
  //   https://github.com/ledger-nexus/fa-amort/pull/18
  // We do NOT match bare "PR #18" — the URL form is required for
  // auditable evidence. The script's failure mode for bare numbers
  // (SKIPPED) is part of the spec.
  const re =
    /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;
  const refs: PrRef[] = [];
  const seen = new Set<string>();
  for (const m of remediationCell.matchAll(re)) {
    const key = `${m[1]}/${m[2]}#${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      url: m[0],
      owner: m[1],
      repo: m[2],
      number: parseInt(m[3], 10),
    });
  }
  return refs;
}

function verifyPr(pr: PrRef): VerifyResult {
  try {
    const out = execSync(
      `gh pr view ${pr.number} --repo ${pr.owner}/${pr.repo} --json state,mergedAt`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(out) as {
      state: string;
      mergedAt: string | null;
    };
    return {
      pr,
      state: (parsed.state as VerifyResult["state"]) ?? "ERROR",
      mergedAt: parsed.mergedAt,
    };
  } catch (e) {
    return {
      pr,
      state: "ERROR",
      mergedAt: null,
      error: e instanceof Error ? e.message.split("\n")[0] : String(e),
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const strict = args.includes("--strict");

  const rows = parseLog();
  const closedRows = rows.filter(
    (r) => r.status === "Closed" || r.status === "Remediated"
  );

  if (!json) {
    console.log(
      `Found ${rows.length} deficiency rows; ${closedRows.length} marked Closed/Remediated.`
    );
    console.log();
  }

  let pass = 0;
  let fail = 0;
  let skipped = 0;
  const failures: Array<{
    row: DeficiencyRow;
    verify: VerifyResult;
  }> = [];

  const reports = closedRows.map((row) => {
    if (row.prRefs.length === 0) {
      // No PR URLs cited — skipped + flagged.
      skipped += 1;
      return { row, verifies: [] };
    }
    const verifies = row.prRefs.map(verifyPr);
    for (const v of verifies) {
      if (v.state === "MERGED" && v.mergedAt) {
        pass += 1;
      } else {
        fail += 1;
        failures.push({ row, verify: v });
      }
    }
    return { row, verifies };
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          totalRows: rows.length,
          closedRows: closedRows.length,
          checked: pass + fail,
          pass,
          fail,
          skipped,
          failures: failures.map((f) => ({
            row: f.row.num,
            title: f.row.title,
            url: f.verify.pr.url,
            state: f.verify.state,
            mergedAt: f.verify.mergedAt,
            error: f.verify.error,
          })),
        },
        null,
        2
      )
    );
  } else {
    for (const { row, verifies } of reports) {
      if (verifies.length === 0) {
        console.log(
          `[skip] #${row.num.padStart(2, " ")} — ${row.title}  (no PR URLs in cell)`
        );
        continue;
      }
      for (const v of verifies) {
        const marker =
          v.state === "MERGED" && v.mergedAt ? "✓" : "✗";
        const detail =
          v.state === "MERGED" && v.mergedAt
            ? `merged ${v.mergedAt.slice(0, 10)}`
            : v.error
              ? `ERROR: ${v.error}`
              : v.state;
        console.log(
          `[${marker}] #${row.num.padStart(2, " ")} ${v.pr.owner}/${v.pr.repo}#${v.pr.number} — ${detail}`
        );
      }
    }

    console.log();
    console.log("Summary:");
    console.log(`  Checked:  ${pass + fail}`);
    console.log(`  Passed:   ${pass}`);
    console.log(`  Failed:   ${fail}`);
    console.log(`  Skipped:  ${skipped} (rows with no PR URLs)`);
    console.log();

    if (failures.length > 0) {
      console.log("Failures (deficiency log says Closed but PR is not MERGED):");
      for (const { row, verify } of failures) {
        console.log(
          `  - #${row.num} (${row.title}) → ${verify.pr.url} (${verify.state})`
        );
      }
    }
  }

  // Exit code semantics:
  //   0 — every checked PR is MERGED
  //   1 — at least one PR is not MERGED OR at least one cell had no PR URLs (--strict)
  //   2 — script error (file not found, etc.)
  if (fail > 0) process.exit(1);
  if (strict && skipped > 0) process.exit(1);
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(
    `verify-deficiency-log.ts crashed: ${e instanceof Error ? e.message : e}`
  );
  process.exit(2);
}
