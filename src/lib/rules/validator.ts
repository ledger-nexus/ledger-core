// Reassignment rules — write-time validator.
//
// Validates a rule before it's persisted. Catches:
//   - Operator/field-shape mismatches (STARTS_WITH on non-string, etc.)
//   - Deep field paths (> 1 level of join)
//   - Missing required fields per trigger
//   - Criteria-tree depth exceeded
//   - Code-rule pointing at unregistered function
//
// Returns either { ok: true } or { ok: false, errors: [...] }. The caller
// is expected to reject the rule outright if invalid — no auto-fix.

import {
  type Rule,
  type Clause,
  type LeafClause,
  type LeafOperator,
  isLeaf,
  isBranch,
  ALL_LEAF_OPERATORS,
} from "./types";
import { isCodeRuleRegistered } from "./registry";

const MAX_FIELD_PATH_DEPTH = 2; // record.field OR record.parent.field
const MAX_CRITERIA_DEPTH = 4;   // 3 levels of nesting + leaf

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const STRING_OPS: LeafOperator[] = ["STARTS_WITH", "CONTAINS"];
const NUMERIC_OPS: LeafOperator[] = ["GT", "GTE", "LT", "LTE"];
const DATE_OPS: LeafOperator[] = ["OLDER_THAN_DAYS", "WITHIN_LAST_DAYS"];
const SET_OPS: LeafOperator[] = ["IN", "NOT_IN"];
const NO_VALUE_OPS: LeafOperator[] = ["IS_NULL", "IS_NOT_NULL"];

export function validateRule(rule: Rule): ValidationResult {
  const errors: string[] = [];

  // ─── Common fields ────────────────────────────────────────────────────────
  if (!rule.ruleId || rule.ruleId.length === 0) errors.push("ruleId required");
  if (!rule.recordType || rule.recordType.length === 0)
    errors.push("recordType required");
  if (!Number.isInteger(rule.priority) || rule.priority < 0)
    errors.push("priority must be a non-negative integer");
  if (!Number.isInteger(rule.ruleVersion) || rule.ruleVersion < 1)
    errors.push("ruleVersion must be a positive integer");

  // ─── Trigger-specific fields ──────────────────────────────────────────────
  switch (rule.trigger) {
    case "ON_UPDATE":
      // triggerFields is optional but recommended; without it, every save
      // re-evaluates every rule. We warn rather than error.
      if (!rule.triggerFields || rule.triggerFields.length === 0) {
        errors.push(
          "ON_UPDATE rule without triggerFields will fire on every save — recommend specifying"
        );
      }
      break;
    case "ON_STATE_TRANSITION":
      if (!rule.triggerStateFrom || !rule.triggerStateTo) {
        errors.push("ON_STATE_TRANSITION requires triggerStateFrom + triggerStateTo");
      }
      break;
    case "ON_SCHEDULE":
      if (!rule.triggerSchedule) {
        errors.push("ON_SCHEDULE requires triggerSchedule (cron expression)");
      }
      break;
    case "ON_USER_LIFECYCLE":
      if (!rule.triggerLifecycleEvent) {
        errors.push("ON_USER_LIFECYCLE requires triggerLifecycleEvent");
      }
      break;
  }

  // ─── Rule-type-specific ───────────────────────────────────────────────────
  if (rule.ruleType === "DECLARATIVE") {
    if (!rule.criteria) {
      errors.push("DECLARATIVE rule requires criteria");
    } else {
      validateClause(rule.criteria, 0, errors);
    }
    if (!rule.target) errors.push("DECLARATIVE rule requires target");
    else {
      if (rule.target.type !== "USER" && rule.target.type !== "QUEUE") {
        errors.push(`target.type must be USER or QUEUE (got ${rule.target.type})`);
      }
      if (!rule.target.id || rule.target.id.length === 0) {
        errors.push("target.id required");
      }
    }
  } else if (rule.ruleType === "CODE") {
    if (!rule.codeImplementation) {
      errors.push("CODE rule requires codeImplementation");
    } else if (!isCodeRuleRegistered(rule.codeImplementation)) {
      errors.push(
        `CODE rule references unregistered function "${rule.codeImplementation}" — register in src/lib/rules/registry.ts`
      );
    }
  } else {
    errors.push(`Unknown ruleType: ${(rule as { ruleType?: string }).ruleType}`);
  }

  return { ok: errors.length === 0, errors };
}

function validateClause(clause: Clause, depth: number, errors: string[]): void {
  if (depth > MAX_CRITERIA_DEPTH) {
    errors.push(
      `criteria tree exceeds max depth ${MAX_CRITERIA_DEPTH} — write a code rule instead`
    );
    return;
  }

  if (isLeaf(clause)) {
    validateLeaf(clause, errors);
    return;
  }
  if (isBranch(clause)) {
    if (clause.op === "NOT" && clause.clauses.length !== 1) {
      errors.push(`NOT requires exactly one child clause (got ${clause.clauses.length})`);
    }
    if ((clause.op === "AND" || clause.op === "OR") && clause.clauses.length === 0) {
      // Empty AND is "match all"; empty OR is "match none" — allowed but unusual.
      // Don't error, but consider warning. We allow without warning for catch-all rules.
    }
    for (const child of clause.clauses) {
      validateClause(child, depth + 1, errors);
    }
    return;
  }
  errors.push(`Unknown clause shape: ${JSON.stringify(clause)}`);
}

function validateLeaf(clause: LeafClause, errors: string[]): void {
  // Field path
  if (!clause.field || clause.field.length === 0) {
    errors.push("leaf clause requires non-empty field");
    return;
  }
  const parts = clause.field.split(".");
  if (parts.length > MAX_FIELD_PATH_DEPTH) {
    errors.push(
      `field path "${clause.field}" exceeds max depth ${MAX_FIELD_PATH_DEPTH} — use a code rule for deeper joins`
    );
  }

  // Operator validity
  if (!ALL_LEAF_OPERATORS.includes(clause.op)) {
    errors.push(`Unknown operator "${clause.op}" on field "${clause.field}"`);
    return;
  }

  // Value presence
  if (NO_VALUE_OPS.includes(clause.op)) {
    if (clause.value !== undefined) {
      errors.push(`${clause.op} on "${clause.field}" must not have a value`);
    }
  } else {
    if (clause.value === undefined) {
      errors.push(`${clause.op} on "${clause.field}" requires a value`);
    }
  }

  // Value-shape sanity
  if (SET_OPS.includes(clause.op)) {
    if (!Array.isArray(clause.value)) {
      errors.push(`${clause.op} on "${clause.field}" requires an array value`);
    }
  }
  if (STRING_OPS.includes(clause.op)) {
    if (typeof clause.value !== "string") {
      errors.push(`${clause.op} on "${clause.field}" requires a string value`);
    }
  }
  if (DATE_OPS.includes(clause.op)) {
    if (typeof clause.value !== "number" || !Number.isInteger(clause.value)) {
      errors.push(`${clause.op} on "${clause.field}" requires an integer day count`);
    }
  }
  if (NUMERIC_OPS.includes(clause.op)) {
    if (
      typeof clause.value !== "number" &&
      typeof clause.value !== "string" &&
      !(clause.value instanceof Date)
    ) {
      errors.push(
        `${clause.op} on "${clause.field}" requires a number, numeric string, or Date`
      );
    }
  }
}

// Cross-rule validation: rejects priority collisions among active rules for
// the same (recordType, trigger) tuple. Call this with the full active-rule
// set when a new rule is about to be saved.
export function validatePriorityNoCollision(rules: Rule[]): ValidationResult {
  const errors: string[] = [];
  const seen = new Map<string, Rule>();
  for (const r of rules) {
    if (!r.isActive) continue;
    const key = `${r.recordType}|${r.trigger}|${r.priority}`;
    const existing = seen.get(key);
    if (existing) {
      errors.push(
        `Priority collision: ${r.ruleId} and ${existing.ruleId} both at priority ${r.priority} for ${r.recordType} on ${r.trigger}`
      );
    } else {
      seen.set(key, r);
    }
  }
  return { ok: errors.length === 0, errors };
}
