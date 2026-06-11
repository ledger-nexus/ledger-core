// Singleton PrismaClient.
//
// Next.js hot-reloads modules in dev, which creates new PrismaClient
// instances and exhausts the Postgres connection pool. The standard
// workaround is to attach the client to a global so HMR reuses it.

import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

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

export const prisma =
  global.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}
