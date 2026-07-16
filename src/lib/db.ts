// Singleton PrismaClient with the SOC 2 encrypted-fields extension.
//
// Next.js hot-reloads modules in dev, which creates new PrismaClient
// instances and exhausts the Postgres connection pool. The standard
// workaround is to attach the client to a global so HMR reuses it.
//
// Encrypted-fields extension (Confidentiality TSC): transparently
// AES-256-GCM-encrypts on write + decrypts on read for the columns
// listed in `src/lib/db/encrypted-fields-extension.ts`. Feature
// code never has to remember to encrypt — `prisma.journalEntry
// .create({ data: { memo } })` writes ciphertext to Postgres, and
// every read returns the decrypted plaintext. Skips already-
// encrypted values for idempotency during rollout, and passes
// plaintext through (with one warning) when FIELD_ENCRYPTION_KEY
// is unset — the rollout safety net.

import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { encryptedFieldsExtension } from "@/lib/db/encrypted-fields-extension";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Canonical "transaction-capable client" type. Modules that can run
// either standalone or inside an outer $transaction (postJournalEntry,
// the close/recon/flux rollups, the notification dispatchers, fx) take
// this instead of PrismaClient so callers can pass the tx client.
// Defined once here — do not redeclare locally.
export type DbClient = PrismaClient | Prisma.TransactionClient;

function buildPrisma(): PrismaClient {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  // The extension augments runtime behavior but its type
  // (DynamicClientExtensionThis<...>) is incompatible with the
  // existing PrismaClient consumer surface across the codebase (every
  // function that takes a `PrismaClient` parameter). The runtime
  // dispatch still walks through the extension's query hooks — only
  // the static type is downcast. This is the standard Prisma 5
  // ergonomics escape hatch documented in
  // https://github.com/prisma/prisma/issues/20678.
  return base.$extends(encryptedFieldsExtension) as unknown as PrismaClient;
}

export const prisma: PrismaClient = global.prisma ?? buildPrisma();

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}
