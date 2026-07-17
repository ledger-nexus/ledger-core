// The assistant's read-only guarantee is capability-enforced, not just
// conventional: readOnlyDb wraps a Prisma client so mutations throw. This
// is DB-free — it drives a mock client, so it runs in every environment.

import { describe, it, expect } from "vitest";
import { readOnlyDb, ReadOnlyViolationError } from "@/lib/assistant/read-only-db";

function mockPrisma() {
  return {
    account: {
      findMany: async () => [{ code: "1000" }],
      findFirst: async () => ({ code: "1000" }),
      count: async () => 1,
      aggregate: async () => ({ _sum: { debit: 0 } }),
      groupBy: async () => [],
      // These must never actually run through the read-only port.
      create: async () => {
        throw new Error("real create ran");
      },
      update: async () => {
        throw new Error("real update ran");
      },
      updateMany: async () => {
        throw new Error("real updateMany ran");
      },
      delete: async () => {
        throw new Error("real delete ran");
      },
      deleteMany: async () => {
        throw new Error("real deleteMany ran");
      },
      upsert: async () => {
        throw new Error("real upsert ran");
      },
    },
    $queryRaw: async () => [{ n: 1 }],
    $queryRawUnsafe: async () => {
      throw new Error("real $queryRawUnsafe ran");
    },
    $executeRaw: async () => {
      throw new Error("real $executeRaw ran");
    },
    $transaction: async () => {
      throw new Error("real $transaction ran");
    },
  };
}

describe("readOnlyDb — capability-enforced read-only", () => {
  it("passes model reads through unchanged", async () => {
    const db = readOnlyDb(mockPrisma());
    expect(await db.account.findMany()).toEqual([{ code: "1000" }]);
    expect(await db.account.findFirst()).toEqual({ code: "1000" });
    expect(await db.account.count()).toBe(1);
    expect(await db.account.aggregate()).toEqual({ _sum: { debit: 0 } });
    expect(await db.account.groupBy()).toEqual([]);
  });

  it("blocks raw SQL — $queryRaw / $queryRawUnsafe throw (data-modifying CTE vector)", () => {
    // A `query` can mutate via `WITH x AS (UPDATE ... RETURNING ...) SELECT`,
    // so raw query methods are NOT a safe read boundary and must be blocked
    // alongside $executeRaw.
    const db = readOnlyDb(mockPrisma());
    expect(() => db.$queryRaw()).toThrow(ReadOnlyViolationError);
    expect(() => db.$queryRawUnsafe()).toThrow(ReadOnlyViolationError);
  });

  it("throws on every model write method — never runs the real one", () => {
    const db = readOnlyDb(mockPrisma());
    for (const method of [
      "create",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
      "upsert",
    ] as const) {
      expect(() => (db.account[method] as () => unknown)()).toThrow(
        ReadOnlyViolationError
      );
    }
  });

  it("throws on $executeRaw and $transaction", () => {
    const db = readOnlyDb(mockPrisma());
    expect(() => db.$executeRaw()).toThrow(ReadOnlyViolationError);
    expect(() => db.$transaction()).toThrow(ReadOnlyViolationError);
  });

  it("still passes typed model reads through (findMany/count unaffected)", async () => {
    const db = readOnlyDb(mockPrisma());
    expect(await db.account.findMany()).toEqual([{ code: "1000" }]);
    expect(await db.account.count()).toBe(1);
  });

  it("names the blocked op in the error", () => {
    const db = readOnlyDb(mockPrisma());
    expect(() => db.account.create()).toThrow(/account\.create/);
  });
});
