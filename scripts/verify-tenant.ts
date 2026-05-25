import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
(async () => {
  const tenants = await prisma.tenant.findMany();
  const memberships = await prisma.tenantMembership.findMany();
  const le = await prisma.legalEntity.count();
  const leWithT = await prisma.legalEntity.count({ where: { tenantId: { not: null } } });
  const je = await prisma.journalEntry.count();
  const jeWithT = await prisma.journalEntry.count({ where: { tenantId: { not: null } } });
  const al = await prisma.auditLog.count();
  const alWithT = await prisma.auditLog.count({ where: { tenantId: { not: null } } });
  console.log("Tenants:", tenants.map(t => ({ slug: t.slug, name: t.name, id: t.id })));
  console.log("Memberships:", memberships.map(m => ({ tenantId: m.tenantId, userId: m.userId, role: m.role })));
  console.log(`LegalEntity: ${leWithT}/${le} have tenantId`);
  console.log(`JournalEntry: ${jeWithT}/${je} have tenantId`);
  console.log(`AuditLog: ${alWithT}/${al} have tenantId`);
  await prisma.$disconnect();
})();
