// Retention runner. Walks every policy once and reports per-policy
// counts. Called by the daily cron at /api/cron/retention.
//
// Failure model, and why:
//
//   - One policy throwing does NOT stop the others. Each runs in its
//     own try/catch and the error lands in that policy's result. A
//     schema change that breaks the invite purge must not silently
//     stop email deliveries from being purged too — that failure mode
//     is invisible and compounds daily.
//
//   - The runner never throws. The cron route turns a completed run
//     into a 200 plus an audit row, even when policies failed. "The
//     cron ran and two policies errored" is a far more useful signal
//     than a 500, because the absence of the daily audit row is what
//     you actually alert on.
//
//   - Errors are passed through sanitizeError, so a DB message
//     carrying row content can't reach the audit row or the response.

import type { PrismaClient } from "@prisma/client";
import { RETENTION_POLICIES, type RetentionResult } from "./policies";
import { redactPii } from "@/lib/soc2";

/**
 * Audit-safe label for a failed policy.
 *
 * NOT sanitizeError(). That helper passes the ORIGINAL message through
 * whenever the error carries a `.code` property — and every Prisma
 * error does (P2002, P2023, …). So `sanitizeError(prismaErr).message`
 * is the raw Prisma message, which for a failed bulk delete can carry
 * SQL text, column names, and constraint details. That string would
 * land in an audit row an auditor reads.
 *
 * Keep the code — short, safe, and the only genuinely diagnostic part —
 * and nothing else. The operator gets the full (redacted) error in the
 * server log.
 */
function auditSafeError(e: unknown): string {
  const code =
    e && typeof e === "object" && "code" in e && typeof e.code === "string"
      ? e.code
      : null;
  return code
    ? `Retention policy failed (${code}); see server logs.`
    : "Retention policy failed; see server logs.";
}

export interface RetentionRunSummary {
  ranAt: Date;
  results: RetentionResult[];
  totalRowsDeleted: number;
  totalErrors: number;
}

/**
 * Run every retention policy once.
 *
 * NEVER call this from a Server Action or any user-reachable path.
 * Retention is a system function on a clock; wiring it to a request
 * hands a user a button that hard-deletes rows in bulk.
 *
 * @param now Injectable clock. Tests pass a fixed date so cutoffs are
 *            deterministic rather than relative to when CI happened
 *            to run.
 */
export async function runRetentionPurge(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<RetentionRunSummary> {
  const results: RetentionResult[] = [];

  for (const policy of RETENTION_POLICIES) {
    const cutoff = new Date(now.getTime() - policy.retentionDays * 86_400_000);
    const start = Date.now();
    try {
      const rowsDeleted = await policy.purge(prisma, cutoff);
      results.push({
        policyId: policy.id,
        rowsDeleted,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      // Operator detail goes to the server log, redacted. The audit row
      // gets only the safe label — see auditSafeError above.
      console.error(
        `[retention] policy ${policy.id} failed:`,
        redactPii(e instanceof Error ? e.message : String(e))
      );
      results.push({
        policyId: policy.id,
        rowsDeleted: 0,
        durationMs: Date.now() - start,
        error: auditSafeError(e),
      });
    }
  }

  return {
    ranAt: now,
    results,
    totalRowsDeleted: results.reduce((sum, r) => sum + r.rowsDeleted, 0),
    totalErrors: results.filter((r) => r.error != null).length,
  };
}

export { RETENTION_POLICIES, type RetentionResult } from "./policies";
