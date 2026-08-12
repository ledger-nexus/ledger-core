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
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

import { CHART_OF_ACCOUNTS, defaultTranslationCategory } from "@/lib/db/chart-of-accounts";

const prisma = new PrismaClient();

/**
 * The rows the migration backfill + chart defaults actually own.
 *
 * ⚠️ THREE OF THE FOUR DB TESTS BELOW USED TO COUNT OVER THE WHOLE `account`
 * TABLE — no tenant, no entity, no sourceSystem filter — while the fourth was
 * scoped and carried a comment explaining exactly why it had to be. On the
 * shared dev database that means every one of the ~293 tenants is in range,
 * so any fixture anywhere that creates an ASSET with a non-CURRENT_RATE
 * category fails this suite, and the failure names a file that has nothing to
 * do with the account. Demonstrated: one planted account on a throwaway
 * tenant turned "ASSET + LIABILITY are all CURRENT_RATE" red with
 * `expected 1 to be +0`.
 *
 * The invariant these tests exist for is "the backfill and the chart defaults
 * agree with defaultTranslationCategory", and that is a claim about the
 * canonical chart on the seed entities — NOT about every row any test has
 * ever written. NS-imported rows and ad-hoc fixtures are nullable by design
 * (the consolidation translator defaults null to CURRENT_RATE).
 *
 * ⚠️ It also WIDENS in one direction: `entityId: null` shared accounts were
 * being skipped by the one scoped test, and there are 37 of them. Measured
 * before changing it — all 37 already carry a category, so this closes a
 * silent hole rather than opening a failure.
 */
async function seedChartScope() {
  const seedEntities = await prisma.legalEntity.findMany({
    where: { OR: [{ code: "NORTHWIND" }, { code: { startsWith: "ACME" } }] },
    select: { id: true },
  });
  return {
    sourceSystem: null,
    code: { in: CHART_OF_ACCOUNTS.map((a) => a.code) },
    OR: [{ entityId: null }, { entityId: { in: seedEntities.map((e) => e.id) } }],
  };
}

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
      defaultTranslationCategory({ type: "EXPENSE", subtype: "FX_GAIN_LOSS_REALIZED" })
    ).toBe("EXCLUDED");
    // Also fires if someone classifies FX_GAIN_LOSS under REVENUE
    // (occasionally happens for gain-dominant operations).
    expect(
      defaultTranslationCategory({ type: "REVENUE", subtype: "FX_GAIN_LOSS_UNREALIZED" })
    ).toBe("EXCLUDED");
  });
});

describe("migration backfill (vs dev DB)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("every CANONICAL-CHART account has translationCategory populated", async () => {
    const unmapped = await prisma.account.count({
      where: { ...(await seedChartScope()), translationCategory: null },
    });
    expect(unmapped).toBe(0);
  });

  it("ASSET + LIABILITY accounts are all CURRENT_RATE", async () => {
    const wrong = await prisma.account.count({
      where: {
        ...(await seedChartScope()),
        type: { in: ["ASSET", "LIABILITY"] },
        NOT: { translationCategory: "CURRENT_RATE" },
      },
    });
    expect(wrong).toBe(0);
  });

  it("EQUITY accounts are all HISTORICAL", async () => {
    const wrong = await prisma.account.count({
      where: {
        ...(await seedChartScope()),
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
      // Scoped to the default tenant: orphaned random-suffix test
      // tenants from crashed runs (shared dev DB) can hold pre-#149
      // FX accounts with NULL categories; the invariant this proves —
      // creation paths stamp EXCLUDED — is fully covered here.
      where: {
        tenantId: await getDefaultTenantId(prisma),
        subtype: { in: ["FX_GAIN_LOSS_REALIZED", "FX_GAIN_LOSS_UNREALIZED"] },
      },
      select: { code: true, translationCategory: true },
    });
    expect(fxRows.length).toBeGreaterThan(0);
    // (ensureFxGainLossAccount + seed both set EXCLUDED at creation;
    // any null here is a real regression.)
    for (const a of fxRows) {
      expect(a.translationCategory).toBe("EXCLUDED");
    }
  });

  it("REVENUE + EXPENSE accounts (excluding FX_GAIN_LOSS) are WEIGHTED_AVG", async () => {
    const wrong = await prisma.account.count({
      where: {
        ...(await seedChartScope()),
        type: { in: ["REVENUE", "EXPENSE"] },
        NOT: [
          { translationCategory: "WEIGHTED_AVG" },
          { subtype: { in: ["FX_GAIN_LOSS_REALIZED", "FX_GAIN_LOSS_UNREALIZED"] } },
        ],
      },
    });
    expect(wrong).toBe(0);
  });
});
