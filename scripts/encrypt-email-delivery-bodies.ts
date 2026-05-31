// One-shot migration: encrypt the existing `email_delivery.{subject,
// bodyText, bodyHtml}` columns in place. Idempotent — skips rows
// where the column already looks encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with the EmailDelivery columns in
//      ENCRYPTED_COLUMNS (so new writes already encrypt)
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-email-delivery-bodies.ts
//
// Safe to interrupt and resume. Each row gets evaluated
// column-by-column so a partial run leaves the rest in a consistent
// state.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 100;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential columns");

  let total = 0;
  let touched = 0;
  let skippedAlready = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.emailDelivery.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: {
        id: true,
        subject: true,
        bodyText: true,
        bodyHtml: true,
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;

      // Each column independently. Skip if already encrypted; replace
      // with ciphertext otherwise. Empty / null pass through.
      const data: Record<string, string | null | undefined> = {};
      let rowTouched = false;

      if (row.subject && !looksEncrypted(row.subject)) {
        const ct = encryptField(row.subject);
        if (ct) {
          data.subject = ct;
          rowTouched = true;
        }
      }
      if (row.bodyText && !looksEncrypted(row.bodyText)) {
        const ct = encryptField(row.bodyText);
        if (ct) {
          data.bodyText = ct;
          rowTouched = true;
        }
      }
      if (row.bodyHtml && !looksEncrypted(row.bodyHtml)) {
        const ct = encryptField(row.bodyHtml);
        if (ct) {
          data.bodyHtml = ct;
          rowTouched = true;
        }
      }

      if (!rowTouched) {
        skippedAlready++;
        continue;
      }

      // Race safety: id + at-least-one-column selector means a
      // concurrent extension write that already encrypted the row
      // won't get clobbered (looksEncrypted on this read returned
      // false, so the column was plaintext at read time; if it's
      // been encrypted since, the matching WHERE fails and we skip).
      await prisma.emailDelivery.updateMany({
        where: {
          id: row.id,
          // Re-assert plaintext on at least one of the columns we're
          // updating. If a concurrent write changed it, the WHERE
          // fails — safer than blind UPDATE.
          OR: Object.keys(data).map((k) =>
            k === "subject"
              ? { subject: row.subject }
              : k === "bodyText"
                ? { bodyText: row.bodyText }
                : { bodyHtml: row.bodyHtml }
          ),
        },
        data,
      });
      touched++;
    }
    if (total % 500 === 0) {
      console.log(
        `[migrate] scanned ${total} rows; ${touched} updated, ${skippedAlready} already done`
      );
    }
  }

  console.log(
    `[migrate] complete. total=${total} updated=${touched} skipped_already=${skippedAlready}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
