// Reverse exporter + roundtrip test — v0.7 Phase 4.
//
// Imports the 3-sub fixture in multi mode → exports it back via
// exportToNs({ entityResolution: { mode: "multi", ... }}) → asserts
// diffNsExports(original, exported) is null. This is the architectural
// proof that the multi-sub reverse exporter reconstructs the Subsidiary
// array + every per-sub transaction lineage byte-for-byte.
//
// The roundtrip relies on:
//   - LegalEntity.extensions.nsSourcePayload preserving the original
//     NsSubsidiary object verbatim (set by setupSubsidiaries in Phase 1)
//   - Account/Party/Item rows landing on entityId: null in multi mode
//     (Phase 3 chart-of-accounts decision)
//   - JEs scoped by entity.code IN [discovered sub codes] (Phase 4
//     export query)
//
// Failure modes this test catches:
//   - Subsidiary array missing or out of order
//   - Per-sub transaction routing lost on export (every JE collapsed
//     to one subsidiary)
//   - Cross-currency Invoice 10003 (GBP, sub 3) losing its currency
//   - sourcePayload byref preservation broken (a future "helpful"
//     reformat would silently break this test)
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { importFromNs, exportToNs, diffNsExports } from "@/lib/mappers/netsuite";
import type { NsExport } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const FIXTURE_PATH = join(
  __dirname,
  "..",
  "prisma",
  "fixtures",
  "netsuite-multi-sub.json"
);

// Distinct prefix from the Phase 2 (VANTEST) + Phase 3 (VANE2E) suites
// so the three test files don't fight over the same LegalEntity codes.
const PREFIX = "VANRT";

async function cleanup() {
  const tenantId = await getDefaultTenantId(prisma);
  const entityCodes = [`${PREFIX}_NS1`, `${PREFIX}_NS2`, `${PREFIX}_NS3`];

  // Clean by lineage. The fixture's transaction internalids are
  // stable; entity UUIDs are not. See netsuite-import-multi-sub-e2e
  // for the same pattern + rationale.
  const lineageIds = [
    "10001", "10002", "10003",
    "20001",
    "30001",
    "40001",
    "50001",
  ];

  const jeIds = (
    await prisma.journalEntry.findMany({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordId: { in: lineageIds },
        tenantId,
      },
      select: { id: true },
    })
  ).map((j) => j.id);

  if (jeIds.length > 0) {
    await prisma.arApplication.deleteMany({
      where: {
        OR: [
          { appliedByEntryId: { in: jeIds } },
          { openItem: { openedByEntryId: { in: jeIds } } },
        ],
      },
    });
    await prisma.apApplication.deleteMany({
      where: {
        OR: [
          { appliedByEntryId: { in: jeIds } },
          { openItem: { openedByEntryId: { in: jeIds } } },
        ],
      },
    });
    await prisma.arOpenItem.deleteMany({
      where: { openedByEntryId: { in: jeIds } },
    });
    await prisma.apOpenItem.deleteMany({
      where: { openedByEntryId: { in: jeIds } },
    });
  }

  await prisma.journalEntry.deleteMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordId: { in: lineageIds },
      tenantId,
    },
  });

  // Master rows by lineage id (covers both null-entity and stale
  // entity-attached rows from prior runs).
  const accountIds = ["1000", "1200", "2000", "3100", "4000", "6000", "7200"];
  const partyIds = ["5000", "5001", "6000"];
  const itemIds = ["7000"];

  await prisma.party.deleteMany({
    where: { sourceSystem: "NETSUITE", tenantId, sourceRecordId: { in: partyIds } },
  });
  await prisma.item.deleteMany({
    where: { sourceSystem: "NETSUITE", tenantId, sourceRecordId: { in: itemIds } },
  });
  await prisma.account.deleteMany({
    where: {
      sourceSystem: "NETSUITE",
      tenantId,
      sourceRecordId: { in: accountIds },
    },
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

describe("NS multi-sub roundtrip (import → export)", () => {
  beforeAll(async () => {
    await ensureCurrencies();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("imports the fixture and exports back to a semantically equivalent NsExport", async () => {
    const original: NsExport = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

    // 1. Import in multi mode. Phase 3 creates 3 LegalEntities + routes
    //    each transaction to its subsidiary.
    const importResult = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      export: original,
    });
    expect(importResult.subsidiariesUpserted).toBe(3);
    expect(importResult.errors).toEqual([]);

    // 2. Export back in multi mode. Reconstructs the Subsidiary array
    //    from LegalEntity.extensions.nsSourcePayload + routes JEs from
    //    every discovered sub entity.
    // _meta is optional on NsExport; the fixture always carries it.
    // Assert-and-narrow (the portfolio's expectResponse pattern) rather
    // than a non-null assertion.
    const meta = original._meta;
    if (!meta?.exportedAt) throw new Error("fixture missing _meta.exportedAt");
    const exported = await exportToNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      exportedAt: new Date(meta.exportedAt),
    });

    // 3. Subsidiary count + currency tie out before the full diff so a
    //    miss here gives a sharper error message than "diff string is
    //    different at field X."
    expect(exported.Subsidiary).toHaveLength(3);
    expect(exported.Subsidiary?.find((s) => s.internalid === "3")?.currency).toBe("GBP");

    // 4. Full byte-equivalence (modulo key order). The diff returns
    //    null on equivalence, or a `<key>: <reason>` string on mismatch.
    const diff = diffNsExports(original, exported);
    expect(diff).toBeNull();
  });

  it("re-exports identically a second time (idempotent on the export side)", async () => {
    // First export was inside the previous test. Re-exporting against
    // the same DB state must yield byte-identical output — otherwise
    // we have non-determinism in the reconstructor (sort instability,
    // implicit ordering by row creation time, etc.). Important for
    // operators diffing exports across deploys.
    const original: NsExport = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    const meta = original._meta;
    if (!meta?.exportedAt) throw new Error("fixture missing _meta.exportedAt");
    const first = await exportToNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      exportedAt: new Date(meta.exportedAt),
    });
    const second = await exportToNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      exportedAt: new Date(meta.exportedAt),
    });
    expect(diffNsExports(first, second)).toBeNull();
  });
});
