// Reassignment rules engine — DSL types.
//
// Design principles documented in docs/ownership-and-rules.md. Summary:
//
//   - Declarative-first; criteria are a small tree of operators
//   - Code-rule escape hatch (registered TS function) for the 5% the DSL
//     can't express
//   - First-match-wins by explicit priority
//   - Field paths support one level of parent join (record.parent.field)
//   - Versioned; new version = new row, old set to isActive=false

import { Decimal } from "@/lib/utils/decimal";

// ─────────────────────────────────────────────────────────────────────────────
// Operators
// ─────────────────────────────────────────────────────────────────────────────

// Equality / set
export type EqOp = "EQ" | "NEQ" | "IN" | "NOT_IN";
// Comparison (numbers, decimals, dates)
export type CmpOp = "GT" | "GTE" | "LT" | "LTE";
// Null checks
export type NullOp = "IS_NULL" | "IS_NOT_NULL";
// String
export type StringOp = "STARTS_WITH" | "CONTAINS";
// Date helpers
export type DateOp = "OLDER_THAN_DAYS" | "WITHIN_LAST_DAYS";

export type LeafOperator = EqOp | CmpOp | NullOp | StringOp | DateOp;

export const ALL_LEAF_OPERATORS: readonly LeafOperator[] = [
  "EQ", "NEQ", "IN", "NOT_IN",
  "GT", "GTE", "LT", "LTE",
  "IS_NULL", "IS_NOT_NULL",
  "STARTS_WITH", "CONTAINS",
  "OLDER_THAN_DAYS", "WITHIN_LAST_DAYS",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Criteria tree
// ─────────────────────────────────────────────────────────────────────────────

// A leaf clause: "field op value" or "field op" (for IS_NULL/IS_NOT_NULL).
export interface LeafClause {
  // Field path. Either a direct field ("amount") or one-level parent join
  // ("customer.creditRating"). Deeper paths are rejected at validation time.
  field: string;
  op: LeafOperator;
  // Optional because IS_NULL / IS_NOT_NULL don't take a value.
  value?: unknown;
}

// A branch: composed boolean expression over child clauses.
export interface BranchClause {
  op: "AND" | "OR" | "NOT";
  clauses: Clause[];
}

export type Clause = LeafClause | BranchClause;

export function isLeaf(c: Clause): c is LeafClause {
  return "field" in c;
}

export function isBranch(c: Clause): c is BranchClause {
  return "clauses" in c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Triggers
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerType =
  | "ON_INSERT"
  | "ON_UPDATE"
  | "ON_STATE_TRANSITION"
  | "ON_SCHEDULE"
  | "ON_USER_LIFECYCLE";

export interface TriggerContext {
  type: TriggerType;
  // For ON_UPDATE: which fields actually changed in this save.
  changedFields?: string[];
  // For ON_STATE_TRANSITION: the transition.
  stateFrom?: string;
  stateTo?: string;
  // For ON_USER_LIFECYCLE: the lifecycle event.
  lifecycleEvent?: "USER_DEACTIVATED" | "ROLE_REMOVED" | "SCOPE_REMOVED";
  // ON_SCHEDULE doesn't carry context beyond the firing time.
  firedAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule + Target
// ─────────────────────────────────────────────────────────────────────────────

export type OwnerType = "USER" | "QUEUE";

export interface Target {
  type: OwnerType;
  id: string;
}

// What the executor returns when a rule fires.
export interface RuleResult {
  matched: boolean;
  target: Target | null;
  ruleId: string;
  ruleVersion: number;
  // For code rules: the function name that decided the target.
  codeImplementation?: string;
}

// A declarative rule.
export interface DeclarativeRule {
  ruleId: string;
  ruleVersion: number;
  recordType: string;
  trigger: TriggerType;
  triggerFields?: string[];
  triggerStateFrom?: string;
  triggerStateTo?: string;
  triggerLifecycleEvent?: TriggerContext["lifecycleEvent"];
  triggerSchedule?: string;
  priority: number;
  ruleType: "DECLARATIVE";
  criteria: Clause;
  target: Target;
  isActive: boolean;
}

// A code rule — TS function does the work; criteria are not declarative.
export interface CodeRule {
  ruleId: string;
  ruleVersion: number;
  recordType: string;
  trigger: TriggerType;
  triggerFields?: string[];
  triggerStateFrom?: string;
  triggerStateTo?: string;
  triggerLifecycleEvent?: TriggerContext["lifecycleEvent"];
  triggerSchedule?: string;
  priority: number;
  ruleType: "CODE";
  codeImplementation: string; // registered function name
  isActive: boolean;
}

export type Rule = DeclarativeRule | CodeRule;

// ─────────────────────────────────────────────────────────────────────────────
// Comparable values
// ─────────────────────────────────────────────────────────────────────────────

// Values supported in clause `value`. The evaluator coerces on a best-effort
// basis (e.g. numeric strings → Decimal for comparison with Decimal fields).
export type RuleValue =
  | string
  | number
  | boolean
  | Date
  | Decimal
  | null
  | string[]
  | number[];

// A record passed to the evaluator. Plain object with arbitrary keys. The
// caller is responsible for including any parent records the rule's field
// paths reference — e.g. `record.customer.creditRating` requires the loaded
// object to have a `customer` property.
export type RecordLike = Record<string, unknown>;
