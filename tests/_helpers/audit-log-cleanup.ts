// Test-only escape hatch for the audit_log append-only rule.
//
// Production: the rule
//   prisma/sql/audit-log-append-only.sql
// blocks UPDATE and DELETE on audit_log. Tests need to be able to
// reset state, so they call this helper which:
//
//   1. DROPs the two rules
//   2. Runs the caller-supplied cleanup callback (which can DELETE
//      freely)
//   3. Recreates the rules
//
// The DROP+CREATE is wrapped so a thrown error in the cleanup
// callback still re-arms the rules. Tests should NEVER skip the
// finally block.
//
// Production code MUST NOT import this helper. It's gated on TWO checks:
//
//   1. NODE_ENV !== "production" — blocks production code paths.
//   2. assertDisposableTestDatabase() — NODE_ENV=test alone does NOT prove
//      the CONNECTED database is disposable (a developer could run tests
//      with NODE_ENV=test against a shared or staging DB). Because this
//      helper suspends audit_log's append-only rules + parent FKs via DDL,
//      it refuses to run unless the database is recognizably a throwaway
//      test DB (loopback host, a "test"/"ephemeral" name, or the explicit
//      AUDIT_LOG_DDL_ALLOW=1 opt-in). This protects real audit data.
//
// The test runner sets NODE_ENV=test; CI's DB (mini_ledger_test on
// localhost) satisfies the DB guard on both the host and the name.

import type { Prisma, PrismaClient } from "@prisma/client";

const ROLE_GATE =
  process.env.NODE_ENV === "production"
    ? "Production code cannot use the audit-log cleanup escape hatch."
    : null;

/**
 * Refuse to run the DDL-based escape hatch unless the connected database is
 * recognizably disposable. Read at call time (not module load) so it sees
 * the DATABASE_URL the test process actually connected with.
 */
function assertDisposableTestDatabase(): void {
  // Explicit operator opt-in for a throwaway DB whose name/host doesn't
  // advertise itself (e.g. a personal Neon branch used only for tests).
  if (process.env.AUDIT_LOG_DDL_ALLOW === "1") return;
  const url = process.env.DATABASE_URL ?? "";
  const host = /@([^/:]+)(?::\d+)?\//.exec(url)?.[1]?.toLowerCase() ?? "";
  const onLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "postgres";
  const dbName = url.split("/").pop()?.split("?")[0]?.toLowerCase() ?? "";
  const nameLooksDisposable = dbName.includes("test") || dbName.includes("ephemeral");
  if (onLoopback || nameLooksDisposable) return;
  throw new Error(
    `Refusing to suspend audit_log append-only protections: DATABASE_URL ` +
      `(db "${dbName || "unset"}"${host ? ` on ${host}` : ""}) is not recognizably a ` +
      `disposable test database. NODE_ENV=test alone does not prove the DB is ` +
      `throwaway. If this IS a throwaway test DB, set AUDIT_LOG_DDL_ALLOW=1.`
  );
}

/**
 * Run a cleanup callback with the audit-log append-only rules
 * temporarily disabled. The callback can DELETE / UPDATE audit_log
 * rows freely; the rules are re-armed on return (even if the callback
 * throws).
 *
 * Tests should use this helper only for cleanup between test runs —
 * never for assertions about the rule's behavior. The rule itself is
 * tested in `tests/audit-log-append-only.test.ts`.
 */
export async function withAuditLogMutable<T>(
  prisma: PrismaClient,
  cleanup: () => Promise<T>
): Promise<T> {
  if (ROLE_GATE) throw new Error(ROLE_GATE);
  assertDisposableTestDatabase();

  await prisma.$executeRawUnsafe(
    `DROP RULE IF EXISTS audit_log_no_update ON "audit_log"`
  );
  await prisma.$executeRawUnsafe(
    `DROP RULE IF EXISTS audit_log_no_delete ON "audit_log"`
  );

  try {
    return await cleanup();
  } finally {
    // Re-arm even on cleanup error so the next test run still has the
    // rule in place.
    await prisma.$executeRawUnsafe(
      `CREATE RULE audit_log_no_update AS ON UPDATE TO "audit_log" DO INSTEAD NOTHING`
    );
    await prisma.$executeRawUnsafe(
      `CREATE RULE audit_log_no_delete AS ON DELETE TO "audit_log" DO INSTEAD NOTHING`
    );
  }
}

/**
 * Transaction-bound variant for cleanup that deletes tenant rows referenced
 * by audit_log. Keeping DROP RULE, audit-row deletion, and parent deletion on
 * one connection prevents pooled queries from observing the append-only rules
 * halfway through cleanup. A thrown callback rolls the transaction back,
 * which also restores the rules automatically.
 *
 * The two parent FKs are suspended as well: actorUserId uses ON DELETE SET
 * NULL, which is itself an audit_log UPDATE and is blocked by the append-only
 * update rule. Constraints are recreated with their live-schema actions before
 * the transaction commits.
 */
export async function withAuditLogMutableTransaction<T>(
  prisma: PrismaClient,
  cleanup: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (ROLE_GATE) throw new Error(ROLE_GATE);
  assertDisposableTestDatabase();

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_actorUserId_fkey"`
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_tenantId_fkey"`
      );
      await tx.$executeRawUnsafe(
        `DROP RULE IF EXISTS audit_log_no_update ON "audit_log"`
      );
      await tx.$executeRawUnsafe(
        `DROP RULE IF EXISTS audit_log_no_delete ON "audit_log"`
      );

      const result = await cleanup(tx);

      // A prior interrupted test run may have removed fixture parents while
      // the test-only constraints were suspended. Repair that test-database
      // cruft before validating the constraints again. Actor references use
      // the production FK's SET NULL semantics; tenant-scoped audit rows for
      // deleted fixture tenants have no valid scope and are removed.
      await tx.$executeRawUnsafe(
        `UPDATE "audit_log" AS a SET "actorUserId" = NULL WHERE a."actorUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "app_user" AS u WHERE u."id" = a."actorUserId")`
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM "audit_log" AS a WHERE a."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "tenant" AS t WHERE t."id" = a."tenantId")`
      );

      await tx.$executeRawUnsafe(
        `ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "app_user"("id") ON UPDATE CASCADE ON DELETE SET NULL`
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT`
      );
      await tx.$executeRawUnsafe(
        `CREATE RULE audit_log_no_update AS ON UPDATE TO "audit_log" DO INSTEAD NOTHING`
      );
      await tx.$executeRawUnsafe(
        `CREATE RULE audit_log_no_delete AS ON DELETE TO "audit_log" DO INSTEAD NOTHING`
      );
      return result;
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
}
