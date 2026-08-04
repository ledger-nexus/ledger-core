// The assistant's read-only guarantee is capability-enforced by an ALLOWLIST:
// only pure read delegate methods pass; every `$` client method and every
// other delegate function is rejected. DB-free — drives a mock client, so it
// runs everywhere.

import { describe, it, expect } from "vitest";
import { readOnlyDb, ReadOnlyViolationError } from "@/lib/assistant/read-only-db";

const READ_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

function mockPrisma() {
  const ranReal = () => {
    throw new Error("the real (non-read) method ran — the port did not block it");
  };
  return {
    account: {
      // reads — allowlisted
      findUnique: async () => ({ code: "1000" }),
      findUniqueOrThrow: async () => ({ code: "1000" }),
      findFirst: async () => ({ code: "1000" }),
      findFirstOrThrow: async () => ({ code: "1000" }),
      findMany: async () => [{ code: "1000" }],
      count: async () => 1,
      aggregate: async () => ({ _sum: { debit: 0 } }),
      groupBy: async () => [],
      // writes + a hypothetical future method — must be blocked
      create: ranReal,
      update: ranReal,
      updateMany: ranReal,
      delete: ranReal,
      deleteMany: ranReal,
      upsert: ranReal,
      someFutureMethod: ranReal,
      // non-function metadata — passes through untouched
      fields: { code: { name: "code" } },
    },
    // Every `$` client method must be rejected, including $extends (which
    // would otherwise hand back an UNWRAPPED, writable client) and the raw
    // families in all their spellings.
    $extends: (_ext?: unknown) => ({ account: { create: ranReal } }),
    $transaction: ranReal,
    $executeRaw: ranReal,
    $executeRawUnsafe: ranReal,
    $executeRawInternal: ranReal,
    $queryRaw: ranReal,
    $queryRawUnsafe: ranReal,
    $queryRawTyped: ranReal,
    $connect: ranReal,
  };
}

describe("readOnlyDb — allowlist-enforced read-only", () => {
  it("passes every allowlisted read method through", async () => {
    const db = readOnlyDb(mockPrisma());
    for (const m of READ_METHODS) {
      // Each returns without throwing.
      await (db.account[m] as () => Promise<unknown>)();
    }
    expect(await db.account.findMany()).toEqual([{ code: "1000" }]);
    expect(await db.account.count()).toBe(1);
  });

  it("passes non-function delegate metadata through (e.g. .fields)", () => {
    const db = readOnlyDb(mockPrisma());
    expect(db.account.fields).toEqual({ code: { name: "code" } });
  });

  it("blocks $extends — no unwrapped, writable client escapes", () => {
    const db = readOnlyDb(mockPrisma());
    expect(() => db.$extends({})).toThrow(ReadOnlyViolationError);
  });

  it("blocks the whole raw-SQL family + $transaction (every spelling)", () => {
    const db = readOnlyDb(mockPrisma());
    for (const m of [
      "$executeRaw",
      "$executeRawUnsafe",
      "$executeRawInternal",
      "$queryRaw",
      "$queryRawUnsafe",
      "$queryRawTyped",
      "$transaction",
      "$connect",
    ] as const) {
      expect(() => (db[m] as () => unknown)()).toThrow(ReadOnlyViolationError);
    }
  });

  it("blocks model write methods", () => {
    const db = readOnlyDb(mockPrisma());
    for (const m of ["create", "update", "updateMany", "delete", "deleteMany", "upsert"] as const) {
      expect(() => (db.account[m] as () => unknown)()).toThrow(ReadOnlyViolationError);
    }
  });

  it("blocks an unknown/future delegate method (default-deny)", () => {
    const db = readOnlyDb(mockPrisma());
    expect(() => (db.account.someFutureMethod as () => unknown)()).toThrow(
      ReadOnlyViolationError
    );
  });

  it("names the blocked op in the error", () => {
    const db = readOnlyDb(mockPrisma());
    expect(() => (db.account.create as () => unknown)()).toThrow(/account\.create/);
    expect(() => db.$extends({})).toThrow(/\$extends/);
  });
});
