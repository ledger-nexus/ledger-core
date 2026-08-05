// Reassignment rules — criteria evaluator.
//
// Pure function. Takes a record + a criteria tree and returns true/false.
// No DB access, no side effects. The executor calls this; tests cover it
// without any infrastructure.
//
// Field path resolution:
//   "amount"               → record.amount
//   "customer.creditRating"→ record.customer.creditRating
//   "customer.parent.x"    → REJECTED at validation time; one level only
//
// Type coercion:
//   - Numbers, Decimal, and numeric strings are compared via Decimal
//   - Dates and ISO date strings compare via Date
//   - Strings compare as strings (no implicit numeric coercion)
//
// Null handling:
//   - For binary operators (EQ/NEQ/comparisons), a null operand makes the
//     result false UNLESS the operator is NEQ comparing null vs something
//     (then true). Matches Salesforce semantics — null is not equal to
//     anything except via IS_NULL / IS_NOT_NULL.

import { Decimal } from "@/lib/utils/decimal";
import {
  type Clause,
  type LeafClause,
  type RecordLike,
  type RuleValue,
  isLeaf,
  isBranch,
} from "./types";

export class EvaluatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorError";
  }
}

export function evaluate(criteria: Clause, record: RecordLike): boolean {
  if (isLeaf(criteria)) {
    return evaluateLeaf(criteria, record);
  }
  if (isBranch(criteria)) {
    if (criteria.op === "AND") {
      // Empty AND is vacuously true (matches all records — used for catch-all
      // rules like the deactivation fallback).
      return criteria.clauses.every((c) => evaluate(c, record));
    }
    if (criteria.op === "OR") {
      // Empty OR is vacuously false. Authors who want "match all" use AND with
      // an empty clauses array.
      return criteria.clauses.some((c) => evaluate(c, record));
    }
    if (criteria.op === "NOT") {
      if (criteria.clauses.length !== 1) {
        throw new EvaluatorError(
          `NOT requires exactly one clause (got ${criteria.clauses.length})`
        );
      }
      return !evaluate(criteria.clauses[0], record);
    }
  }
  throw new EvaluatorError(`Unknown clause shape: ${JSON.stringify(criteria)}`);
}

function evaluateLeaf(clause: LeafClause, record: RecordLike): boolean {
  const fieldValue = resolveFieldPath(clause.field, record);
  const value = clause.value as RuleValue;

  switch (clause.op) {
    case "IS_NULL":
      return fieldValue === null || fieldValue === undefined;
    case "IS_NOT_NULL":
      return fieldValue !== null && fieldValue !== undefined;
  }

  // For everything else, null/undefined field makes binary ops false
  // (EXCEPT NEQ where null !== value should be true).
  if (fieldValue === null || fieldValue === undefined) {
    return clause.op === "NEQ" && value !== null && value !== undefined;
  }

  switch (clause.op) {
    case "EQ":
      return equalsValue(fieldValue, value);
    case "NEQ":
      return !equalsValue(fieldValue, value);
    case "IN":
      if (!Array.isArray(value)) {
        throw new EvaluatorError(`IN requires array value, got ${typeof value}`);
      }
      return value.some((v) => equalsValue(fieldValue, v));
    case "NOT_IN":
      if (!Array.isArray(value)) {
        throw new EvaluatorError(`NOT_IN requires array value, got ${typeof value}`);
      }
      return !value.some((v) => equalsValue(fieldValue, v));
    case "GT":
      return compareValues(fieldValue, value) > 0;
    case "GTE":
      return compareValues(fieldValue, value) >= 0;
    case "LT":
      return compareValues(fieldValue, value) < 0;
    case "LTE":
      return compareValues(fieldValue, value) <= 0;
    case "STARTS_WITH":
      return typeof fieldValue === "string" && typeof value === "string"
        ? fieldValue.startsWith(value)
        : false;
    case "CONTAINS":
      return typeof fieldValue === "string" && typeof value === "string"
        ? fieldValue.includes(value)
        : false;
    case "OLDER_THAN_DAYS": {
      const date = coerceDate(fieldValue);
      const days = Number(value);
      if (!date || !Number.isFinite(days)) return false;
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - days);
      return date < cutoff;
    }
    case "WITHIN_LAST_DAYS": {
      const date = coerceDate(fieldValue);
      const days = Number(value);
      if (!date || !Number.isFinite(days)) return false;
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - days);
      return date >= cutoff;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Field path resolution
// ─────────────────────────────────────────────────────────────────────────────

export function resolveFieldPath(path: string, record: RecordLike): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─────────────────────────────────────────────────────────────────────────────
// Equality + comparison with type coercion
// ─────────────────────────────────────────────────────────────────────────────

function equalsValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Decimal equality
  if (a instanceof Decimal || b instanceof Decimal) {
    const ad = coerceDecimal(a);
    const bd = coerceDecimal(b);
    if (ad && bd) return ad.equals(bd);
    return false;
  }
  // Date equality
  if (a instanceof Date || b instanceof Date) {
    const ad = coerceDate(a);
    const bd = coerceDate(b);
    if (ad && bd) return ad.getTime() === bd.getTime();
    return false;
  }
  // Boolean strict equality
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  // Numbers vs numeric strings — DO coerce
  if (
    (typeof a === "number" && typeof b === "string") ||
    (typeof a === "string" && typeof b === "number")
  ) {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an === bn;
  }
  return false;
}

// Returns negative/zero/positive a-relative-to-b. Throws if non-comparable.
function compareValues(a: unknown, b: unknown): number {
  // Decimal path
  const ad = coerceDecimal(a);
  const bd = coerceDecimal(b);
  if (ad && bd) return ad.comparedTo(bd);
  // Date path
  const aDate = coerceDate(a);
  const bDate = coerceDate(b);
  if (aDate && bDate) return aDate.getTime() - bDate.getTime();
  // String path (lexicographic)
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  throw new EvaluatorError(
    `Cannot compare ${typeof a} and ${typeof b} (values: ${String(a)}, ${String(b)})`
  );
}

function coerceDecimal(v: unknown): Decimal | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Decimal) return v;
  if (typeof v === "number" && Number.isFinite(v)) return new Decimal(v);
  if (typeof v === "string") {
    try {
      return new Decimal(v);
    } catch {
      return null;
    }
  }
  // Prisma Decimal-like objects expose toString()
  if (
    typeof v === "object" &&
    "toString" in (v as object) &&
    typeof (v as { toString: unknown }).toString === "function"
  ) {
    try {
      const s = (v as { toString: () => string }).toString();
      const d = new Decimal(s);
      return d;
    } catch {
      return null;
    }
  }
  return null;
}

function coerceDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
