import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.$queryRawUnsafe<{ conname: string; table_name: string; definition: string }[]>(`
    SELECT conname, conrelid::regclass::text AS table_name,
           pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname LIKE '%tenantId%' OR conname = 'legal_entity_tenantId_fkey'
    ORDER BY conname
  `);
  for (const r of rows) {
    console.log(`${r.conname} on ${r.table_name}: ${r.definition}`);
  }
  await prisma.$disconnect();
})();
