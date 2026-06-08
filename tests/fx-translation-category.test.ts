// v0.8 FX Phase 4a — pure-logic + integration tests for the
// translationCategory column.
//
// What this covers:
//   - defaultTranslationCategory: per-type mapping + FX_GAIN_LOSS override
//   - Migration backfill: every account in the dev DB has a category
//     consistent with its type and subtype (proves the SQL UPDATE
//     paths fire in the right order)
//   - New seed accounts (Northwind chart) end up with categories set
//
// Phase 4b will add the translator that consumes this field. Phase 4c
// wires it into the consolidation report.

import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { defaultTranslationCategory } from "@/lib/db/chart-of-accounts";

const prisma = new PrismaClient();

describe("defaultTranslationCategory (pure)", () => {
  it("maps ASSET + LIABILITY to CURRENT_RATE", () => {
    expect(defaultTranslationCategory({ type: "ASSET" })).toBe("CURRENT_RATE");
    expect(defaultTranslationCategory({ type: "LIABILITY" })).toBe("CURRENT_RATE");
  });

  it("maps EQUITY to HISTORICAL", () => {
    expect(defaultTranslationCategory({ type: "EQUITY" })).toBe("HISTORICAL");
  });

  it("maps REVENUE + EXPENSE to WEIGHTED_AVG", () => {
    expect(defaultTranslationCategory({ type: "REVENUE" })).toBe("WEIGHTED_AVG");
    expect(defaultTranslationCategory({ type: "EXPENSE" })).toBe("WEIGHTED_AVG");
  });

  it("FX_GAIN_LOSS subtype overrides to EXCLUDED regardless of type", () => {
    // Currently chart-of-accounts has 8300 as EXPENSE; the override
    // must win over the EXPENSE → WEIGHTED_AVG default.
    expect(
      defaultTranslationCategory({ type: "EXPENSE", subtype: "FX_GAIN_LOSS" })
    ).toBe("EXCLUDED");
    // Also fires if someone classifies FX_GAIN_LOSS under REVENUE
    // (occasionally happens for gain-dominant operations).
    expect(
      defaultTranslationCategory({ type: "REVENUE", subtype: "FX_GAIN_LOSS" })
    ).toBe("EXCLUDED");
  });
});

describe("migration backfill (vs dev DB)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("every account has translationCategory populated", async () => {
    const unmapped = await prisma.account.count({
      where: { translationCategory: null },
    });
    expect(unmapped).toBe(0);
  });

  it("ASSET + LIABILITY accounts are all CURRENT_RATE", async () => {
    const wrong = await prisma.account.count({
      where: {
        type: { in: ["ASSET", "LIABILITY"] },
        NOT: { translationCategory: "CURRENT_RATE" },
      },
    });
    expect(wrong).toBe(0);
  });

  it("EQUITY accounts are all HISTORICAL", async () => {
    const wrong = await prisma.account.count({
      where: {
        type: "EQUITY",
        NOT: { translationCategory: "HISTORICAL" },
      },
    });
    expect(wrong).toBe(0);
  });

  it("FX_GAIN_LOSS subtype is EXCLUDED (subtype override beats type default)", async () => {
    // The subtype rule applies whether the account exists on the
    // global chart or attached to an entity.
    const fxRows = await prisma.account.findMany({
      where: { subtype: "FX_GAIN_LOSS" },
      select: { code: true, translationCategory: true },
    });
    expect(fxRows.length).toBeGreaterThan(0);
    for (const a of fxRows) {
      expect(a.translationCategory).toBe("EXCLUDED");
    }
  });

  it("REVENUE + EXPENSE accounts (excluding FX_GAIN_LOSS) are WEIGHTED_AVG", async () => {
    const wrong = await prisma.account.count({
      where: {
        type: { in: ["REVENUE", "EXPENSE"] },
        NOT: [
          { translationCategory: "WEIGHTED_AVG" },
          { subtype: "FX_GAIN_LOSS" },
        ],
      },
    });
    expect(wrong).toBe(0);
  });
});
