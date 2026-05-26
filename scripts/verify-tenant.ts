// Quick smoke probe: show the tenant table contents + total row counts
// per major table. Useful after a Phase 4b migration to confirm the
// data state. The pre-Phase-4b version counted "rows with non-null
// tenantId" against the total; after Phase 4b they are equivalent so
// we just print total counts.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

(async () => {
  const tenants = await prisma.tenant.findMany();
  const memberships = await prisma.tenantMembership.findMany();
  console.log("Tenants:", tenants.map((t) => ({ slug: t.slug, name: t.name, id: t.id })));
  console.log("Memberships:");
  for (const m of memberships) {
    console.log(`  tenant=${m.tenantId} user=${m.userId} role=${m.role}`);
  }
  console.log("Row counts (all tenant-scoped post-Phase-4b):");
  console.log(`  LegalEntity:  ${await prisma.legalEntity.count()}`);
  console.log(`  Account:      ${await prisma.account.count()}`);
  console.log(`  JournalEntry: ${await prisma.journalEntry.count()}`);
  console.log(`  AuditLog:     ${await prisma.auditLog.count()} (tenantId nullable)`);
  await prisma.$disconnect();
})();
