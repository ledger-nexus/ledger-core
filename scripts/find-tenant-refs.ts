import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
(async () => {
  // Find tenants with our test prefix
  const tenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: "enforce-" } },
    select: { id: true, slug: true },
  });
  console.log("Test tenants:", tenants);

  if (tenants.length === 0) {
    console.log("No test tenants — clean state.");
    await prisma.$disconnect();
    return;
  }

  const ids = tenants.map(t => t.id);
  // Query EVERY tenant-scoped table for rows pointing at these tenants.
  const tables = [
    "legal_entity", "fiscal_calendar", "period", "period_close",
    "party", "party_role", "item", "account",
    "gl_entry_header", "gl_entry_line",
    "dimension", "dimension_value", "dimension_set",
    "posting_rule", "custom_field_definition",
    "ar_open_item", "ar_application", "ap_open_item", "ap_application",
    "fixed_asset", "lease", "revenue_contract",
    "queue", "record_event", "audit_log", "reassignment_rule", "notification"
  ];
  for (const t of tables) {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "${t}" WHERE "tenantId" = ANY($1::uuid[])`,
      ids
    );
    const n = Number(rows[0].count);
    if (n > 0) console.log(`${t}: ${n} rows still reference test tenants`);
  }
  await prisma.$disconnect();
})();
