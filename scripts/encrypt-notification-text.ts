// One-shot migration: encrypt the existing `notification.title` and
// `notification.body` columns in place. Idempotent — skips per-field
// if the column already looks encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with Notification.title and
//      Notification.body in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-notification-text.ts
//
// Paginated by id ASC. Each field independently gated by
// looksEncrypted so the script is resumable after a crash mid-row
// and safe to re-run if the extension has partially encrypted some
// rows already.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 500;
const COLUMNS = ["title", "body"] as const;
type EncryptableField = (typeof COLUMNS)[number];

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly.
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential columns");

  const stats: Record<EncryptableField, { encrypted: number; skippedAlready: number; skippedEmpty: number }> = {
    title: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
    body: { encrypted: 0, skippedAlready: 0, skippedEmpty: 0 },
  };

  let total = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.notification.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, title: true, body: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      const updates: Partial<Record<EncryptableField, string>> = {};
      const guards: Partial<Record<EncryptableField, string>> = {};
      for (const col of COLUMNS) {
        const current = row[col];
        if (!current) {
          stats[col].skippedEmpty++;
          continue;
        }
        if (looksEncrypted(current)) {
          stats[col].skippedAlready++;
          continue;
        }
        const ct = encryptField(current);
        if (!ct) {
          stats[col].skippedEmpty++;
          continue;
        }
        updates[col] = ct;
        guards[col] = current; // race-safe selector
        stats[col].encrypted++;
      }
      if (Object.keys(updates).length === 0) continue;
      await prisma.notification.updateMany({
        where: { id: row.id, ...guards },
        data: updates,
      });
    }
    if (total % 2000 === 0) {
      console.log(
        `[migrate] scanned ${total} rows; title.encrypted=${stats.title.encrypted} body.encrypted=${stats.body.encrypted}`
      );
    }
  }

  console.log(`[migrate] complete. total_rows=${total}`);
  for (const col of COLUMNS) {
    const s = stats[col];
    console.log(
      `[migrate]   ${col}: encrypted=${s.encrypted} skipped_already=${s.skippedAlready} skipped_empty=${s.skippedEmpty}`
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
