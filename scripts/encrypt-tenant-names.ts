// One-shot migration: encrypt the existing `tenant.name` column in
// place. Idempotent — skips rows where the column already looks
// encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with Tenant in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-tenant-names.ts
//
// Tenant counts are small (one row per customer org) — no pagination
// needed, but we keep the same defensive shape as the other backfills
// for consistency.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly.
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential columns");

  const rows = await prisma.tenant.findMany({
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });

  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;

  for (const row of rows) {
    total++;
    if (!row.name) {
      skippedEmpty++;
      continue;
    }
    if (looksEncrypted(row.name)) {
      skippedAlready++;
      continue;
    }
    const ct = encryptField(row.name);
    if (!ct) {
      skippedEmpty++;
      continue;
    }
    // Race-safe via id+name selector: a concurrent extension write
    // that already encrypted the row won't get clobbered.
    await prisma.tenant.updateMany({
      where: { id: row.id, name: row.name },
      data: { name: ct },
    });
    encrypted++;
  }

  console.log(
    `[migrate] complete. total=${total} encrypted=${encrypted} skipped_already=${skippedAlready} skipped_empty=${skippedEmpty}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
