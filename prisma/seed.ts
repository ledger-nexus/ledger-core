// Thin wrapper around src/lib/seed/northwind.ts so the seed logic is
// reusable from the demo-reset API endpoint as well as the CLI script.
//
// Run with: pnpm db:seed

import { PrismaClient } from "@prisma/client";
import { seedNorthwind, ENTITY_CODE } from "../src/lib/seed/northwind";
import {
  seedConsolidationDemo,
  CONSOLIDATION_DEMO_ENTITIES,
} from "../src/lib/seed/consolidation-demo";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Northwind Cloud (multi-book, sub-ledgers, ASC 842, BTD)...");
  await seedNorthwind(prisma);

  console.log("Seeding consolidation demo (Acme Group + 2 subs with intercompany)...");
  await seedConsolidationDemo(prisma);

  const [entryCount, arOpen, apOpen, assetCount, consolEntries] = await Promise.all([
    prisma.journalEntry.count({ where: { entity: { code: ENTITY_CODE } } }),
    prisma.arOpenItem.count({
      where: { entity: { code: ENTITY_CODE }, status: { in: ["OPEN", "PARTIAL"] } },
    }),
    prisma.apOpenItem.count({
      where: { entity: { code: ENTITY_CODE }, status: { in: ["OPEN", "PARTIAL"] } },
    }),
    prisma.fixedAsset.count({ where: { entity: { code: ENTITY_CODE } } }),
    prisma.journalEntry.count({
      where: { entity: { code: { in: CONSOLIDATION_DEMO_ENTITIES } } },
    }),
  ]);
  console.log(
    `\nDone.\n` +
      `  Northwind: ${entryCount} JEs across 3 books, ${arOpen} open AR, ${apOpen} open AP, ${assetCount} fixed asset(s)\n` +
      `  Acme Group: ${consolEntries} JEs across 3 entities (parent + 2 subs)\n`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
