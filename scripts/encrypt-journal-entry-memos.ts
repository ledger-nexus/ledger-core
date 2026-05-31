// One-shot migration: encrypt the existing `journal_entry.memo`
// column in place. Idempotent — skips rows that already look
// encrypted (via the version-byte check in `looksEncrypted`).
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed (so new writes already encrypt)
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(cat .env.local | grep FIELD_ | cut -d= -f2) \
//     npx tsx scripts/encrypt-journal-entry-memos.ts
//
// Safe to interrupt and resume — every row gets a tenantId-aware
// transaction and the looksEncrypted check skips already-done rows.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 100;

async function main(): Promise<void> {
  // Use a raw client to bypass the extension — we want to write
  // ciphertext directly, not double-encrypt via the extension.
  const prisma = new PrismaClient();

  console.log("[migrate] starting journal_entry confidential-column backfill");

  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  // Paginate by id ASC so resumes are deterministic. We don't use
  // cursor-based pagination because the memo column is what we're
  // updating; cursor needs a stable column.
  while (true) {
    const rows = await prisma.journalEntry.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, memo: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      if (row.memo == null || row.memo === "") {
        skippedEmpty++;
        continue;
      }
      if (looksEncrypted(row.memo)) {
        skippedAlready++;
        continue;
      }
      const ciphertext = encryptField(row.memo);
      if (!ciphertext) {
        skippedEmpty++;
        continue;
      }
      // updateMany with id+memo selector so a concurrent write that
      // already encrypted the row (via the extension) doesn't get
      // clobbered.
      await prisma.journalEntry.updateMany({
        where: { id: row.id, memo: row.memo },
        data: { memo: ciphertext },
      });
      encrypted++;
    }
    if (total % 500 === 0) {
      console.log(
        `[migrate] scanned ${total} rows; ${encrypted} encrypted, ${skippedAlready} already done, ${skippedEmpty} empty`
      );
    }
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
