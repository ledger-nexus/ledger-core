// Code-rule registry — the escape hatch for the 5% of cases the declarative
// DSL can't express.
//
// Add a function here, give it a stable name, reference it from a CODE rule
// by that name. The function lives in code (reviewed in PR, unit-tested,
// type-checked), NOT in the database. The DB just holds a pointer.
//
// Signature: (record, context) => Target | null
//   record  — the resolved record, including any joined parent objects
//   context — trigger context (changed fields, transition, etc.)
//   returns — the target to reassign to, or null to not reassign
//
// Discipline:
//   - Stable function names (no breaking renames; instead deprecate + add)
//   - No side effects (no DB writes, no external API calls)
//   - Idempotent (same inputs → same output)
//   - Throwing is allowed if inputs are invalid (executor catches + logs)

import { type RecordLike, type Target, type TriggerContext } from "./types";

export type AssignmentFunction = (
  record: RecordLike,
  context: TriggerContext
) => Target | null;

// The registry. Add entries here when authoring new code rules.
//
// Examples (commented out — uncomment + adapt when needed):
//
// "ar-routing-by-region-v1": (record, _ctx) => {
//   const region = (record as { customer?: { region?: string } }).customer?.region;
//   if (region === "EMEA") return { type: "QUEUE", id: "<emea-queue-uuid>" };
//   if (region === "APAC") return { type: "QUEUE", id: "<apac-queue-uuid>" };
//   return { type: "QUEUE", id: "<americas-queue-uuid>" };
// },

const REGISTRY: Record<string, AssignmentFunction> = {};

export function registerCodeRule(name: string, fn: AssignmentFunction): void {
  if (REGISTRY[name]) {
    throw new Error(
      `Code rule "${name}" already registered — pick a new name or unregister first`
    );
  }
  REGISTRY[name] = fn;
}

export function isCodeRuleRegistered(name: string): boolean {
  return name in REGISTRY;
}

export function invokeCodeRule(
  name: string,
  record: RecordLike,
  context: TriggerContext
): Target | null {
  const fn = REGISTRY[name];
  if (!fn) {
    throw new Error(`Code rule "${name}" is not registered`);
  }
  return fn(record, context);
}

// Test helper — wipes the registry. Production code should never call this.
export function _clearRegistryForTesting(): void {
  for (const k of Object.keys(REGISTRY)) {
    delete REGISTRY[k];
  }
}

// Test helper — lets tests register and unregister freely.
export function _unregisterForTesting(name: string): void {
  delete REGISTRY[name];
}
