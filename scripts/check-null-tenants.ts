// Verification before applying NOT NULL: confirm no tenant-scoped rows
// have tenantId = NULL. If any do, the migration would fail; we need
// to identify and backfill them first.

import { PrismaClient } from "@prisma/client";
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
  let dirty = 0;
  for (const t of TABLES) {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "${t}" WHERE "tenantId" IS NULL`
    );
    const n = Number(rows[0].count);
    if (n > 0) {
      console.log(`${t}: ${n} rows with NULL tenantId`);
      dirty += n;
    }
  }
  if (dirty === 0) {
    console.log("OK All tenant-scoped rows have tenantId set.");
  } else {
    console.log(`FAIL ${dirty} total NULL rows. Backfill before NOT NULL.`);
  }
  await prisma.$disconnect();
})();
