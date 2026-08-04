// Entity-scope resolution — the rule that decides WHICH account a code
// means when a subsidiary defines its own and the tenant also has a
// shared one. Pure; no DB.
//
// This lived as three subtly different copies inside postJournalEntry
// alone (accounts, parties, items) plus one each in the allocation,
// translation, and intercompany modules. These cases pin the semantics
// the copies are now collapsed onto.

import { describe, expect, it } from "vitest";

import {
  entityScopedPool,
  indexEntityScopedByCode,
  pickEntityScoped,
} from "@/lib/accounting/entity-scope";

const ENTITY = "entity-1";
const SIBLING = "entity-2";

describe("entity scope", () => {
  it("the entity's own row shadows the shared one", () => {
    const rows = [
      { code: "6100", entityId: null, tag: "shared" },
      { code: "6100", entityId: ENTITY, tag: "own" },
    ];
    expect(pickEntityScoped(rows, ENTITY)?.tag).toBe("own");
    // Order must not matter — the shared row arriving second was the
    // shape that made the old post-journal condition hard to read.
    expect(pickEntityScoped([...rows].reverse(), ENTITY)?.tag).toBe("own");
  });

  it("falls back to the shared row when the entity has none", () => {
    const rows = [{ code: "6100", entityId: null, tag: "shared" }];
    expect(pickEntityScoped(rows, ENTITY)?.tag).toBe("shared");
  });

  it("a sibling's row is out of scope entirely — never a fallback", () => {
    const rows = [{ code: "6100", entityId: SIBLING, tag: "sibling" }];
    expect(pickEntityScoped(rows, ENTITY)).toBeUndefined();
    expect(indexEntityScopedByCode(rows, ENTITY).size).toBe(0);
  });

  it("the pool is one tier only, so callers can refuse on ambiguity", () => {
    const rows = [
      { code: "6100", entityId: null },
      { code: "6100", entityId: ENTITY },
      { code: "6100", entityId: ENTITY },
    ];
    // Two entity-scoped candidates: ambiguous. The shared row must NOT
    // pad the pool — that would hide the ambiguity from the caller
    // (intercompany refuses on pool.length > 1 rather than guessing).
    expect(entityScopedPool(rows, ENTITY)).toHaveLength(2);
  });

  it("indexes many codes at once, resolving each independently", () => {
    const rows = [
      { code: "1000", entityId: null, tag: "cash-shared" },
      { code: "6100", entityId: null, tag: "ovh-shared" },
      { code: "6100", entityId: ENTITY, tag: "ovh-own" },
      { code: "7000", entityId: SIBLING, tag: "sibling-only" },
    ];
    const byCode = indexEntityScopedByCode(rows, ENTITY);
    expect(byCode.get("1000")?.tag).toBe("cash-shared");
    expect(byCode.get("6100")?.tag).toBe("ovh-own");
    expect(byCode.has("7000")).toBe(false);
  });
});
