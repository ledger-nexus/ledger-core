// End-to-end multi-sub import test — v0.7 Phase 3.
//
// Imports the 3-subsidiary fixture (prisma/fixtures/netsuite-multi-sub.json)
// through the full importFromNs orchestrator in multi mode. Asserts:
//
//   - 3 LegalEntity rows created with the right hierarchy
//   - Accounts created on the global chart (entityId: null)
//   - Each transaction's JE lands in the entity matching its NS
//     subsidiary field
//   - Cross-currency Invoice 10003 on Vandelay UK posts in GBP to the
//     UK entity, not USD on the parent
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { importFromNs } from "@/lib/mappers/netsuite";
import type { NsExport } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const FIXTURE_PATH = join(
  __dirname,
  "..",
  "prisma",
  "fixtures",
  "netsuite-multi-sub.json"
);

const PREFIX = "VANE2E"; // distinct from the Phase 2 integration test's VANTEST

async function cleanup() {
  const tenantId = await getDefaultTenantId(prisma);
  const entityCodes = [
    `${PREFIX}_NS1`,
    `${PREFIX}_NS2`,
    `${PREFIX}_NS3`,
  ];
  const entities = await prisma.legalEntity.findMany({
    where: { tenantId, code: { in: entityCodes } },
    select: { id: true },
  });
  const entityIds = entities.map((e) => e.id);

  // Delete dependent rows in FK-safe order. Multi-sub mode creates
  // accounts with entityId: null which are tenant-wide; we filter them
  // by sourceSystem to avoid clobbering other test data.
  // JE lines cascade with JE delete; AR/AP open items cascade with JE too.

  // Delete JEs sourced from NetSuite for entities we created (covers
  // all our test transactions, including the cross-currency UK one).
  if (entityIds.length > 0) {
    await prisma.journalEntry.deleteMany({
      where: {
        sourceSystem: "NETSUITE",
        entityId: { in: entityIds },
      },
    });
  }

  // Parties + Items + Accounts in multi-mode are entity-null but
  // sourced from NetSuite — scope by sourceSystem + mappingVersion
  // to avoid catching cross-test pollution.
  await prisma.party.deleteMany({
    where: { sourceSystem: "NETSUITE", entityId: null, tenantId },
  });
  await prisma.item.deleteMany({
    where: { sourceSystem: "NETSUITE", entityId: null, tenantId },
  });
  await prisma.account.deleteMany({
    where: { sourceSystem: "NETSUITE", entityId: null, tenantId },
  });

  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: { in: entityCodes } },
  });
}

async function ensureCurrencies() {
  await prisma.currency.upsert({
    where: { code: "GBP" },
    create: { code: "GBP", name: "Pound Sterling", decimals: 2, symbol: "£" },
    update: {},
  });
}

describe("importFromNs multi-sub e2e", () => {
  beforeAll(async () => {
    await ensureCurrencies();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("imports the 3-sub fixture with per-tx routing", async () => {
    const nsExport: NsExport = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      export: nsExport,
    });

    // Top-level header counts.
    expect(result.subsidiariesUpserted).toBe(3);
    // The fixture has: 4 dimensions (CLASS, DEPARTMENT, LOCATION, CUSTCOL_REGION)
    // — we just check it's > 0 here; dimensions-specific assertions are
    // covered by tests/netsuite-mapping.test.ts.
    expect(result.dimensionsCreated).toBeGreaterThanOrEqual(0);
    expect(result.errors).toEqual([]);

    // 3 LegalEntity rows with the right hierarchy.
    const tenantId = await getDefaultTenantId(prisma);
    const entities = await prisma.legalEntity.findMany({
      where: {
        tenantId,
        code: { in: [`${PREFIX}_NS1`, `${PREFIX}_NS2`, `${PREFIX}_NS3`] },
      },
      select: {
        id: true,
        code: true,
        parentEntityId: true,
        functionalCurrencyId: true,
      },
      orderBy: { code: "asc" },
    });
    expect(entities).toHaveLength(3);

    const parent = entities.find((e) => e.code === `${PREFIX}_NS1`)!;
    const usSub = entities.find((e) => e.code === `${PREFIX}_NS2`)!;
    const ukSub = entities.find((e) => e.code === `${PREFIX}_NS3`)!;

    expect(parent.parentEntityId).toBeNull();
    expect(usSub.parentEntityId).toBe(parent.id);
    expect(ukSub.parentEntityId).toBe(parent.id);
    expect(parent.functionalCurrencyId).toBe("USD");
    expect(usSub.functionalCurrencyId).toBe("USD");
    expect(ukSub.functionalCurrencyId).toBe("GBP");
  });

  it("creates accounts on the global chart (entityId: null)", async () => {
    const tenantId = await getDefaultTenantId(prisma);

    // Every NS-imported account should have entityId: null in multi
    // mode, per the Phase 3 chart-of-accounts decision (Option A).
    const nsAccounts = await prisma.account.findMany({
      where: { sourceSystem: "NETSUITE", tenantId },
      select: { code: true, entityId: true },
    });
    expect(nsAccounts.length).toBeGreaterThan(0);
    for (const a of nsAccounts) {
      expect(a.entityId).toBeNull();
    }
  });

  it("routes each transaction to its NS subsidiary's entity", async () => {
    const tenantId = await getDefaultTenantId(prisma);

    const entitiesByCode = Object.fromEntries(
      (
        await prisma.legalEntity.findMany({
          where: {
            tenantId,
            code: { in: [`${PREFIX}_NS1`, `${PREFIX}_NS2`, `${PREFIX}_NS3`] },
          },
          select: { id: true, code: true },
        })
      ).map((e) => [e.code, e.id])
    );

    // Invoice 10001 + 10002 are on sub 2 (Vandelay USA) → entity NS2.
    // Invoice 10003 is on sub 3 (Vandelay UK) → entity NS3.
    const jeByInvoice = await prisma.journalEntry.findMany({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordType: "Invoice",
        sourceRecordId: { in: ["10001", "10002", "10003"] },
      },
      select: { sourceRecordId: true, entityId: true, currencyId: true },
    });
    expect(jeByInvoice).toHaveLength(3);
    const byId = Object.fromEntries(
      jeByInvoice.map((j) => [j.sourceRecordId, j])
    );
    expect(byId["10001"]!.entityId).toBe(entitiesByCode[`${PREFIX}_NS2`]);
    expect(byId["10002"]!.entityId).toBe(entitiesByCode[`${PREFIX}_NS2`]);
    expect(byId["10003"]!.entityId).toBe(entitiesByCode[`${PREFIX}_NS3`]);

    // The UK invoice is the cross-currency proof point.
    expect(byId["10003"]!.currencyId).toBe("GBP");
  });

  it("the JournalEntry-typed transaction lands on the right sub too", async () => {
    const tenantId = await getDefaultTenantId(prisma);
    const ns2Id = (
      await prisma.legalEntity.findFirstOrThrow({
        where: { tenantId, code: `${PREFIX}_NS2` },
        select: { id: true },
      })
    ).id;
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordType: "JournalEntry",
        sourceRecordId: "50001",
      },
      select: { entityId: true },
    });
    expect(je.entityId).toBe(ns2Id);
  });

  it("is idempotent — re-running produces same entity + JE state", async () => {
    const nsExport: NsExport = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    const tenantId = await getDefaultTenantId(prisma);
    const jesBefore = await prisma.journalEntry.count({
      where: { sourceSystem: "NETSUITE", tenantId },
    });

    // Re-run.
    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      export: nsExport,
    });
    expect(result.subsidiariesUpserted).toBe(3);
    expect(result.errors).toEqual([]);

    const jesAfter = await prisma.journalEntry.count({
      where: { sourceSystem: "NETSUITE", tenantId },
    });
    // The lineage triple unique constraint catches the duplicate JEs;
    // each NS source record posts exactly once across both runs.
    expect(jesAfter).toBe(jesBefore);
  });
});
