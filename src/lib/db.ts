// Singleton PrismaClient.
//
// Next.js hot-reloads modules in dev, which creates new PrismaClient
// instances and exhausts the Postgres connection pool. The standard
// workaround is to attach the client to a global so HMR reuses it.

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}
