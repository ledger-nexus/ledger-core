// One-shot migration: encrypt `user.email` in place AND populate
// `user.emailHash` for the deterministic-encryption rollout (Phase 2).
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. FIELD_DETERMINISTIC_KEY is set in the target environment
//   3. The extension is deployed with User.email + searchHash:
//      { hashColumn: "emailHash", domain: "User.email",
//        normalize: "emailLowercase" } in ENCRYPTED_COLUMNS
//   4. The schema migration that adds `app_user.emailHash` (BYTEA,
//      UNIQUE) has been applied to production
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep '^FIELD_ENCRYPTION_KEY' .env.local | cut -d= -f2) \
//   FIELD_DETERMINISTIC_KEY=$(grep '^FIELD_DETERMINISTIC_KEY' .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-user-emails.ts
//
// What it does, per row:
//   1. If the on-disk email already looksEncrypted AND emailHash is
//      non-NULL → skip (already migrated).
//   2. Otherwise: encryptField(email) → write to email column.
//      searchHash("User.email", email, "emailLowercase") → write to
//      emailHash column.
//
// Race-safe: the update WHERE clause includes the original (plaintext)
// email value, so a concurrent extension write that already migrated
// the row won't get clobbered.

import { PrismaClient } from "@prisma/client";
import { encryptField, looksEncrypted } from "../src/lib/soc2/field-encryption";
import { searchHash } from "../src/lib/soc2/deterministic-encryption";

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential column + search hash");

  let total = 0;
  let migrated = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.user.findMany({
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

      // Either:
      //   (a) email is plaintext, emailHash is NULL — typical legacy row
      //   (b) email is plaintext, emailHash already populated (extension
      //       wrote the hash on a non-encrypting deploy) — unlikely
      //   (c) email is ciphertext, emailHash is NULL — partial migration,
      //       can't recover the plaintext to recompute hash, must skip
      //       with a warning
      if (alreadyEncrypted && !alreadyHashed) {
        console.warn(
          `[migrate] row ${row.id} has encrypted email but NULL emailHash. ` +
            "Can't recompute hash without plaintext. Skipping — row must " +
            "be migrated manually (decrypt with current key, recompute " +
            "hash, write both)."
        );
        skippedEmpty++;
        continue;
      }

      // Plaintext email — encrypt AND hash. Both must succeed; if the
      // deterministic key isn't set, error loudly rather than write
      // half a migration.
      const plaintext = row.email;
      const ct = encryptField(plaintext);
      if (!ct) {
        skippedEmpty++;
        continue;
      }
      const hash = searchHash("User.email", plaintext, "emailLowercase");

      // Race-safe selector — if the row was already migrated by a
      // concurrent extension write, the email column no longer equals
      // the plaintext and updateMany returns 0.
      const result = await prisma.user.updateMany({
        where: { id: row.id, email: plaintext },
        data: { email: ct, emailHash: hash },
      });
      if (result.count > 0) migrated++;
      else skippedAlready++;
    }

    if (total % 5000 === 0) {
      console.log(
        `[migrate] scanned ${total}; migrated=${migrated}, skipped_already=${skippedAlready}, skipped_empty=${skippedEmpty}`
      );
    }
  }

  console.log(
    `[migrate] complete. total=${total} migrated=${migrated} skipped_already=${skippedAlready} skipped_empty=${skippedEmpty}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
