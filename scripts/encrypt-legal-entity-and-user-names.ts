// One-shot migration: encrypt `legal_entity.name` and `user.displayName`
// columns in place. Idempotent — skips per-row if the column already
// looks encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with LegalEntity.name and
//      User.displayName in ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-legal-entity-and-user-names.ts
//
// Two passes — one per table — paginated by id ASC for deterministic
// resumes. Both tables are small (entity count = customer count,
// user count = team-member count), so we use simple cursor pagination.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 200;

async function encryptLegalEntityName(prisma: PrismaClient): Promise<void> {
  console.log("[migrate] starting backfill on confidential column (entity)");
  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.legalEntity.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, name: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
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
      await prisma.legalEntity.updateMany({
        where: { id: row.id, name: row.name },
        data: { name: ct },
      });
      encrypted++;
    }
  }

  console.log(
    `[migrate]   entity column: total=${total} encrypted=${encrypted} skipped_already=${skippedAlready} skipped_empty=${skippedEmpty}`
  );
}

async function encryptUserDisplayName(prisma: PrismaClient): Promise<void> {
  console.log("[migrate] starting backfill on confidential column (user)");
  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.user.findMany({
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
      await prisma.user.updateMany({
        where: { id: row.id, displayName: row.displayName },
        data: { displayName: ct },
      });
      encrypted++;
    }
  }

  console.log(
    `[migrate]   user column: total=${total} encrypted=${encrypted} skipped_already=${skippedAlready} skipped_empty=${skippedEmpty}`
  );
}

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly.
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential columns");

  await encryptLegalEntityName(prisma);
  await encryptUserDisplayName(prisma);

  console.log("[migrate] complete");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
