// CRON_SECRET must stay in the env spec.
//
// Why this test exists: every scheduled job in vercel.json authenticates
// through isAuthorizedCronRequest, which fails CLOSED on a missing or
// under-16-char secret. Without CRON_SECRET every cron returns 401 —
// and a 401 to Vercel's scheduler surfaces nowhere in the app. The jobs
// look configured and simply never run.
//
// That was invisible until #324. Before it, the four legacy cron routes
// exported POST while Vercel Cron only issues GET, so they 405'd whether
// or not the secret was set. Fixing the verb is what made the secret
// load-bearing, which is exactly the kind of dependency that gets missed
// when the fix and the config live in different PRs.
//
// One of those jobs is the retention purge, which
// docs/SOC2_CONTROL_MATRIX.md carries under the Privacy TSC. A control
// that cannot fire is designed, not operating — so the matrix has to
// keep saying the status is conditional on this variable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");
const envSource = readFileSync(join(REPO_ROOT, "src/lib/env.ts"), "utf8");

describe("CRON_SECRET env spec", () => {
  it("is declared in ENV_SPECS", () => {
    expect(
      envSource.includes('name: "CRON_SECRET"'),
      "CRON_SECRET vanished from src/lib/env.ts — nothing will warn at boot " +
        "when it is missing, and all 5 scheduled jobs will silently 401."
    ).toBe(true);
  });

  it("declares a minimum length matching the cron auth check", () => {
    // isAuthorizedCronRequest refuses a secret under 16 chars outright,
    // so a shorter one is indistinguishable from unset at runtime. The
    // spec has to reject it at boot rather than let it look configured.
    const cronSource = readFileSync(
      join(REPO_ROOT, "src/lib/auth/cron.ts"),
      "utf8"
    );
    expect(cronSource).toMatch(/length\s*<\s*16/);
    const block = envSource.slice(envSource.indexOf('name: "CRON_SECRET"'));
    expect(block.slice(0, 300)).toMatch(/minLength:\s*16/);
  });

  it("warns rather than hard-failing production boot", () => {
    // Deliberate: the app serves correctly without crons, so refusing to
    // boot over a scheduler secret is disproportionate. The cost of the
    // choice is that a deploy CAN ship with the jobs dark — which is why
    // the description names the blast radius.
    const block = envSource.slice(envSource.indexOf('name: "CRON_SECRET"'));
    expect(block.slice(0, 300)).toMatch(/requiredInProduction:\s*false/);
  });

  it("names the SOC 2 consequence in its description", () => {
    const block = envSource.slice(envSource.indexOf('name: "CRON_SECRET"'));
    expect(block.slice(0, 900)).toMatch(/SOC2_CONTROL_MATRIX|Privacy TSC/);
  });
});

describe("every vercel.json cron is covered by the secret", () => {
  it("all scheduled routes authenticate through isAuthorizedCronRequest", () => {
    // If a future cron rolls its own auth, CRON_SECRET stops being the
    // single knob and this file's reasoning quietly stops holding.
    const vercel = JSON.parse(
      readFileSync(join(REPO_ROOT, "vercel.json"), "utf8")
    ) as { crons?: Array<{ path: string }> };
    const crons = vercel.crons ?? [];
    expect(crons.length).toBeGreaterThan(0);

    const ungated = crons.filter((c) => {
      const src = readFileSync(
        join(REPO_ROOT, "src/app", c.path, "route.ts"),
        "utf8"
      );
      return !src.includes("isAuthorizedCronRequest");
    });
    expect(
      ungated.map((c) => c.path),
      "scheduled route(s) not using the shared cron auth helper"
    ).toEqual([]);
  });
});

describe("the control matrix keeps retention's status conditional", () => {
  it("flags the CRON_SECRET dependency on the retention row", () => {
    const matrix = readFileSync(
      join(REPO_ROOT, "docs/SOC2_CONTROL_MATRIX.md"),
      "utf8"
    );
    const row = matrix
      .split("\n")
      .find((l) => l.startsWith("| Data retention"));
    expect(row, "retention row missing from the control matrix").toBeDefined();
    expect(
      row,
      "the retention row must keep naming CRON_SECRET — an auditor reading " +
        "'Mitigated' is entitled to know the control cannot fire without it"
    ).toMatch(/CRON_SECRET/);
  });
});
