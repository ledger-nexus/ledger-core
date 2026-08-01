// GET /api/cron/retention
//
// Runs every retention policy once per day and audit-logs the result.
// SOC 2 CC6 + Privacy TSC: the executable half of the retention table
// in docs/policies/data-classification.md.
//
// ─── Why GET, when this endpoint hard-deletes ────────────────────────
//
// Vercel Cron fires a GET and cannot be configured to send anything
// else. A cron route that exports only POST sits in vercel.json looking
// scheduled and returns 405 on every fire — silently, forever.
//
// The other four cron routes here (assertion-check, recurring-je-run,
// close-alerts-digest, close-alerts-dispatch) are POST-only and all
// registered in vercel.json. Nothing has caught it because nothing is
// deployed. Flagged for a separate fix; this route does not copy the
// pattern.
//
// GET on a destructive endpoint is acceptable only because
// isAuthorizedCronRequest gates it with a timing-safe CRON_SECRET check
// that fails closed when the secret is unset or under 16 chars — so an
// unconfigured deployment cannot be made to purge anything, and the URL
// alone is not sufficient to trigger it.
//
// Always 200 on a completed run, even when individual policies error;
// the per-policy detail is in the response and the audit row. A non-200
// would page on any transient DB hiccup. The signal worth alerting on
// is the ABSENCE of a retention.purge audit row in the last 24 hours.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { runRetentionPurge } from "@/lib/retention/purge";
import { logAuditEvent } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await runRetentionPurge(prisma);

  // A system actor with no user and no tenant: the purge crosses every
  // tenant by design. CONFIG_CHANGE rather than PRIVILEGED_ACTION,
  // which implies a human. The append-only rule on audit_log turns the
  // run history into the SOC 2 evidence that retention is not just
  // written down but actually happening, daily.
  await logAuditEvent({
    eventType: "CONFIG_CHANGE",
    action: "retention.purge",
    outcome: summary.totalErrors > 0 ? "ANOMALOUS" : "SUCCESS",
    resource: "RetentionPolicy",
    metadata: {
      ranAt: summary.ranAt.toISOString(),
      totalRowsDeleted: summary.totalRowsDeleted,
      totalErrors: summary.totalErrors,
      // Counts and policy ids only — never the deleted content.
      results: summary.results,
    },
  });

  return NextResponse.json({
    ok: true,
    ...summary,
    ranAt: summary.ranAt.toISOString(),
  });
}
