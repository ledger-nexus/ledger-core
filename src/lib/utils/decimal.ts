// Canonical loose-input → Decimal coercion for money fields arriving as
// Decimal | string | number (Server Action payloads, mapper inputs).
// null/undefined coerce to 0 — callers that must distinguish "absent"
// check before coercing. One definition — don't redeclare locally.

import { Decimal } from "decimal.js";

export function toDecimal(
  v: Decimal | string | number | null | undefined
): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}
