// The one configured Decimal. Import it from here, never from
// "decimal.js" directly.
//
// decimal.js keeps precision and rounding as STATIC state on the
// constructor, and it ships both a CJS and an ESM build. Depending on
// how each importer is compiled, those two builds can resolve to two
// distinct constructor objects — each with its own static config. So a
// `Decimal.set()` in one module configures only the constructor that
// module happens to hold.
//
// That is what was happening. `post-journal.ts` called
//
//   Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN })
//
// and it worked — inside post-journal.ts. Every other module that
// imported decimal.js got the library defaults: precision 20 and
// **ROUND_HALF_UP**, not the banker's rounding the comment promised and
// the accounting expects. Verified by instrumenting the call: it
// reported rounding 6 from inside post-journal while a separate
// importer of the same package read rounding 4.
//
// Re-exporting the configured constructor from one module removes the
// question. You cannot obtain a Decimal without importing this file, so
// there is exactly one configured object by construction — no
// dependence on import order, and none on how a bundler resolved the
// dual package.
//
// Why banker's rounding: half-up biases every tied amount upward, and
// those ties accumulate in the same direction across an allocation, a
// depreciation schedule, or a period's worth of postings.
// ROUND_HALF_EVEN spreads them, which is the GAAP-friendly default and
// what the codebase always intended.

import { Decimal } from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };
export default Decimal;

/**
 * Canonical loose-input → Decimal coercion for money fields arriving as
 * Decimal | string | number (Server Action payloads, mapper inputs).
 * null/undefined coerce to 0 — callers that must distinguish "absent"
 * check before coercing. One definition — don't redeclare locally.
 */
export function toDecimal(
  v: Decimal | string | number | null | undefined
): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}
