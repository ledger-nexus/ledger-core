// Verb contract for every cron route registered in vercel.json.
//
// Vercel Cron always issues a GET and cannot be configured to send any
// other verb. A route registered under `crons` that exports only POST
// is therefore scheduled on paper and returns 405 on every single fire
// — silently, forever, with no error anywhere.
//
// That is exactly what shipped: four routes (assertion-check,
// recurring-je-run, close-alerts-digest, close-alerts-dispatch) were
// POST-only. Nothing caught it because nothing has ever been deployed,
// so no cron has ever actually fired. Three of the four even exported
// an explicit GET returning 405 "so accidental browser visits don't
// trigger a run" — a guard that, on Vercel, blocks only the scheduler.
//
// This suite is deliberately STATIC (it reads the route sources rather
// than importing them). Importing a route module constructs the Prisma
// singleton, which needs DATABASE_URL; the verb contract is a property
// of the module's shape and does not need a database to check. It also
// lets the suite assert that every scheduled path actually resolves to
// a route file on disk — a cron pointing at a nonexistent path is the
// same class of silent no-op.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

type VercelConfig = { crons?: Array<{ path: string; schedule: string }> };

const vercelConfig: VercelConfig = JSON.parse(
  readFileSync(path.join(repoRoot, "vercel.json"), "utf8")
);

const crons = vercelConfig.crons ?? [];

// Matches `export function NAME`, `export async function NAME`, and
// `export const NAME =` at the top level of a route module.
function exportsVerb(source: string, verb: string): boolean {
  const fnExport = new RegExp(`^export\\s+(async\\s+)?function\\s+${verb}\\b`, "m");
  const constExport = new RegExp(`^export\\s+const\\s+${verb}\\b`, "m");
  return fnExport.test(source) || constExport.test(source);
}

describe("vercel.json cron routes", () => {
  it("registers at least one cron (guards against a vacuous suite)", () => {
    expect(crons.length).toBeGreaterThan(0);
  });

  for (const cron of crons) {
    describe(`${cron.path} (${cron.schedule})`, () => {
      const routeFile = path.join(repoRoot, "src", "app", cron.path, "route.ts");

      it("resolves to a route file on disk", () => {
        expect(existsSync(routeFile)).toBe(true);
      });

      it("exports GET — the only verb Vercel Cron issues", () => {
        const source = readFileSync(routeFile, "utf8");
        expect(exportsVerb(source, "GET")).toBe(true);
      });

      // A POST export is not harmful on its own, but its presence here
      // has historically meant "POST is the real handler and GET is a
      // 405 stub". Refusing POST outright keeps the scheduled verb and
      // the implemented verb the same one.
      it("does not export POST", () => {
        const source = readFileSync(routeFile, "utf8");
        expect(exportsVerb(source, "POST")).toBe(false);
      });
    });
  }
});
