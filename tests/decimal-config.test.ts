// Money math must use banker's rounding, in every module, always.
//
// decimal.js keeps precision and rounding as STATIC state on the
// constructor, and ships both a CJS and an ESM build. Depending on how
// each importer is compiled those can resolve to two distinct
// constructor objects, each with its own config — so a `Decimal.set()`
// in one module configures only the copy that module holds.
//
// That is what was happening here. post-journal.ts called
//
//   Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN })
//
// and it worked *inside post-journal.ts*. Instrumenting the call showed
// it reporting rounding 6 from within, while a separate importer of the
// same package read rounding 4 — ROUND_HALF_UP, the library default.
// Ninety-nine other modules did money math on the unconfigured
// constructor.
//
// Half-up biases every tied amount upward and those ties accumulate in
// one direction across an allocation or a depreciation schedule. The
// fix is structural: one module configures and re-exports the
// constructor, so there is exactly one configured object and no way to
// obtain an unconfigured one.
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Decimal } from "@/lib/utils/decimal";
// Imported for their side effect on THIS test's module graph: each is a
// money module that must see the same configured constructor.
import { computeAllocationLines } from "@/lib/accounting/allocation";
import { matchTransactions } from "@/lib/recon/transaction-match";

describe("the configured Decimal", () => {
  it("uses banker's rounding at 28 digits", () => {
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_EVEN);
    expect(Decimal.precision).toBe(28);
  });

  it("rounds ties to even rather than up", () => {
    // The observable difference. Under ROUND_HALF_UP these are 0.01 and
    // 0.03 — every tie nudged the same way.
    expect(new Decimal("0.005").toDecimalPlaces(2).toString()).toBe("0");
    expect(new Decimal("0.015").toDecimalPlaces(2).toString()).toBe("0.02");
    expect(new Decimal("0.025").toDecimalPlaces(2).toString()).toBe("0.02");
  });

  it("reaches the allocation engine, which rounds real money", () => {
    // 100.01 split 50/50: each share is exactly 50.005. Banker's
    // rounding gives the first target 50.00 and the remainder carries
    // the extra cent; half-up would hand 50.01 to the first target.
    const lines = computeAllocationLines({
      sourceAccountCode: "SRC",
      sourceActivity: new Decimal("100.01"),
      targets: [
        { accountCode: "D1", percent: new Decimal(50) },
        { accountCode: "D2", percent: new Decimal(50) },
      ],
    });
    const targets = lines.filter((l) => l.accountCode.startsWith("D"));
    expect(targets.map((l) => l.debit.toString())).toEqual(["50", "50.01"]);
    // Whatever the rounding, the split still ties to the pool exactly.
    const total = targets.reduce((a, l) => a.plus(l.debit), new Decimal(0));
    expect(total.toString()).toBe("100.01");
  });

  it("reaches modules that only compare amounts", () => {
    // transaction-match does exact equality rather than rounding, but
    // it must be comparing values built by the same constructor.
    const r = matchTransactions({
      glItems: [
        {
          id: "g1",
          date: new Date("2026-05-05"),
          amount: new Decimal("100.005"),
          description: "gl",
        },
      ],
      supportItems: [
        {
          id: "s1",
          date: new Date("2026-05-05"),
          amount: new Decimal("100.005"),
          description: "stmt",
        },
      ],
    });
    expect(r.matched).toHaveLength(1);
    expect(r.netUnmatched.toString()).toBe("0");
  });
});

// ── The guard that was missing ──────────────────────────────────────────
//
// Everything above pins that `@/lib/utils/decimal` hands out a
// CONFIGURED constructor. None of it noticed that 44 test files were
// importing `decimal.js` directly and therefore never getting it —
// #347's codemod stopped at the `src/` boundary, and the suite that was
// supposed to protect the invariant only ever checked the helper.
//
// A property nobody can bypass needs a check on the bypass, not on the
// happy path.

describe("nothing imports decimal.js directly", () => {
  const HELPER = path.join("src", "lib", "utils", "decimal.ts");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(full, out);
      } else if (/\.tsx?$/.test(e.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("across src/ and tests/, except the one module that configures it", () => {
    const offenders = ["src", "tests", "prisma", "scripts"]
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => walk(d))
      .filter((f) => path.normalize(f) !== HELPER)
      .filter((f) => /from\s+["']decimal\.js["']/.test(fs.readFileSync(f, "utf8")));

    // Named, not counted: a failure should say which file to fix.
    expect(offenders).toEqual([]);
  });

  it("and the helper itself is the one that configures it", () => {
    const src = fs.readFileSync(HELPER, "utf8");
    expect(src).toMatch(/from ["']decimal\.js["']/);
    expect(src).toMatch(/Decimal\.set\(/);
    expect(src).toMatch(/ROUND_HALF_EVEN/);
  });
});
