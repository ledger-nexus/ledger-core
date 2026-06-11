// Rules engine integration tests. Uses a mock PrismaClient surface — small
// deviation from the repo's "real DB" testing convention because these tests
// cover the orchestration logic (load rules → run executor → call reassign)
// rather than DB behavior per se. Integration tests against a real DB would
// duplicate most of these scenarios; the unit form is faster and catches the
// branching logic.

import { describe, it, expect } from "vitest";
import {
  fireRulesForRecord,
  loadActiveRules,
  fireInsertRules,
  fireUpdateRules,
} from "../src/lib/rules/integration";
import type { PrismaClient } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Mock PrismaClient surface — only the methods integration.ts actually calls.
// ─────────────────────────────────────────────────────────────────────────────

interface MockState {
  reassignmentRules: Array<Record<string, unknown>>;
  journalEntries: Map<string, Record<string, unknown>>;
  arOpenItems: Map<string, Record<string, unknown>>;
  users: Map<string, { id: string; isActive: boolean }>;
  queues: Map<string, { id: string; isActive: boolean; deletedAt: Date | null }>;
  recordEvents: Array<Record<string, unknown>>;
  reassignmentCalls: Array<Record<string, unknown>>;
}

function makeMockPrisma(state: MockState): PrismaClient {
  const tx = makeTxOps(state);
  // Both the top-level client and $transaction's tx use the same operations.
  const mock: Record<string, unknown> = {
    ...tx,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
  return mock as unknown as PrismaClient;
}

function makeTxOps(state: MockState) {
  return {
    reassignmentRule: {
      findMany: async (args: { where: { recordType: string; trigger: string; isActive: boolean } }) => {
        return state.reassignmentRules.filter(
          (r) =>
            r.recordType === args.where.recordType &&
            r.trigger === args.where.trigger &&
            r.isActive === args.where.isActive
        );
      },
    },
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        state.users.get(args.where.id) ?? null,
    },
    queue: {
      findUnique: async (args: { where: { id: string } }) =>
        state.queues.get(args.where.id) ?? null,
    },
    journalEntry: {
      findUnique: async (args: { where: { id: string } }) =>
        state.journalEntries.get(args.where.id) ?? null,
      // `reassignJournalEntry` uses `findFirst` (compound where with optional
      // tenant filter). Same lookup semantics for the test surface — tests
      // never pass actorTenantId.
      findFirst: async (args: { where: { id: string } }) =>
        state.journalEntries.get(args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = state.journalEntries.get(args.where.id);
        if (existing) Object.assign(existing, args.data);
        return existing;
      },
    },
    arOpenItem: {
      findUnique: async (args: { where: { id: string } }) =>
        state.arOpenItems.get(args.where.id) ?? null,
      // `reassignArOpenItem` uses `findFirst` (compound where with optional
      // tenant filter via actorTenantId). Tests don't pass tenant scope,
      // so this mirrors findUnique.
      findFirst: async (args: { where: { id: string } }) =>
        state.arOpenItems.get(args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = state.arOpenItems.get(args.where.id);
        if (existing) Object.assign(existing, args.data);
        return existing;
      },
    },
    recordEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `evt-${state.recordEvents.length + 1}`, ...args.data };
        state.recordEvents.push(row);
        return row;
      },
    },
  };
}

function emptyState(): MockState {
  return {
    reassignmentRules: [],
    journalEntries: new Map(),
    arOpenItems: new Map(),
    users: new Map(),
    queues: new Map(),
    recordEvents: [],
    reassignmentCalls: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadActiveRules", () => {
  it("returns DB rows as typed Rule objects, sorted by priority", async () => {
    const state = emptyState();
    state.reassignmentRules = [
      {
        ruleId: "rule-a",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 50,
        ruleType: "DECLARATIVE",
        criteriaJson: { field: "status", op: "EQ", value: "OPEN" },
        triggerFields: [],
        targetType: "QUEUE",
        targetId: "queue-1",
        isActive: true,
      },
    ];
    const prisma = makeMockPrisma(state);
    const rules = await loadActiveRules(prisma, "ArOpenItem", "ON_INSERT");
    expect(rules).toHaveLength(1);
    expect(rules[0].ruleType).toBe("DECLARATIVE");
    expect(rules[0].ruleId).toBe("rule-a");
  });

  it("skips malformed declarative rules (no criteria / target)", async () => {
    const state = emptyState();
    state.reassignmentRules = [
      {
        ruleId: "broken",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 50,
        ruleType: "DECLARATIVE",
        criteriaJson: null,
        triggerFields: [],
        targetType: null,
        targetId: null,
        isActive: true,
      },
    ];
    const prisma = makeMockPrisma(state);
    const rules = await loadActiveRules(prisma, "ArOpenItem", "ON_INSERT");
    expect(rules).toHaveLength(0);
  });
});

describe("fireRulesForRecord: declarative", () => {
  it("matching rule triggers reassignment", async () => {
    const state = emptyState();
    state.arOpenItems.set("ar-1", {
      id: "ar-1",
      status: "OPEN",
      ownerId: "user-1",
      ownerType: "USER",
      daysOverdue: 75,
    });
    state.queues.set("queue-senior", {
      id: "queue-senior",
      isActive: true,
      deletedAt: null,
    });
    state.reassignmentRules = [
      {
        ruleId: "escalate-60-days",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 100,
        ruleType: "DECLARATIVE",
        triggerFields: [],
        criteriaJson: { field: "daysOverdue", op: "GT", value: 60 },
        targetType: "QUEUE",
        targetId: "queue-senior",
        isActive: true,
      },
    ];

    const prisma = makeMockPrisma(state);
    const result = await fireRulesForRecord(prisma, {
      recordType: "ArOpenItem",
      recordId: "ar-1",
      record: { status: "OPEN", daysOverdue: 75 },
      triggerContext: { type: "ON_INSERT" },
      actorUserId: "system",
    });

    expect(result.reassigned).toBe(true);
    expect(result.newOwner?.type).toBe("QUEUE");
    expect(result.newOwner?.id).toBe("queue-senior");
    // Record event written.
    expect(state.recordEvents).toHaveLength(1);
    expect(state.recordEvents[0].eventType).toBe("OWNER_CHANGED");
    expect(state.recordEvents[0].actorReason).toBe("rule:escalate-60-days:v1");
  });

  it("non-matching rule leaves owner unchanged", async () => {
    const state = emptyState();
    state.arOpenItems.set("ar-2", {
      id: "ar-2",
      status: "OPEN",
      ownerId: "user-1",
      ownerType: "USER",
      daysOverdue: 5,
    });
    state.reassignmentRules = [
      {
        ruleId: "rule",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 100,
        ruleType: "DECLARATIVE",
        triggerFields: [],
        criteriaJson: { field: "daysOverdue", op: "GT", value: 60 },
        targetType: "QUEUE",
        targetId: "queue-x",
        isActive: true,
      },
    ];

    const prisma = makeMockPrisma(state);
    const result = await fireRulesForRecord(prisma, {
      recordType: "ArOpenItem",
      recordId: "ar-2",
      record: { status: "OPEN", daysOverdue: 5 },
      triggerContext: { type: "ON_INSERT" },
      actorUserId: "system",
    });

    expect(result.reassigned).toBe(false);
    expect(state.recordEvents).toHaveLength(0);
  });

  it("rule fires successfully but reassignment target is invalid → surfaces error", async () => {
    const state = emptyState();
    state.arOpenItems.set("ar-3", {
      id: "ar-3",
      status: "OPEN",
      ownerId: "user-1",
      ownerType: "USER",
    });
    // Target queue does NOT exist in state.queues
    state.reassignmentRules = [
      {
        ruleId: "fires-but-bad-target",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 100,
        ruleType: "DECLARATIVE",
        triggerFields: [],
        criteriaJson: { op: "AND", clauses: [] }, // matches all
        targetType: "QUEUE",
        targetId: "nonexistent-queue",
        isActive: true,
      },
    ];

    const prisma = makeMockPrisma(state);
    const result = await fireRulesForRecord(prisma, {
      recordType: "ArOpenItem",
      recordId: "ar-3",
      record: { status: "OPEN" },
      triggerContext: { type: "ON_INSERT" },
      actorUserId: "system",
    });

    expect(result.reassigned).toBe(false);
    expect(result.reassignError).toBeDefined();
    expect(result.reassignError?.code).toBe("OWNER_NOT_FOUND");
  });

  it("first-match-wins by priority", async () => {
    const state = emptyState();
    state.arOpenItems.set("ar-4", {
      id: "ar-4",
      status: "OPEN",
      ownerId: "user-1",
      ownerType: "USER",
      amount: 100000,
    });
    state.queues.set("queue-high", { id: "queue-high", isActive: true, deletedAt: null });
    state.queues.set("queue-normal", { id: "queue-normal", isActive: true, deletedAt: null });
    state.reassignmentRules = [
      {
        ruleId: "high",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 50,
        ruleType: "DECLARATIVE",
        triggerFields: [],
        criteriaJson: { field: "amount", op: "GT", value: 50000 },
        targetType: "QUEUE",
        targetId: "queue-high",
        isActive: true,
      },
      {
        ruleId: "normal",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 100,
        ruleType: "DECLARATIVE",
        triggerFields: [],
        criteriaJson: { field: "amount", op: "GT", value: 0 },
        targetType: "QUEUE",
        targetId: "queue-normal",
        isActive: true,
      },
    ];

    const prisma = makeMockPrisma(state);
    const result = await fireRulesForRecord(prisma, {
      recordType: "ArOpenItem",
      recordId: "ar-4",
      record: { status: "OPEN", amount: 100000 },
      triggerContext: { type: "ON_INSERT" },
      actorUserId: "system",
    });

    expect(result.newOwner?.id).toBe("queue-high");
  });
});

describe("fireInsertRules + fireUpdateRules convenience wrappers", () => {
  it("fireInsertRules uses ON_INSERT trigger context", async () => {
    const state = emptyState();
    state.arOpenItems.set("ar-5", {
      id: "ar-5",
      status: "OPEN",
      ownerId: null,
      ownerType: "USER",
    });
    state.queues.set("q-1", { id: "q-1", isActive: true, deletedAt: null });
    state.reassignmentRules = [
      {
        ruleId: "insert-rule",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 100,
        ruleType: "DECLARATIVE",
        triggerFields: [],
        criteriaJson: { op: "AND", clauses: [] },
        targetType: "QUEUE",
        targetId: "q-1",
        isActive: true,
      },
      {
        ruleId: "update-rule",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_UPDATE",
        priority: 100,
        ruleType: "DECLARATIVE",
        triggerFields: [],
        criteriaJson: { op: "AND", clauses: [] },
        targetType: "QUEUE",
        targetId: "q-1",
        isActive: true,
      },
    ];

    const prisma = makeMockPrisma(state);
    const result = await fireInsertRules(
      prisma,
      "ArOpenItem",
      "ar-5",
      { status: "OPEN" },
      "system"
    );

    expect(result.reassigned).toBe(true);
    expect(result.execution.result?.ruleId).toBe("insert-rule");
  });

  it("fireUpdateRules passes changedFields through", async () => {
    const state = emptyState();
    state.arOpenItems.set("ar-6", {
      id: "ar-6",
      status: "PARTIAL",
      ownerId: null,
      ownerType: "USER",
    });
    state.queues.set("q-x", { id: "q-x", isActive: true, deletedAt: null });
    state.reassignmentRules = [
      {
        ruleId: "status-change",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_UPDATE",
        priority: 100,
        ruleType: "DECLARATIVE",
        triggerFields: ["status"],
        criteriaJson: { field: "status", op: "EQ", value: "PARTIAL" },
        targetType: "QUEUE",
        targetId: "q-x",
        isActive: true,
      },
    ];

    const prisma = makeMockPrisma(state);

    // changedFields includes "status" — rule fires
    const r1 = await fireUpdateRules(
      prisma,
      "ArOpenItem",
      "ar-6",
      { status: "PARTIAL" },
      ["status"],
      "system"
    );
    expect(r1.reassigned).toBe(true);

    // Wipe owner + lock to test that changedFields=["memo"] doesn't fire.
    state.arOpenItems.set("ar-6", {
      id: "ar-6",
      status: "PARTIAL",
      ownerId: null,
      ownerType: "USER",
    });
    const r2 = await fireUpdateRules(
      prisma,
      "ArOpenItem",
      "ar-6",
      { status: "PARTIAL" },
      ["memo"], // doesn't match triggerFields
      "system"
    );
    expect(r2.reassigned).toBe(false);
  });
});

describe("fireRulesForRecord: locked records", () => {
  it("skips firing when reassignmentLockedAt is set", async () => {
    const state = emptyState();
    state.arOpenItems.set("ar-7", {
      id: "ar-7",
      status: "OPEN",
      ownerId: "user-1",
      ownerType: "USER",
      reassignmentLockedAt: new Date(),
    });
    state.queues.set("q-1", { id: "q-1", isActive: true, deletedAt: null });
    state.reassignmentRules = [
      {
        ruleId: "rule",
        ruleVersion: 1,
        recordType: "ArOpenItem",
        trigger: "ON_INSERT",
        priority: 100,
        ruleType: "DECLARATIVE",
        triggerFields: [],
        criteriaJson: { op: "AND", clauses: [] },
        targetType: "QUEUE",
        targetId: "q-1",
        isActive: true,
      },
    ];

    const prisma = makeMockPrisma(state);
    const result = await fireRulesForRecord(prisma, {
      recordType: "ArOpenItem",
      recordId: "ar-7",
      record: { status: "OPEN", reassignmentLockedAt: new Date() },
      triggerContext: { type: "ON_INSERT" },
      actorUserId: "system",
    });

    expect(result.reassigned).toBe(false);
    expect(result.execution.considered).toBe(0);
  });
});
