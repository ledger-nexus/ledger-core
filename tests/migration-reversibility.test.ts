// Every new migration ships the SQL that undoes it.
//
// The global engineering standard for this machine says "Database
// migrations are reversible. Always include a down() migration." Prisma
// Migrate has no built-in down, so the convention here is a sibling
// `down.sql` applied by hand with `prisma db execute`. Nothing enforced
// it, and the result was 0 of 42.
//
// THE CUTOFF IS A NUMBER, NOT A LIST. Grandfathering the existing 40 by
// name would mean a 40-entry array that silently stops covering anything
// added below it and has to be edited by whoever adds one. `0041` is a
// single constant: everything at or above it is in scope, forever, with
// no maintenance. Migrations below it are historical and are NOT being
// back-filled — see the note on that below.
//
// WHY THE HISTORICAL ONES ARE LEFT ALONE. Writing 40 reverse migrations
// after the fact would be worse than the gap it closes. Several are not
// reversible even in principle — data backfills that discard the prior
// value, enum additions Postgres cannot undo — and a `down.sql` that
// looks authoritative but is wrong is more dangerous than none at all,
// because it invites someone mid-incident to run destructive SQL with
// confidence. The honest position is: from 0041 the convention holds,
// below it the answer is "read the migration and decide".
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** The first migration required to ship a down.sql. */
const REVERSIBLE_FROM = 41;

const MIGRATIONS = path.join(__dirname, "..", "prisma", "migrations");

function migrationDirs(): { name: string; ordinal: number }[] {
  return fs
    .readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, ordinal: Number(e.name.slice(0, 4)) }))
    .filter((m) => Number.isFinite(m.ordinal))
    .sort((a, b) => a.ordinal - b.ordinal);
}

describe("migration reversibility", () => {
  const dirs = migrationDirs();

  it("finds the migration directories at all", () => {
    // Guards the guard: a rename of the folder or the NNNN_ prefix would
    // otherwise leave every check below iterating an empty list and
    // passing for the wrong reason.
    expect(dirs.length).toBeGreaterThan(40);
    expect(dirs.every((d) => /^\d{4}_/.test(d.name))).toBe(true);
  });

  it("ships a down.sql for every migration from 0041 onward", () => {
    const missing = dirs
      .filter((d) => d.ordinal >= REVERSIBLE_FROM)
      .filter((d) => !fs.existsSync(path.join(MIGRATIONS, d.name, "down.sql")))
      .map((d) => d.name);

    expect(missing).toEqual([]);
  });

  it("gives each down.sql something to say about what it cannot undo", () => {
    // A bare `DROP TABLE x;` with no prose is the failure mode this whole
    // convention is meant to avoid: it reads as symmetric when it is not.
    // 0041 cannot remove its enum value; 0042 discards operator decisions
    // that are not derivable from the ledger. Both facts belong in the
    // file, next to the statement, not in a PR description nobody will
    // find at 2am.
    const thin: string[] = [];

    for (const d of dirs.filter((x) => x.ordinal >= REVERSIBLE_FROM)) {
      const file = path.join(MIGRATIONS, d.name, "down.sql");
      if (!fs.existsSync(file)) continue;
      const comment = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trimStart().startsWith("--")).length;
      if (comment < 5) thin.push(`${d.name}: ${comment} comment line(s)`);
    }

    expect(thin).toEqual([]);
  });
});
