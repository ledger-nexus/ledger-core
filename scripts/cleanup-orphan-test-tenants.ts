// One-shot cleanup: drop all "enforce-" prefixed tenants left over by
// aborted runs of tests/tenant-write-enforcement.test.ts. Cascades through
// the FK graph in dependency order.

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

(async () => {
  const tenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: "enforce-" } },
    select: { id: true, slug: true },
  });
  if (tenants.length === 0) {
    console.log("No orphan test tenants.");
    await prisma.$disconnect();
    return;
  }
  const ids = tenants.map(t => t.id);
  console.log(`Cleaning ${tenants.length} orphan test tenants...`);

  await prisma.arApplication.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.apApplication.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.arOpenItem.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.apOpenItem.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.fixedAsset.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.lease.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.revenueContract.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.account.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.partyRole.deleteMany({
    where: { party: { tenantId: { in: ids } } },
  });
  await prisma.party.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.periodClose.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.period.deleteMany({
    where: { calendar: { tenantId: { in: ids } } },
  });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });

  const deleted = await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  console.log(`Deleted ${deleted.count} orphan tenants.`);
  await prisma.$disconnect();
})();
