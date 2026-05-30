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
// Production code MUST NOT import this helper. It's gated to
// NODE_ENV !== "production" to prevent that mistake. The test
// runner sets NODE_ENV=test so this works in CI.

import type { PrismaClient } from "@prisma/client";

const ROLE_GATE =
  process.env.NODE_ENV === "production"
    ? "Production code cannot use the audit-log cleanup escape hatch."
    : null;

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
