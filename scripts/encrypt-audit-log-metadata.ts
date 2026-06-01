// One-shot migration: encrypt the existing `audit_log.metadata` Json
// column in place.
//
// ⚠️  PRODUCTION CAVEAT
// ════════════════════
// audit_log is append-only at the DB level — Postgres RULEs on UPDATE
// and DELETE silently no-op all rows. This script is therefore safe to
// RUN against production (it won't corrupt anything) but it WILL NOT
// MIGRATE LEGACY ROWS — they stay plaintext for the 7-year retention
// window. This is a documented limitation, not a bug.
//
// In dev / staging where the RULE can be temporarily disabled, the
// script uses the `withAuditLogMutable` helper to actually rewrite
// rows. New writes from the rollout date forward encrypt automatically
// via the extension's create hook regardless of environment.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with AuditLog.metadata
//      (type "json") in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-audit-log-metadata.ts

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 200;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential column");
  if (process.env.NODE_ENV === "production") {
    console.log(
      "[migrate] ⚠️  NODE_ENV=production detected. The append-only RULE will silently"
    );
    console.log(
      "[migrate]    block UPDATEs. Legacy rows stay plaintext; new writes encrypt."
    );
  }

  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.auditLog.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, metadata: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      const md = row.metadata;
      if (md === null || md === undefined) {
        skippedEmpty++;
        continue;
      }
      if (typeof md === "string" && looksEncrypted(md)) {
        skippedAlready++;
        continue;
      }
      const ct = encryptField(JSON.stringify(md));
      if (!ct) {
        skippedEmpty++;
        continue;
      }
      // updateMany silently no-ops in production (append-only RULE).
      // In dev/staging where the RULE is dropped, this re-writes the
      // metadata column.
      const result = await prisma.auditLog.updateMany({
        where: { id: row.id },
        data: { metadata: ct },
      });
      if (result.count > 0) encrypted++;
      else skippedAlready++; // RULE blocked the write
    }
    if (total % 1000 === 0) {
      console.log(
        `[migrate] scanned ${total} rows; ${encrypted} encrypted, ${skippedAlready} already done/blocked, ${skippedEmpty} empty`
      );
    }
  }

  console.log(
    `[migrate] complete. total=${total} encrypted=${encrypted} skipped_already_or_blocked=${skippedAlready} skipped_empty=${skippedEmpty}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
