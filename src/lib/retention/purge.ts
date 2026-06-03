// Retention engine — runs every policy in
// `src/lib/retention/policies.ts` once and returns the per-policy
// counts. Designed to be called from a Vercel Cron route at
// `src/app/api/cron/retention/route.ts` once per day.
//
// Failure model:
//   - One policy throwing does NOT stop the others. Each policy runs
//     in its own try/catch; errors are captured into the result. The
//     cron route logs the entire result (errors + counts) to
//     audit_log so a regression in one policy shows up in the next
//     SOC 2 review.
//   - The cron route returns 200 even when individual policies fail.
//     The signal "this cron ran" is more valuable than the signal
//     "every policy succeeded" — a non-200 here would page on every
//     transient DB hiccup.

import type { PrismaClient } from "@prisma/client";
import { RETENTION_POLICIES, type RetentionResult } from "./policies";
import { sanitizeError } from "@/lib/soc2";

export interface RetentionRunSummary {
  ranAt: Date;
  results: RetentionResult[];
  totalRowsDeleted: number;
  totalErrors: number;
}

/**
 * Run every retention policy once. The caller is expected to be a
 * scheduled cron OR an operator hitting the endpoint manually. NEVER
 * call this from a Server Action or a user-triggered path — retention
 * is a system function, not a user one.
 */
export async function runRetentionPurge(
  prisma: PrismaClient,
  /** Provide an explicit clock for tests; defaults to wall time. */
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
      results.push({
        policyId: policy.id,
        rowsDeleted: 0,
        durationMs: Date.now() - start,
        error: sanitizeError(e).message,
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

/** Re-export the policy table for the test seam + admin diagnostics. */
export { RETENTION_POLICIES, type RetentionResult } from "./policies";
