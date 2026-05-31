// One-shot migration: encrypt the existing `party.displayName`
// column in place. Idempotent — skips rows where the column
// already looks encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with Party in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-party-display-names.ts
//
// Paginated by id ASC for deterministic resumes. Race-safe via
// updateMany with column selector.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 200;

async function main(): Promise<void> {
  const prisma = new PrismaClient(); // raw — bypass the extension
  console.log("[migrate] starting backfill of confidential columns");

  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.party.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, displayName: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      if (!row.displayName) {
        skippedEmpty++;
        continue;
      }
      if (looksEncrypted(row.displayName)) {
        skippedAlready++;
        continue;
      }
      const ct = encryptField(row.displayName);
      if (!ct) {
        skippedEmpty++;
        continue;
      }
      await prisma.party.updateMany({
        where: { id: row.id, displayName: row.displayName },
        data: { displayName: ct },
      });
      encrypted++;
    }
    if (total % 1000 === 0) {
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
