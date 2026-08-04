// Integration tests for setupSubsidiaries against real Postgres.
//
// Phase 2 of v0.7 NS multi-subsidiary arc. Proves the orchestrator
// upserts the 3-sub hierarchy correctly, wires parentEntityId, tags
// extensions JSONB, is idempotent, and surfaces warnings.
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import {
  setupSubsidiaries,
  type EntityResolution,
} from "@/lib/mappers/netsuite/subsidiaries";
import type { NsSubsidiary } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const RESOLUTION: EntityResolution = {
  mode: "multi",
  entityCodePrefix: "VANTEST",
};

const SUBSIDIARIES: NsSubsidiary[] = [
  {
    internalid: "1",
    name: "Vandelay Industries (Integration Test)",
    iselimination: false,
    currency: "USD",
    country: "US",
  },
  {
    internalid: "2",
    name: "Vandelay USA (Integration Test)",
    iselimination: false,
    currency: "USD",
    country: "US",
    parent: { internalid: "1", name: "Vandelay Industries" },
  },
  {
    internalid: "3",
    name: "Vandelay UK (Integration Test)",
    iselimination: false,
    currency: "GBP",
    country: "GB",
    parent: { internalid: "1", name: "Vandelay Industries" },
  },
];

async function cleanupTestEntities() {
  const tenantId = await getDefaultTenantId(prisma);
  await prisma.legalEntity.deleteMany({
    where: {
      tenantId,
      code: { in: ["VANTEST_NS1", "VANTEST_NS2", "VANTEST_NS3"] },
    },
  });
}

async function ensureCurrencies() {
  // GBP may not be seeded on every dev DB; ensure it before the test.
  // USD is in every seed.
  await prisma.currency.upsert({
    where: { code: "GBP" },
    create: { code: "GBP", name: "Pound Sterling", decimals: 2, symbol: "£" },
    update: {},
  });
}

describe("setupSubsidiaries (integration vs real Postgres)", () => {
  beforeAll(async () => {
    await ensureCurrencies();
    await cleanupTestEntities();
  });

  afterAll(async () => {
    await cleanupTestEntities();
    await prisma.$disconnect();
  });

  it("upserts a 3-subsidiary hierarchy with parent wiring", async () => {
    const result = await setupSubsidiaries(prisma, {
      subsidiaries: SUBSIDIARIES,
      resolution: RESOLUTION,
    });

    expect(result.subsidiariesUpserted).toBe(3);
    expect(result.entityByInternalid.size).toBe(3);
    expect(result.warnings).toEqual([]);

    const tenantId = await getDefaultTenantId(prisma);

    // All three entities should be present.
    const entities = await prisma.legalEntity.findMany({
      where: {
        tenantId,
        code: { in: ["VANTEST_NS1", "VANTEST_NS2", "VANTEST_NS3"] },
      },
      select: {
        id: true,
        code: true,
        name: true,
        parentEntityId: true,
        functionalCurrencyId: true,
        extensions: true,
      },
      orderBy: { code: "asc" },
    });
    expect(entities).toHaveLength(3);

    const parent = entities.find((e) => e.code === "VANTEST_NS1")!;
    const usSub = entities.find((e) => e.code === "VANTEST_NS2")!;
    const ukSub = entities.find((e) => e.code === "VANTEST_NS3")!;

    expect(parent.parentEntityId).toBeNull();
    expect(parent.functionalCurrencyId).toBe("USD");

    expect(usSub.parentEntityId).toBe(parent.id);
    expect(usSub.functionalCurrencyId).toBe("USD");

    expect(ukSub.parentEntityId).toBe(parent.id);
    expect(ukSub.functionalCurrencyId).toBe("GBP");
  });

  it("tags extensions JSONB with NS lineage", async () => {
    const tenantId = await getDefaultTenantId(prisma);
    const usSub = await prisma.legalEntity.findFirstOrThrow({
      where: { tenantId, code: "VANTEST_NS2" },
      select: { extensions: true },
    });
    // Note: `nsIsElimination` JSON flag was retired in the v0.9 cleanup
    // arc (the isEliminationEntity column is canonical). Only the
    // remaining import-identity flags are written to extensions.
    expect(usSub.extensions).toMatchObject({
      nsIsImported: true,
      nsInternalid: "2",
    });
  });

  it("is idempotent — re-running upserts existing entities without error", async () => {
    // The first run created the rows. The second run should produce
    // the same map, the same warnings (empty), and not duplicate anything.
    const first = await setupSubsidiaries(prisma, {
      subsidiaries: SUBSIDIARIES,
      resolution: RESOLUTION,
    });
    const second = await setupSubsidiaries(prisma, {
      subsidiaries: SUBSIDIARIES,
      resolution: RESOLUTION,
    });
    expect(first.subsidiariesUpserted).toBe(3);
    expect(second.subsidiariesUpserted).toBe(3);
    expect(first.entityByInternalid).toEqual(second.entityByInternalid);
    expect(first.warnings).toEqual([]);
    expect(second.warnings).toEqual([]);

    const tenantId = await getDefaultTenantId(prisma);
    const count = await prisma.legalEntity.count({
      where: {
        tenantId,
        code: { in: ["VANTEST_NS1", "VANTEST_NS2", "VANTEST_NS3"] },
      },
    });
    expect(count).toBe(3);
  });

  it("handles missing parent subsidiary with a warning (treated as top-level)", async () => {
    await cleanupTestEntities();

    // A "orphan" child whose parent ISN'T in the same export.
    const orphan: NsSubsidiary = {
      internalid: "99",
      name: "Vandelay Orphan",
      iselimination: false,
      currency: "USD",
      country: "US",
      parent: { internalid: "404", name: "Missing Parent" },
    };
    const result = await setupSubsidiaries(prisma, {
      subsidiaries: [orphan],
      resolution: { mode: "multi", entityCodePrefix: "VANTEST" },
    });

    expect(result.subsidiariesUpserted).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/parent 404.*isn't present/i);

    const tenantId = await getDefaultTenantId(prisma);
    const orphanEntity = await prisma.legalEntity.findFirstOrThrow({
      where: { tenantId, code: "VANTEST_NS99" },
      select: { parentEntityId: true },
    });
    expect(orphanEntity.parentEntityId).toBeNull();

    await prisma.legalEntity.deleteMany({
      where: { tenantId, code: "VANTEST_NS99" },
    });
  });

  it("throws when a subsidiary references a Currency not seeded", async () => {
    const fictional: NsSubsidiary = {
      internalid: "100",
      name: "Vandelay Atlantis",
      iselimination: false,
      currency: "ATL", // not a real ISO 4217 code
      country: "??",
    };
    await expect(
      setupSubsidiaries(prisma, {
        subsidiaries: [fictional],
        resolution: { mode: "multi", entityCodePrefix: "VANTEST" },
      })
    ).rejects.toThrow(/currency "ATL" not seeded/);
  });

  it("single mode collapses all subsidiaries to one entityCode", async () => {
    await cleanupTestEntities();
    const tenantId = await getDefaultTenantId(prisma);

    // In single mode, every subsidiary maps to the SAME entityCode.
    // The orchestrator upserts the same row 3 times — final state has
    // ONE entity. This is the v0.6 backward-compat path: a NS export
    // with multiple subs lands as a single ledger-core entity. (Useful
    // when the operator doesn't care about multi-entity reporting.)
    await prisma.legalEntity.upsert({
      where: { tenantId_code: { tenantId, code: "VANTEST_SINGLE" } },
      create: {
        tenantId,
        code: "VANTEST_SINGLE",
        name: "Vandelay Single",
        functionalCurrencyId: "USD",
      },
      update: {},
    });

    const result = await setupSubsidiaries(prisma, {
      subsidiaries: SUBSIDIARIES,
      resolution: { mode: "single", entityCode: "VANTEST_SINGLE" },
    });
    expect(result.subsidiariesUpserted).toBe(3);
    expect(result.entityByInternalid.size).toBe(3);
    // All three internalids point at the SAME entityId.
    const ids = Array.from(result.entityByInternalid.values());
    expect(new Set(ids).size).toBe(1);

    await prisma.legalEntity.deleteMany({
      where: { tenantId, code: "VANTEST_SINGLE" },
    });
  });
});
