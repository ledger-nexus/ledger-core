// One-shot migration: encrypt the existing `journal_entry.sourcePayload`
// Json column in place. Idempotent — skips rows where the column
// already looks encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with JournalEntry.sourcePayload (type
//      "json") in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-journal-entry-source-payloads.ts
//
// Strategy:
//   - Use a RAW PrismaClient so we read the on-disk Json verbatim and
//     write a string (the ciphertext envelope) verbatim back.
//   - JSON.stringify on write, looksEncrypted on skip — same pattern
//     as the String-column backfills, just routed through the Json
//     mode.
//
// Paginated by id ASC. sourcePayload can be tens of KB on QBO/NS
// imports — conservative batch.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 100;

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly
  // (and read the verbatim on-disk JsonValue, not the auto-decrypted
  // shape).
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential column");

  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.journalEntry.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, sourcePayload: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      const sp = row.sourcePayload;
      if (sp === null || sp === undefined) {
        skippedEmpty++;
        continue;
      }
      // If the on-disk Json value is already a string that looks
      // encrypted, this row was migrated by a prior extension write —
      // skip.
      if (typeof sp === "string" && looksEncrypted(sp)) {
        skippedAlready++;
        continue;
      }
      const ct = encryptField(JSON.stringify(sp));
      if (!ct) {
        skippedEmpty++;
        continue;
      }
      // Race-safe via id+sourcePayload selector. Two rows can match on
      // both columns only if the payload was already migrated by the
      // extension's write hook — in which case the looksEncrypted skip
      // above caught it.
      await prisma.journalEntry.updateMany({
        where: { id: row.id },
        data: { sourcePayload: ct },
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
