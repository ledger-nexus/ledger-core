// Reassignment rules — validator unit tests.

import { describe, it, expect, beforeEach } from "vitest";
import { validateRule, validatePriorityNoCollision } from "../src/lib/rules/validator";
import {
  registerCodeRule,
  _clearRegistryForTesting,
} from "../src/lib/rules/registry";
import type { Rule, DeclarativeRule, CodeRule } from "../src/lib/rules/types";

beforeEach(() => {
  _clearRegistryForTesting();
});

function baseDeclarative(overrides: Partial<DeclarativeRule> = {}): DeclarativeRule {
  return {
    ruleId: "test-rule",
    ruleVersion: 1,
    recordType: "JournalEntry",
    trigger: "ON_INSERT",
    priority: 100,
    ruleType: "DECLARATIVE",
    criteria: { field: "status", op: "EQ", value: "DRAFT" },
    target: { type: "QUEUE", id: "00000000-0000-0000-0000-000000000001" },
    isActive: true,
    ...overrides,
  };
}

describe("validateRule: common fields", () => {
  it("accepts a minimal valid declarative rule", () => {
    const r = baseDeclarative();
    expect(validateRule(r)).toEqual({ ok: true, errors: [] });
  });

  it("rejects missing ruleId", () => {
    const r = baseDeclarative({ ruleId: "" });
    expect(validateRule(r).ok).toBe(false);
  });

  it("rejects negative priority", () => {
    const r = baseDeclarative({ priority: -1 });
    expect(validateRule(r).ok).toBe(false);
  });

  it("rejects non-integer ruleVersion", () => {
    const r = baseDeclarative({ ruleVersion: 1.5 });
    expect(validateRule(r).ok).toBe(false);
  });
});

describe("validateRule: trigger-specific requirements", () => {
  it("ON_UPDATE without triggerFields warns (counted as error in v1)", () => {
    const r = baseDeclarative({ trigger: "ON_UPDATE" });
    const v = validateRule(r);
    expect(v.errors.some((e) => e.includes("triggerFields"))).toBe(true);
  });
  it("ON_UPDATE with triggerFields passes", () => {
    const r = baseDeclarative({ trigger: "ON_UPDATE", triggerFields: ["status"] });
    expect(validateRule(r).ok).toBe(true);
  });
  it("ON_STATE_TRANSITION requires from/to", () => {
    const r = baseDeclarative({ trigger: "ON_STATE_TRANSITION" });
    expect(validateRule(r).ok).toBe(false);
  });
  it("ON_STATE_TRANSITION with from/to passes", () => {
    const r = baseDeclarative({
      trigger: "ON_STATE_TRANSITION",
      triggerStateFrom: "DRAFT",
      triggerStateTo: "PENDING_APPROVAL",
    });
    expect(validateRule(r).ok).toBe(true);
  });
  it("ON_SCHEDULE requires triggerSchedule", () => {
    const r = baseDeclarative({ trigger: "ON_SCHEDULE" });
    expect(validateRule(r).ok).toBe(false);
  });
  it("ON_USER_LIFECYCLE requires triggerLifecycleEvent", () => {
    const r = baseDeclarative({ trigger: "ON_USER_LIFECYCLE" });
    expect(validateRule(r).ok).toBe(false);
  });
});

describe("validateRule: declarative criteria", () => {
  it("rejects deep field paths (> 1 join)", () => {
    const r = baseDeclarative({
      criteria: { field: "customer.parent.industry.code", op: "EQ", value: "X" },
    });
    expect(validateRule(r).ok).toBe(false);
  });

  it("rejects unknown operator", () => {
    const r = baseDeclarative({
      // @ts-expect-error — intentionally invalid
      criteria: { field: "status", op: "MAYBE_EQ", value: "OPEN" },
    });
    expect(validateRule(r).ok).toBe(false);
  });

  it("rejects IS_NULL with a value", () => {
    const r = baseDeclarative({
      criteria: { field: "x", op: "IS_NULL", value: null },
    });
    expect(validateRule(r).ok).toBe(false);
  });

  it("rejects IN with non-array value", () => {
    const r = baseDeclarative({
      criteria: { field: "x", op: "IN", value: "abc" },
    });
    expect(validateRule(r).ok).toBe(false);
  });

  it("rejects STARTS_WITH with non-string value", () => {
    const r = baseDeclarative({
      criteria: { field: "x", op: "STARTS_WITH", value: 42 },
    });
    expect(validateRule(r).ok).toBe(false);
  });

  it("rejects OLDER_THAN_DAYS with non-integer", () => {
    const r = baseDeclarative({
      criteria: { field: "createdAt", op: "OLDER_THAN_DAYS", value: 30.5 },
    });
    expect(validateRule(r).ok).toBe(false);
  });

  it("rejects NOT with multiple clauses", () => {
    const r = baseDeclarative({
      criteria: {
        op: "NOT",
        clauses: [
          { field: "a", op: "EQ", value: 1 },
          { field: "b", op: "EQ", value: 2 },
        ],
      },
    });
    expect(validateRule(r).ok).toBe(false);
  });

  it("accepts nested AND/OR up to allowed depth", () => {
    const r = baseDeclarative({
      criteria: {
        op: "AND",
        clauses: [
          {
            op: "OR",
            clauses: [
              { field: "a", op: "EQ", value: 1 },
              { field: "b", op: "EQ", value: 2 },
            ],
          },
          { field: "c", op: "GT", value: 0 },
        ],
      },
    });
    expect(validateRule(r).ok).toBe(true);
  });

  it("rejects criteria tree exceeding max depth", () => {
    // Build a 6-level deep nested AND
    let inner: import("../src/lib/rules/types").Clause = {
      field: "x",
      op: "EQ",
      value: 1,
    };
    for (let i = 0; i < 6; i += 1) {
      inner = { op: "AND", clauses: [inner] };
    }
    const r = baseDeclarative({ criteria: inner });
    expect(validateRule(r).ok).toBe(false);
  });
});

describe("validateRule: target", () => {
  it("rejects missing target on declarative", () => {
    const r = baseDeclarative({ target: undefined as unknown as DeclarativeRule["target"] });
    expect(validateRule(r as Rule).ok).toBe(false);
  });
  it("rejects bad target type", () => {
    const r = baseDeclarative({
      target: { type: "GROUP" as "USER", id: "x" },
    });
    expect(validateRule(r).ok).toBe(false);
  });
});

describe("validateRule: code rules + registry", () => {
  function baseCode(overrides: Partial<CodeRule> = {}): CodeRule {
    return {
      ruleId: "code-rule",
      ruleVersion: 1,
      recordType: "JournalEntry",
      trigger: "ON_INSERT",
      priority: 50,
      ruleType: "CODE",
      codeImplementation: "test-fn",
      isActive: true,
      ...overrides,
    };
  }

  it("rejects code rule referencing unregistered function", () => {
    const r = baseCode();
    expect(validateRule(r).ok).toBe(false);
  });

  it("accepts code rule when function is registered", () => {
    registerCodeRule("test-fn", () => null);
    const r = baseCode();
    expect(validateRule(r).ok).toBe(true);
  });

  it("rejects code rule without codeImplementation", () => {
    const r = baseCode({ codeImplementation: undefined as unknown as string });
    expect(validateRule(r).ok).toBe(false);
  });
});

describe("validatePriorityNoCollision", () => {
  it("passes when active rules have distinct priorities", () => {
    const rules: Rule[] = [
      baseDeclarative({ ruleId: "a", priority: 100 }),
      baseDeclarative({ ruleId: "b", priority: 200 }),
    ];
    expect(validatePriorityNoCollision(rules).ok).toBe(true);
  });

  it("flags collision among active rules", () => {
    const rules: Rule[] = [
      baseDeclarative({ ruleId: "a", priority: 100 }),
      baseDeclarative({ ruleId: "b", priority: 100 }),
    ];
    const v = validatePriorityNoCollision(rules);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("Priority collision");
  });

  it("ignores inactive rules for collision check", () => {
    const rules: Rule[] = [
      baseDeclarative({ ruleId: "a", priority: 100 }),
      baseDeclarative({ ruleId: "b", priority: 100, isActive: false }),
    ];
    expect(validatePriorityNoCollision(rules).ok).toBe(true);
  });

  it("allows same priority across different recordTypes", () => {
    const rules: Rule[] = [
      baseDeclarative({ ruleId: "a", priority: 100, recordType: "JournalEntry" }),
      baseDeclarative({ ruleId: "b", priority: 100, recordType: "ArOpenItem" }),
    ];
    expect(validatePriorityNoCollision(rules).ok).toBe(true);
  });
});
