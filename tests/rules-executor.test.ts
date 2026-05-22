// Reassignment rules — executor unit tests. First-match-wins, trigger
// filtering, reassignment lock, code-rule dispatch.

import { describe, it, expect, beforeEach } from "vitest";
import { execute } from "../src/lib/rules/executor";
import {
  registerCodeRule,
  _clearRegistryForTesting,
} from "../src/lib/rules/registry";
import type {
  Rule,
  DeclarativeRule,
  CodeRule,
  TriggerContext,
} from "../src/lib/rules/types";

beforeEach(() => {
  _clearRegistryForTesting();
});

function declarative(overrides: Partial<DeclarativeRule>): DeclarativeRule {
  return {
    ruleId: "rule",
    ruleVersion: 1,
    recordType: "JournalEntry",
    trigger: "ON_INSERT",
    priority: 100,
    ruleType: "DECLARATIVE",
    criteria: { field: "status", op: "EQ", value: "DRAFT" },
    target: { type: "QUEUE", id: "queue-default" },
    isActive: true,
    ...overrides,
  };
}

describe("execute: first-match-wins", () => {
  it("returns the first matching rule's target", () => {
    const rules: Rule[] = [
      declarative({
        ruleId: "a",
        priority: 50,
        criteria: { field: "amount", op: "GT", value: 100000 },
        target: { type: "QUEUE", id: "queue-controller" },
      }),
      declarative({
        ruleId: "b",
        priority: 100,
        criteria: { field: "amount", op: "GT", value: 1000 },
        target: { type: "QUEUE", id: "queue-senior" },
      }),
    ];
    const r = execute({ amount: 200000 }, { type: "ON_INSERT" }, rules);
    expect(r.result?.ruleId).toBe("a");
    expect(r.result?.target?.id).toBe("queue-controller");
  });

  it("falls through to the second rule when first doesn't match", () => {
    const rules: Rule[] = [
      declarative({
        ruleId: "a",
        priority: 50,
        criteria: { field: "amount", op: "GT", value: 100000 },
        target: { type: "QUEUE", id: "queue-controller" },
      }),
      declarative({
        ruleId: "b",
        priority: 100,
        criteria: { field: "amount", op: "GT", value: 1000 },
        target: { type: "QUEUE", id: "queue-senior" },
      }),
    ];
    const r = execute({ amount: 5000 }, { type: "ON_INSERT" }, rules);
    expect(r.result?.ruleId).toBe("b");
  });

  it("returns no result when no rule matches", () => {
    const rules: Rule[] = [
      declarative({
        criteria: { field: "amount", op: "GT", value: 100000 },
      }),
    ];
    const r = execute({ amount: 5000 }, { type: "ON_INSERT" }, rules);
    expect(r.result).toBeNull();
    expect(r.considered).toBe(1);
  });

  it("skips inactive rules", () => {
    const rules: Rule[] = [
      declarative({
        ruleId: "a",
        priority: 50,
        isActive: false,
        criteria: { field: "amount", op: "GT", value: 0 },
        target: { type: "QUEUE", id: "should-not-fire" },
      }),
      declarative({
        ruleId: "b",
        priority: 100,
        criteria: { field: "amount", op: "GT", value: 0 },
        target: { type: "QUEUE", id: "should-fire" },
      }),
    ];
    const r = execute({ amount: 100 }, { type: "ON_INSERT" }, rules);
    expect(r.result?.ruleId).toBe("b");
  });
});

describe("execute: trigger filtering", () => {
  it("filters by trigger type", () => {
    const rules: Rule[] = [
      declarative({
        ruleId: "insert-rule",
        trigger: "ON_INSERT",
        criteria: { op: "AND", clauses: [] },
      }),
      declarative({
        ruleId: "update-rule",
        trigger: "ON_UPDATE",
        triggerFields: ["status"],
        criteria: { op: "AND", clauses: [] },
      }),
    ];
    const onInsert = execute({}, { type: "ON_INSERT" }, rules);
    expect(onInsert.result?.ruleId).toBe("insert-rule");

    const onUpdate = execute(
      {},
      { type: "ON_UPDATE", changedFields: ["status"] },
      rules
    );
    expect(onUpdate.result?.ruleId).toBe("update-rule");
  });

  it("ON_UPDATE skips rule when its triggerFields didn't change", () => {
    const rules: Rule[] = [
      declarative({
        ruleId: "x",
        trigger: "ON_UPDATE",
        triggerFields: ["amount"],
        criteria: { op: "AND", clauses: [] },
      }),
    ];
    const r = execute({}, { type: "ON_UPDATE", changedFields: ["memo"] }, rules);
    expect(r.result).toBeNull();
    expect(r.considered).toBe(0);
  });

  it("ON_STATE_TRANSITION filters by from/to", () => {
    const rules: Rule[] = [
      declarative({
        ruleId: "draft-to-pending",
        trigger: "ON_STATE_TRANSITION",
        triggerStateFrom: "DRAFT",
        triggerStateTo: "PENDING_APPROVAL",
        criteria: { op: "AND", clauses: [] },
      }),
    ];
    const matched = execute(
      {},
      { type: "ON_STATE_TRANSITION", stateFrom: "DRAFT", stateTo: "PENDING_APPROVAL" },
      rules
    );
    expect(matched.result?.ruleId).toBe("draft-to-pending");

    const wrongTransition = execute(
      {},
      { type: "ON_STATE_TRANSITION", stateFrom: "DRAFT", stateTo: "POSTED" },
      rules
    );
    expect(wrongTransition.result).toBeNull();
  });

  it("ON_USER_LIFECYCLE filters by lifecycleEvent", () => {
    const rules: Rule[] = [
      declarative({
        ruleId: "on-deactivation",
        trigger: "ON_USER_LIFECYCLE",
        triggerLifecycleEvent: "USER_DEACTIVATED",
        criteria: { op: "AND", clauses: [] },
      }),
    ];
    const matched = execute(
      {},
      { type: "ON_USER_LIFECYCLE", lifecycleEvent: "USER_DEACTIVATED" },
      rules
    );
    expect(matched.result?.ruleId).toBe("on-deactivation");

    const wrong = execute(
      {},
      { type: "ON_USER_LIFECYCLE", lifecycleEvent: "ROLE_REMOVED" },
      rules
    );
    expect(wrong.result).toBeNull();
  });
});

describe("execute: reassignment lock", () => {
  it("returns null when record has reassignmentLockedAt", () => {
    const rules: Rule[] = [
      declarative({ criteria: { op: "AND", clauses: [] } }),
    ];
    const r = execute(
      { status: "OPEN", reassignmentLockedAt: new Date() },
      { type: "ON_INSERT" },
      rules
    );
    expect(r.result).toBeNull();
    expect(r.considered).toBe(0);
  });
  it("considers rules when reassignmentLockedAt is null", () => {
    const rules: Rule[] = [
      declarative({ criteria: { op: "AND", clauses: [] } }),
    ];
    const r = execute(
      { status: "OPEN", reassignmentLockedAt: null },
      { type: "ON_INSERT" },
      rules
    );
    expect(r.result).not.toBeNull();
  });
});

describe("execute: code rules", () => {
  it("invokes registered function and uses its return value as target", () => {
    registerCodeRule("region-router", (record) => {
      const region = (record as { region?: string }).region;
      if (region === "EMEA") return { type: "QUEUE", id: "emea-queue" };
      return { type: "QUEUE", id: "default-queue" };
    });
    const rules: Rule[] = [
      {
        ruleId: "code-region",
        ruleVersion: 1,
        recordType: "JournalEntry",
        trigger: "ON_INSERT",
        priority: 100,
        ruleType: "CODE",
        codeImplementation: "region-router",
        isActive: true,
      } as CodeRule,
    ];
    const r = execute({ region: "EMEA" }, { type: "ON_INSERT" }, rules);
    expect(r.result?.target?.id).toBe("emea-queue");
    expect(r.result?.codeImplementation).toBe("region-router");
  });

  it("skips code rule when its function returns null (continues to next)", () => {
    registerCodeRule("never-matches", () => null);
    const rules: Rule[] = [
      {
        ruleId: "code-skip",
        ruleVersion: 1,
        recordType: "JournalEntry",
        trigger: "ON_INSERT",
        priority: 50,
        ruleType: "CODE",
        codeImplementation: "never-matches",
        isActive: true,
      } as CodeRule,
      declarative({
        ruleId: "fallback",
        priority: 100,
        criteria: { op: "AND", clauses: [] },
        target: { type: "QUEUE", id: "fallback-queue" },
      }),
    ];
    const r = execute({}, { type: "ON_INSERT" }, rules);
    expect(r.result?.ruleId).toBe("fallback");
  });

  it("code rule throwing is captured + execution continues", () => {
    registerCodeRule("throws", () => {
      throw new Error("boom");
    });
    const rules: Rule[] = [
      {
        ruleId: "bad-code",
        ruleVersion: 1,
        recordType: "JournalEntry",
        trigger: "ON_INSERT",
        priority: 50,
        ruleType: "CODE",
        codeImplementation: "throws",
        isActive: true,
      } as CodeRule,
      declarative({
        ruleId: "fallback",
        priority: 100,
        criteria: { op: "AND", clauses: [] },
        target: { type: "QUEUE", id: "fallback-queue" },
      }),
    ];
    const r = execute({}, { type: "ON_INSERT" }, rules);
    expect(r.result?.ruleId).toBe("fallback");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].ruleId).toBe("bad-code");
    expect(r.errors[0].error).toContain("boom");
  });
});
