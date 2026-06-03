// Phase 3 backfill — encrypt two columns in one pass:
//
//   - TenantInvite.email + TenantInvite.emailHash (searchHash mode;
//     `tenant_invite` table)
//   - JournalEntryNote.authorEmail (plain AES-GCM; `journal_entry_note`
//     table)
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. FIELD_DETERMINISTIC_KEY is set in the target environment
//      (only required for the TenantInvite migration — JournalEntryNote
//      doesn't need a hash)
//   3. The extension is deployed with both columns in
//      ENCRYPTED_COLUMNS, and the schema migration that adds
//      `tenant_invite.emailHash` BYTEA + the index has been applied.
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep '^FIELD_ENCRYPTION_KEY' .env.local | cut -d= -f2) \
//   FIELD_DETERMINISTIC_KEY=$(grep '^FIELD_DETERMINISTIC_KEY' .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-tenant-invites-and-note-authors.ts
//
// Same idempotency + race-safety guarantees as
// scripts/encrypt-user-emails.ts. See that file's header for the
// per-row decision tree.

import { PrismaClient } from "@prisma/client";
import { encryptField, looksEncrypted } from "../src/lib/soc2/field-encryption";
import { searchHash } from "../src/lib/soc2/deterministic-encryption";

const BATCH_SIZE = 500;

async function migrateTenantInvites(prisma: PrismaClient): Promise<void> {
  console.log("[migrate] starting tenant_invite backfill");
  let total = 0;
  let migrated = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.tenantInvite.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, email: true, emailHash: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      if (!row.email) {
        skippedEmpty++;
        continue;
      }
      const alreadyEncrypted = looksEncrypted(row.email);
      const alreadyHashed = row.emailHash != null;
      if (alreadyEncrypted && alreadyHashed) {
        skippedAlready++;
        continue;
      }
      if (alreadyEncrypted && !alreadyHashed) {
        console.warn(
          `[migrate] tenant_invite ${row.id} has encrypted email but ` +
            "NULL emailHash; needs manual repair (same pattern as " +
            "encrypt-user-emails.ts)."
        );
        skippedEmpty++;
        continue;
      }

      const plaintext = row.email;
      const ct = encryptField(plaintext);
      if (!ct) {
        skippedEmpty++;
        continue;
      }
      const hash = searchHash(
        "TenantInvite.email",
        plaintext,
        "emailLowercase"
      );
      const result = await prisma.tenantInvite.updateMany({
        where: { id: row.id, email: plaintext },
        data: { email: ct, emailHash: hash },
      });
      if (result.count > 0) migrated++;
      else skippedAlready++;
    }
  }

  console.log(
    `[migrate]   tenant_invite: total=${total} migrated=${migrated} ` +
      `skipped_already=${skippedAlready} skipped_empty=${skippedEmpty}`
  );
}

async function migrateJournalEntryNotes(prisma: PrismaClient): Promise<void> {
  console.log("[migrate] starting journal_entry_note authorEmail backfill");
  let total = 0;
  let migrated = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.journalEntryNote.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, authorEmail: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      if (!row.authorEmail) {
        skippedEmpty++;
        continue;
      }
      if (looksEncrypted(row.authorEmail)) {
        skippedAlready++;
        continue;
      }
      const ct = encryptField(row.authorEmail);
      if (!ct) {
        skippedEmpty++;
        continue;
      }
      const result = await prisma.journalEntryNote.updateMany({
        where: { id: row.id, authorEmail: row.authorEmail },
        data: { authorEmail: ct },
      });
      if (result.count > 0) migrated++;
      else skippedAlready++;
    }
  }

  console.log(
    `[migrate]   journal_entry_note.authorEmail: total=${total} ` +
      `migrated=${migrated} skipped_already=${skippedAlready} ` +
      `skipped_empty=${skippedEmpty}`
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  console.log("[migrate] Phase 3 — 2 confidential columns");
  await migrateTenantInvites(prisma);
  await migrateJournalEntryNotes(prisma);
  console.log("[migrate] complete.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
