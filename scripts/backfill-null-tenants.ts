// Backfill any tenant-scoped rows that still have NULL tenantId.
// Idempotent: rows already tagged are skipped.
//
// Resolves the default tenant (created by the Phase 1 migration) and
// assigns it to every NULL row. Logs counts per table so the run is
// auditable. After this script reports zero dirty rows, the Phase 4b
// migration can safely apply ALTER COLUMN ... NOT NULL.

import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const TABLES = [
  "legal_entity", "fiscal_calendar", "period", "period_close",
  "party", "party_role", "item", "account",
  "gl_entry_header", "gl_entry_line",
  "dimension", "dimension_value", "dimension_set",
  "posting_rule", "custom_field_definition",
  "ar_open_item", "ar_application", "ap_open_item", "ap_application",
  "fixed_asset", "lease", "revenue_contract",
  "queue", "record_event", "audit_log", "reassignment_rule", "notification",
];

(async () => {
  const tenantId = await getDefaultTenantId(prisma);
  console.log(`Backfilling NULL tenantId rows to default tenant ${tenantId}...`);
  let total = 0;
  for (const t of TABLES) {
    const result = await prisma.$executeRawUnsafe(
      `UPDATE "${t}" SET "tenantId" = $1::uuid WHERE "tenantId" IS NULL`,
      tenantId
    );
    if (result > 0) {
      console.log(`  ${t}: ${result} backfilled`);
      total += result;
    }
  }
  console.log(`Done. ${total} rows backfilled.`);
  await prisma.$disconnect();
})();
