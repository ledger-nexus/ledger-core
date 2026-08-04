// `pnpm demo:ns-multi-sub` entry point — the v0.7 NS multi-subsidiary
// showcase artifact.
//
// Imports the 3-sub fixture (`prisma/fixtures/netsuite-multi-sub.json`)
// in multi mode and prints the consolidation report URL. After running
// this you can open
//
//     /reports/consolidation?root=VANDEMO_NS1&asOf=2026-06-30
//
// (with scope = VANDEMO_NS1 / US_GAAP) and see:
//   - 3 LegalEntities in the hierarchy (Vandelay Industries parent +
//     USA child USD + UK child GBP)
//   - JEs posted to the right entity per the NS `subsidiary` field on
//     each source transaction
//   - The cross-currency UK invoice (10003) on the UK sub in GBP
//   - The consolidated trial balance summing up across all 3 subs,
//     with the intercompany-subtype elimination logic active (no IC
//     postings in this demo, but the same code path that runs for them)
//
// This is the 30-second sales clip the design doc promised:
//
//     "We dropped a real OneWorld NS export from a 3-subsidiary group
//      into ledger-core. With one importer call we got 3 entities,
//      full hierarchy, all transactions routed correctly. The
//      consolidated trial balance reconciles, including IC elimination
//      logic. No manual entity setup. No spreadsheets."
//
// This DOES NOT touch Northwind, DEMO_CO, or the existing consolidation
// demo seed. It creates a fresh entity hierarchy under the prefix
// VANDEMO so it's clearly distinct.
//
// Idempotent: re-running is safe. The importer dedupes by lineage triple.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

import { importFromNs } from "../src/lib/mappers/netsuite";
import type { NsExport } from "../src/lib/mappers/netsuite/types";
import { getDefaultTenantId } from "../src/lib/seed/default-tenant";

const FIXTURE_PATH = join(
  __dirname,
  "fixtures",
  "netsuite-multi-sub.json"
);

const PREFIX = "VANDEMO";
const ROOT_CODE = `${PREFIX}_NS1`;

async function ensureGbpCurrency(prisma: PrismaClient): Promise<void> {
  // The fixture's UK sub posts in GBP. Northwind seed covers USD/EUR;
  // GBP needs to exist before setupSubsidiaries' currency check runs.
  await prisma.currency.upsert({
    where: { code: "GBP" },
    create: { code: "GBP", name: "Pound Sterling", decimals: 2, symbol: "£" },
    update: {},
  });
}

// Idempotency cleanup. Matches `pnpm demo`'s pattern of wiping its
// dedicated entity (DEMO_CO) so re-running gives a clean result. We
// clean by lineage triple (sourceRecordId) — stable across runs — to
// catch orphan rows from prior runs that may point at since-deleted
// entities (would otherwise block re-creation via the lineage-unique
// index).
async function wipePriorDemoState(prisma: PrismaClient): Promise<void> {
  const tenantId = await getDefaultTenantId(prisma);
  const entityCodes = [`${PREFIX}_NS1`, `${PREFIX}_NS2`, `${PREFIX}_NS3`];

  // Transaction lineage IDs in the fixture.
  const lineageIds = [
    "10001", "10002", "10003",  // Invoice
    "20001",                     // VendorBill
    "30001",                     // CustomerPayment
    "40001",                     // VendorPayment
    "50001",                     // JournalEntry
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
    // AR/AP applications + open items FK to JEs; cascade-clean first.
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

  // Master rows by lineage id (catches stale rows whose entityId
  // points at a since-deleted entity).
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
    where: { sourceSystem: "NETSUITE", tenantId, sourceRecordId: { in: accountIds } },
  });

  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: { in: entityCodes } },
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await ensureGbpCurrency(prisma);
    console.log("→ Wiping prior VANDEMO state (idempotent re-run)...");
    await wipePriorDemoState(prisma);

    const nsExport: NsExport = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    console.log(
      `→ Importing ${nsExport.Subsidiary?.length ?? 0} subsidiaries + ` +
        `${nsExport.Invoice?.length ?? 0} invoices + ` +
        `${nsExport.VendorBill?.length ?? 0} bills + ` +
        `${nsExport.JournalEntry?.length ?? 0} JEs ` +
        `from ${nsExport._meta?.companyName ?? "NS"} ` +
        `under prefix ${PREFIX} in multi-sub mode...`
    );

    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      export: nsExport,
    });

    if (result.errors.length > 0) {
      console.error("\n✖ Errors during import:");
      for (const err of result.errors) console.error("  -", err);
      process.exitCode = 1;
      return;
    }

    console.log("\n✓ Import complete:");
    console.log(`    Subsidiaries upserted:        ${result.subsidiariesUpserted}`);
    console.log(`    Dimensions created:           ${result.dimensionsCreated}`);
    console.log(
      `    Accounts:                     ${result.accountsImported} new, ${result.accountsSkipped} reused`
    );
    console.log(
      `    Parties:                      ${result.partiesImported} new, ${result.partiesSkipped} reused`
    );
    console.log(
      `    Items:                        ${result.itemsImported} new, ${result.itemsSkipped} reused`
    );
    console.log(
      `    Journal entries:              ${result.journalEntriesImported} new, ${result.journalEntriesSkipped} reused`
    );
    console.log(`    AR open items opened:         ${result.arOpenItemsOpened}`);
    console.log(`    AP open items opened:         ${result.apOpenItemsOpened}`);
    console.log(`    Payments applied:             ${result.paymentsApplied}`);

    if (result.warnings.length > 0) {
      console.log("\n⚠ Warnings:");
      for (const w of result.warnings) console.log("  -", w);
    }

    const tenantId = await getDefaultTenantId(prisma);
    const entities = await prisma.legalEntity.findMany({
      where: {
        tenantId,
        code: { in: [`${PREFIX}_NS1`, `${PREFIX}_NS2`, `${PREFIX}_NS3`] },
      },
      select: { code: true, name: true, functionalCurrencyId: true, parentEntityId: true },
      orderBy: { code: "asc" },
    });
    console.log("\n✓ Entity hierarchy:");
    for (const e of entities) {
      const tag = e.parentEntityId ? "  ↳" : " ";
      console.log(`  ${tag} ${e.code}  (${e.functionalCurrencyId})  ${e.name}`);
    }

    console.log("\n→ Open the consolidated trial balance:");
    console.log(`    /reports/consolidation?root=${ROOT_CODE}&asOf=2026-06-30`);
    console.log(
      "\n  Set the scope cookie to entityCode=" +
        ROOT_CODE +
        ", bookCode=US_GAAP via the sidebar switcher first."
    );
    console.log(
      "  The report walks the hierarchy + sums TB across all 3 subs."
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
