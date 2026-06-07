// Unit tests for the v0.7 NS multi-subsidiary mapper + orchestrator.
//
// Pure-function coverage:
//   - mapSubsidiary
//   - resolveEntityCode
//   - resolveEntityResolution (input shape fallback)
//
// Integration coverage of setupSubsidiaries lives in
// tests/netsuite-multi-subsidiary-integration.test.ts (Phase 2), which
// requires a real Postgres connection. Here we keep it pure so the
// tests run without DATABASE_URL.

import { describe, it, expect } from "vitest";

import {
  mapSubsidiary,
  resolveEntityCode,
  resolveEntityResolution,
  type EntityResolution,
} from "@/lib/mappers/netsuite/subsidiaries";
import type { NsSubsidiary } from "@/lib/mappers/netsuite/types";

describe("resolveEntityCode", () => {
  it("returns the literal entityCode in single mode", () => {
    const res: EntityResolution = { mode: "single", entityCode: "ACME" };
    expect(resolveEntityCode("1", res)).toBe("ACME");
    expect(resolveEntityCode("999", res)).toBe("ACME");
  });

  it("appends NS<internalid> to the prefix in multi mode", () => {
    const res: EntityResolution = { mode: "multi", entityCodePrefix: "ACME" };
    expect(resolveEntityCode("1", res)).toBe("ACME_NS1");
    expect(resolveEntityCode("42", res)).toBe("ACME_NS42");
  });

  it("handles long prefixes without collision", () => {
    const res: EntityResolution = {
      mode: "multi",
      entityCodePrefix: "VANDELAY_INDUSTRIES",
    };
    expect(resolveEntityCode("1", res)).toBe("VANDELAY_INDUSTRIES_NS1");
  });
});

describe("resolveEntityResolution (input shape backward compat)", () => {
  it("threads entityResolution through unchanged if provided", () => {
    const r: EntityResolution = { mode: "multi", entityCodePrefix: "X" };
    expect(resolveEntityResolution({ entityResolution: r })).toEqual(r);
  });

  it("converts legacy entityCode to single mode", () => {
    expect(resolveEntityResolution({ entityCode: "LEGACY" })).toEqual({
      mode: "single",
      entityCode: "LEGACY",
    });
  });

  it("entityResolution takes precedence when both fields present", () => {
    expect(
      resolveEntityResolution({
        entityCode: "ignored",
        entityResolution: { mode: "single", entityCode: "winner" },
      })
    ).toEqual({ mode: "single", entityCode: "winner" });
  });

  it("throws when neither field is provided", () => {
    expect(() => resolveEntityResolution({})).toThrow(/either/);
  });
});

describe("mapSubsidiary (pure mapper)", () => {
  const baseSub: NsSubsidiary = {
    internalid: "1",
    name: "Vandelay Industries",
    iselimination: false,
    currency: "USD",
    country: "US",
  };

  it("maps a flat top-level subsidiary in single mode", () => {
    const m = mapSubsidiary(baseSub, { mode: "single", entityCode: "ACME" });
    expect(m).toMatchObject({
      code: "ACME",
      internalid: "1",
      name: "Vandelay Industries",
      functionalCurrencyCode: "USD",
      parentInternalid: null,
      isElimination: false,
    });
    expect(m.sourcePayload).toBe(baseSub); // preserved by reference
  });

  it("maps in multi mode with prefix expansion", () => {
    const m = mapSubsidiary(baseSub, {
      mode: "multi",
      entityCodePrefix: "ACME",
    });
    expect(m.code).toBe("ACME_NS1");
  });

  it("extracts parentInternalid from NS parent ref", () => {
    const sub: NsSubsidiary = {
      ...baseSub,
      internalid: "2",
      name: "Vandelay USA",
      parent: { internalid: "1", name: "Vandelay Industries" },
    };
    const m = mapSubsidiary(sub, { mode: "multi", entityCodePrefix: "ACME" });
    expect(m.parentInternalid).toBe("1");
  });

  it("flags elimination subsidiaries", () => {
    const sub: NsSubsidiary = {
      ...baseSub,
      internalid: "3",
      name: "Vandelay Elimination",
      iselimination: true,
    };
    const m = mapSubsidiary(sub, { mode: "multi", entityCodePrefix: "ACME" });
    expect(m.isElimination).toBe(true);
  });

  it("preserves the original NsSubsidiary object byte-for-byte in sourcePayload", () => {
    // Critical for lineage replay — the reverse exporter reads
    // sourcePayload to reconstruct the NS export array without
    // re-deriving anything from the LegalEntity columns.
    const sub: NsSubsidiary = {
      internalid: "5",
      name: "Vandelay UK",
      iselimination: false,
      currency: "GBP",
      country: "GB",
      parent: { internalid: "1", name: "Vandelay Industries" },
    };
    const m = mapSubsidiary(sub, { mode: "multi", entityCodePrefix: "VAN" });
    expect(m.sourcePayload).toBe(sub);
    // Deep-equal sanity (in case `mapSubsidiary` ever does any cloning):
    expect(m.sourcePayload).toEqual(sub);
  });

  it("treats absent iselimination as false (defense vs malformed NS exports)", () => {
    // iselimination is required in the NsSubsidiary type, but NS
    // sometimes ships exports with the field omitted on older
    // SuiteScript versions. The strict-mode === true check catches
    // both undefined and false uniformly.
    const sub: NsSubsidiary = {
      ...baseSub,
      iselimination: undefined as unknown as boolean,
    };
    const m = mapSubsidiary(sub, { mode: "single", entityCode: "ACME" });
    expect(m.isElimination).toBe(false);
  });
});

describe("multi-sub hierarchy: 3-subsidiary group", () => {
  // Demonstrates the design's headline example: parent + 2 children,
  // verifying the mapper handles all three correctly even when the
  // input array order is mixed.
  const parent: NsSubsidiary = {
    internalid: "1",
    name: "Vandelay Industries",
    iselimination: false,
    currency: "USD",
    country: "US",
  };
  const usChild: NsSubsidiary = {
    internalid: "2",
    name: "Vandelay USA",
    iselimination: false,
    currency: "USD",
    country: "US",
    parent: { internalid: "1", name: "Vandelay Industries" },
  };
  const ukChild: NsSubsidiary = {
    internalid: "3",
    name: "Vandelay UK",
    iselimination: false,
    currency: "GBP",
    country: "GB",
    parent: { internalid: "1", name: "Vandelay Industries" },
  };

  const resolution: EntityResolution = {
    mode: "multi",
    entityCodePrefix: "VAN",
  };

  it("maps all three with the right hierarchy + currencies", () => {
    const m1 = mapSubsidiary(parent, resolution);
    const m2 = mapSubsidiary(usChild, resolution);
    const m3 = mapSubsidiary(ukChild, resolution);

    expect(m1.code).toBe("VAN_NS1");
    expect(m1.parentInternalid).toBeNull();

    expect(m2.code).toBe("VAN_NS2");
    expect(m2.parentInternalid).toBe("1");
    expect(m2.functionalCurrencyCode).toBe("USD");

    expect(m3.code).toBe("VAN_NS3");
    expect(m3.parentInternalid).toBe("1");
    expect(m3.functionalCurrencyCode).toBe("GBP");
  });

  it("input array order doesn't affect mapper output (defensive)", () => {
    // The orchestrator does a two-pass walk, but the pure mapper
    // should be order-independent too. Mapping child-then-parent is
    // identical to parent-then-child.
    const mChildFirst = [usChild, ukChild, parent].map((s) =>
      mapSubsidiary(s, resolution)
    );
    const mParentFirst = [parent, usChild, ukChild].map((s) =>
      mapSubsidiary(s, resolution)
    );
    expect(mChildFirst.find((x) => x.code === "VAN_NS1")?.parentInternalid).toBe(
      mParentFirst.find((x) => x.code === "VAN_NS1")?.parentInternalid
    );
  });
});
