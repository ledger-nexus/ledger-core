// Every tenant-scoped table has an RLS policy.
//
// WHY THIS MATTERS MORE THAN IT LOOKS, given RLS is Phase 1 and inert.
//
// `CLAUDE.md` is explicit that nothing is FORCED yet — the app's connection
// role owns the tables and bypasses every policy — so a missing policy changes
// no behaviour today. The danger is entirely in the future tense, and migration
// 0042 wrote it down at the time:
//
//   "RLS Phase 1 parity: every tenant-scoped table carries a policy, even
//    though nothing is FORCED yet (deficiency #12). A new table that skipped
//    this would be the one gap when Phase 3 flips the switch."
//
// Six tables skipped it. When Phase 3 runs `FORCE ROW LEVEL SECURITY`, a table
// with RLS *enabled* starts being enforced; a table where RLS was never enabled
// is not protected by RLS at all, and nothing about the rollout says so. That
// is the worst shape for a security control — **partial enforcement that reads
// as complete** — and it is invisible unless something counts.
//
// So this guard is not about today's behaviour. It is about making Phase 3's
// switch mean what the deficiency log says it means.
//
// ⚠️ THE LIST IS DERIVED FROM THE SCHEMA, twice over: which models are
// tenant-scoped, and what each maps to as a table. The policy file itself is a
// hand-written list of 55 tables, which is exactly why it drifted — a list
// nobody counts is a list that quietly stops matching.
//
// ⚠️ WRITING THIS, THE FIRST MEASUREMENT SAID "53 of 53 MISSING." That was
// wrong: the policy file writes table names UNQUOTED (`ALTER TABLE tenant …`)
// while migration 0042 writes them QUOTED (`ALTER TABLE "reconciliation_manual_match" …`),
// and the pattern only accepted quotes. Publishing it would have been a
// spectacular false alarm. The matcher below accepts both, and this note exists
// so the next person to touch it knows both spellings are live.
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const POLICY_FILE = path.join(ROOT, "prisma", "sql", "2026-06-05-rls-phase-1-policies.sql");

/** Tenant-scoped models → their SQL table name, both read out of the schema. */
function tenantScopedTables(): Map<string, string> {
  const schema = fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  const out = new Map<string, string>();
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, model, body] = m;
    // `tenant` itself is scoped by its own `id`, not a `tenantId` column, and
    // carries a policy on that basis.
    if (!/^\s*tenantId\s+/m.test(body)) continue;
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    out.set(model, mapped ? mapped[1] : model);
  }
  return out;
}

/**
 * Every table with RLS enabled **in the policy file**.
 *
 * ⚠️ MIGRATIONS DO NOT COUNT, and that is the whole point. CI and
 * `npm run db:reset` build the schema with `prisma db push`, which creates
 * TABLES but never runs migration SQL — so a policy that exists only in a
 * migration is absent from every freshly-built database. `db:restore-ddl`
 * applies this file, and only this file.
 *
 * Migration 0042 said so in a comment and still wrote its policy in both
 * places, which is the correct belt-and-braces. An earlier version of this
 * guard accepted either location, and would have passed a table covered only
 * by a migration — i.e. covered nowhere that matters.
 */
function tablesWithRlsEnabled(): Set<string> {
  const sources = [fs.readFileSync(POLICY_FILE, "utf8")];
  // ⚠️ Optional quotes — see the header note. Both spellings are in the tree.
  const re = /ALTER TABLE\s+"?([a-z_]+)"?\s+ENABLE ROW LEVEL SECURITY/gi;
  const out = new Set<string>();
  for (const src of sources) for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

/** Same rule as above: the policy file is the only source that ships. */
function tablesWithPolicy(): Set<string> {
  const sources = [fs.readFileSync(POLICY_FILE, "utf8")];
  const re = /CREATE POLICY\s+\w+\s+ON\s+"?([a-z_]+)"?/gi;
  const out = new Set<string>();
  for (const src of sources) for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

describe("RLS Phase 1 policy coverage", () => {
  const scoped = tenantScopedTables();

  it("finds the models and the policy DDL at all", () => {
    // Guards the guard. A rename of the policy file, or of the `tenantId`
    // column, would otherwise leave every check below comparing two empty sets
    // and passing for the wrong reason — which is the exact failure mode this
    // whole file exists to catch in the DDL.
    expect(scoped.size).toBeGreaterThan(40);
    expect(tablesWithRlsEnabled().size).toBeGreaterThan(40);
  });

  it("enables RLS on every tenant-scoped table", () => {
    const enabled = tablesWithRlsEnabled();
    const missing = [...scoped.entries()]
      .filter(([, table]) => !enabled.has(table))
      .map(([model, table]) => `${model} (${table})`)
      .sort();
    expect(missing, "tenant-scoped tables with RLS never enabled").toEqual([]);
  });

  it("defines an isolation policy for every tenant-scoped table", () => {
    // Enabling RLS without a policy is worse than neither: under FORCE it
    // denies everything, so the failure mode flips from "silently unprotected"
    // to "silently empty". Both halves have to hold.
    const withPolicy = tablesWithPolicy();
    const missing = [...scoped.entries()]
      .filter(([, table]) => !withPolicy.has(table))
      .map(([model, table]) => `${model} (${table})`)
      .sort();
    expect(missing, "tenant-scoped tables with no CREATE POLICY").toEqual([]);
  });
});
