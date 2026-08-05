// Every environment variable the app reads must be documented in
// docs/deployment.md, or explicitly excused here with a reason.
//
// This exists because FIELD_ENCRYPTION_KEY wasn't. Unset, the encrypted-
// fields extension passes PLAINTEXT through to columns the SOC 2
// posture treats as encrypted — it warns once per process and carries
// on, which is the right behavior for dev and invisible in serverless.
// The deployment guide, which is what someone actually follows when
// standing the app up, never mentioned it. A first deploy that skipped
// it would have written customer data in the clear with nothing louder
// than one log line, and setting the key afterwards does not
// retroactively encrypt what was already stored.
//
// Static by construction: it reads sources rather than importing them,
// so it needs no DATABASE_URL and no running app. Same shape as
// tests/cron-route-verbs.test.ts, which keeps vercel.json honest about
// the routes it schedules.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const DOC = join(ROOT, "docs", "deployment.md");

/**
 * Variables deliberately absent from the deployment guide. Each needs a
 * reason — "it's obvious" is not one, since the whole point is that the
 * person deploying does not yet know what is obvious.
 */
const EXCUSED: Record<string, string> = {
  NODE_ENV: "Set by Next.js and Vercel; never configured by hand.",
  NEXT_RUNTIME: "Set by Next.js to distinguish edge from node at runtime.",
  VERCEL_GIT_COMMIT_SHA: "Injected by Vercel; surfaced in the health payload.",
  HIDE_DEV_CHROME: "Local-only switch for hiding the dev auth stub UI.",
  ADMIN_TOKEN: "Local scripts only — never read by a deployed route.",
  BILLING_ENFORCE_LIMITS: "Documented in docs/billing-setup.md with the rest of billing.",
  STRIPE_SECRET_KEY: "Documented by exact name in docs/billing-setup.md.",
  STRIPE_WEBHOOK_SECRET: "Documented by exact name in docs/billing-setup.md.",
  SENTRY_TRACES_SAMPLE_RATE: "Tuning knob for SENTRY_DSN, which is documented.",
  RECON_URL: "Companion-repo wiring; see docs/multi-repo-deploy.md.",
  REVENUE_REC_URL: "Companion-repo wiring; see docs/multi-repo-deploy.md.",
  FA_AMORT_URL: "Companion-repo wiring; see docs/multi-repo-deploy.md.",
  INTEGRATIONS_URL: "Companion-repo wiring; see docs/multi-repo-deploy.md.",
  INTERNAL_API_TOKEN: "Companion-repo wiring; see docs/multi-repo-deploy.md.",
};

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(full);
  }
  return acc;
}

function readEnvVarsFromSource(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      found.add(m[1]);
    }
  }
  return found;
}

describe("deployment guide covers the environment", () => {
  const doc = readFileSync(DOC, "utf8");
  const vars = [...readEnvVarsFromSource()].sort();

  it("finds the variables the app actually reads", () => {
    // Guards the guard: if the scan silently returned nothing, every
    // assertion below would pass vacuously.
    expect(vars.length).toBeGreaterThan(10);
    expect(vars).toContain("CLERK_SECRET_KEY");
    expect(vars).toContain("FIELD_ENCRYPTION_KEY");
  });

  it("documents every variable that isn't explicitly excused", () => {
    const undocumented = vars.filter(
      (v) => !(v in EXCUSED) && !doc.includes(v)
    );
    expect(undocumented).toEqual([]);
  });

  it("names the consequence of omitting each control-bearing key", () => {
    // Documented-but-unexplained is how FIELD_ENCRYPTION_KEY would have
    // slipped back in: a bare mention in a list teaches nobody what
    // happens if they skip it.
    for (const key of [
      "FIELD_ENCRYPTION_KEY",
      "FIELD_DETERMINISTIC_KEY",
      "CRON_SECRET",
      "AUTH_STUB_SECRET",
      "WEBHOOK_ENCRYPTION_KEY",
    ]) {
      const row = doc
        .split("\n")
        .find((l) => l.includes(`\`${key}\``) && l.trim().startsWith("|"));
      expect(row, `${key} needs a row in a deployment.md table`).toBeTruthy();
      // The last cell is the consequence — "Without it" in the deploy
      // table, "Generate" in the notifier one. A row that only names
      // the variable is not documentation. Length is a poor proxy for
      // this; the empty cell is the actual failure mode.
      const cells = row!
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      expect(cells.length, `${key}'s row needs more than just a name`)
        .toBeGreaterThan(1);
      expect(
        cells[cells.length - 1].length,
        `${key}'s row should say what happens without it`
      ).toBeGreaterThan(15);
    }
  });

  it("keeps the excuse list honest — no stale entries", () => {
    const stale = Object.keys(EXCUSED).filter((v) => !vars.includes(v));
    expect(stale, "excused variables the code no longer reads").toEqual([]);
  });
});
