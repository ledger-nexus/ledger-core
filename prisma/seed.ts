// Thin wrapper around src/lib/seed/northwind.ts so the seed logic is
// reusable from the demo-reset API endpoint as well as the CLI script.
//
// Run with: pnpm db:seed

import { PrismaClient } from "@prisma/client";
import { seedNorthwind, ENTITY_CODE } from "../src/lib/seed/northwind";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Northwind Cloud...");
  await seedNorthwind(prisma);

  const [entryCount, arOpen, apOpen, assetCount] = await Promise.all([
    prisma.journalEntry.count({ where: { entity: { code: ENTITY_CODE } } }),
    prisma.arOpenItem.count({
      where: { entity: { code: ENTITY_CODE }, status: { in: ["OPEN", "PARTIAL"] } },
    }),
    prisma.apOpenItem.count({
      where: { entity: { code: ENTITY_CODE }, status: { in: ["OPEN", "PARTIAL"] } },
    }),
    prisma.fixedAsset.count({ where: { entity: { code: ENTITY_CODE } } }),
  ]);
  console.log(
    `\nDone.\n` +
      `  ${entryCount} journal entries (across 3 books)\n` +
      `  ${arOpen} open AR items, ${apOpen} open AP items\n` +
      `  ${assetCount} fixed asset(s)\n`
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
