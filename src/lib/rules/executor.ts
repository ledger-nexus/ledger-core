// Reassignment rules — executor.
//
// Given a record, a trigger context, and a set of candidate rules, returns
// the first matching rule's target (or null if none match).
//
// Ordering: rules already sorted by priority ASC (lower fires earlier).
// First-match-wins; subsequent matching rules are ignored.
//
// Trigger filtering: the executor short-circuits rules whose trigger doesn't
// match the context. For ON_UPDATE, it also checks that at least one of the
// rule's triggerFields actually changed (per the context.changedFields).
//
// Reassignment lock: if the record has a non-null `reassignmentLockedAt`,
// the executor returns null (rules are inert against locked records). Manual
// reassignment writes the lock; only an explicit unlock action clears it.
//
// Pure with respect to DB writes — the executor decides; the caller persists.

import { evaluate, EvaluatorError } from "./evaluator";
import { invokeCodeRule } from "./registry";
import {
  type Rule,
  type RecordLike,
  type TriggerContext,
  type RuleResult,
  type Target,
} from "./types";

export interface ExecutionResult {
  /** First rule that matched, or null if none did. */
  result: RuleResult | null;
  /** All rules considered (for diagnostic logging). */
  considered: number;
  /** Rules that errored during evaluation (logged, but did not block). */
  errors: Array<{ ruleId: string; error: string }>;
}

export function execute(
  record: RecordLike,
  context: TriggerContext,
  rules: Rule[]
): ExecutionResult {
  // Reassignment lock check.
  const lockedAt = (record as { reassignmentLockedAt?: unknown }).reassignmentLockedAt;
  if (lockedAt) {
    return { result: null, considered: 0, errors: [] };
  }

  let considered = 0;
  const errors: Array<{ ruleId: string; error: string }> = [];

  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (!triggerMatches(rule, context)) continue;
    considered += 1;

    try {
      if (rule.ruleType === "DECLARATIVE") {
        const matched = evaluate(rule.criteria, record);
        if (matched) {
          return {
            result: {
              matched: true,
              target: rule.target,
              ruleId: rule.ruleId,
              ruleVersion: rule.ruleVersion,
            },
            considered,
            errors,
          };
        }
      } else if (rule.ruleType === "CODE") {
        const target: Target | null = invokeCodeRule(
          rule.codeImplementation,
          record,
          context
        );
        if (target !== null) {
          return {
            result: {
              matched: true,
              target,
              ruleId: rule.ruleId,
              ruleVersion: rule.ruleVersion,
              codeImplementation: rule.codeImplementation,
            },
            considered,
            errors,
          };
        }
      }
    } catch (e) {
      errors.push({
        ruleId: rule.ruleId,
        error: e instanceof EvaluatorError
          ? `evaluator: ${e.message}`
          : e instanceof Error
            ? e.message
            : "unknown error",
      });
      // Continue to next rule — one bad rule shouldn't block the others.
    }
  }

  return { result: null, considered, errors };
}

function triggerMatches(rule: Rule, context: TriggerContext): boolean {
  if (rule.trigger !== context.type) return false;

  switch (context.type) {
    case "ON_INSERT":
      return true;

    case "ON_UPDATE": {
      // If the rule lists triggerFields, at least one must have changed.
      // Empty triggerFields (or undefined) = re-evaluate on any save.
      if (rule.triggerFields && rule.triggerFields.length > 0) {
        const changed = context.changedFields ?? [];
        return rule.triggerFields.some((f) => changed.includes(f));
      }
      return true;
    }

    case "ON_STATE_TRANSITION":
      if (rule.triggerStateFrom && rule.triggerStateFrom !== context.stateFrom) return false;
      if (rule.triggerStateTo && rule.triggerStateTo !== context.stateTo) return false;
      return true;

    case "ON_USER_LIFECYCLE":
      return rule.triggerLifecycleEvent === context.lifecycleEvent;

    case "ON_SCHEDULE":
      // Schedule matching happens at the scanner layer (cron picks which rules
      // to evaluate). Once invoked here, we trust the schedule already matched.
      return true;
  }
}
