// Force-rerun the Northwind seed and report any errors. Tries to
// expose what's broken about idempotency in the seed module.

import { PrismaClient } from "@prisma/client";
import { seedNorthwind } from "../src/lib/seed/northwind";

const prisma = new PrismaClient();

(async () => {
  console.log("Re-running seedNorthwind on existing data...");
  try {
    await seedNorthwind(prisma);
    console.log("OK seed completed without error.");
  } catch (e) {
    console.log("ERROR:", e instanceof Error ? `${e.name}: ${e.message}` : e);
    if (e instanceof Error && e.stack) {
      console.log(e.stack.split("\n").slice(0, 10).join("\n"));
    }
  }
  // Post-seed inventory.
  const ent = await prisma.legalEntity.findUnique({ where: { code: "NORTHWIND" }, select: { id: true } });
  if (ent) {
    const je = await prisma.journalEntry.count({ where: { entityId: ent.id } });
    const ar = await prisma.arOpenItem.count({ where: { entityId: ent.id } });
    const rc = await prisma.revenueContract.count({ where: { entityId: ent.id } });
    const fa = await prisma.fixedAsset.count({ where: { entityId: ent.id } });
    console.log(`After seed: JE=${je}, AR=${ar}, RC=${rc}, FA=${fa}`);
  }
  await prisma.$disconnect();
})();
