// GET /api/cron/retention
//
// Runs every retention policy in src/lib/retention/policies.ts once
// and audit-logs the result. Designed to be called from Vercel Cron
// daily (see vercel.json) but also runnable ad-hoc by an operator with
// the right token.
//
// SOC 2 CC6 + Privacy TSC. The data-classification policy declares
// per-table retention windows; this is the executable form.
//
// Gating:
//   - Vercel Cron: requests carry an `Authorization: Bearer <secret>`
//     header where the secret is set in Vercel as CRON_SECRET. Same
//     pattern as Vercel's documented cron job pattern.
//   - Operator: same header. Distribute CRON_SECRET via 1Password.
//
// Fail-closed: if CRON_SECRET isn't set, the endpoint refuses every
// request. This matches the ADMIN_TOKEN pattern at /api/admin/reset.
//
// Always returns 200 on a completed run, even if individual policies
// errored. The audit-log row captures the per-policy detail. A non-200
// here would page on every transient DB hiccup; the right signal is
// "the cron didn't run at all" (detectable via the absence of a
// DATA_RETENTION_PURGE audit row in the last 24 hours).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runRetentionPurge } from "@/lib/retention/purge";
import { logAuditEvent } from "@/lib/audit/log";
import { constantTimeEqual } from "@/lib/soc2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron uses GET, not POST.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "CRON_SECRET env var is not set — endpoint disabled. Set it in " +
          "the deployment env (and configure the matching Vercel Cron job) " +
          "to enable.",
      },
      { status: 503 }
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!constantTimeEqual(authHeader, expected)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  const summary = await runRetentionPurge(prisma);

  // Audit-log the run with the full per-policy result. The cron is a
  // SYSTEM-tier actor — no userId, no tenantId. CONFIG_CHANGE is the
  // closest existing AuditEventType for "the system changed its own
  // state" (vs. PRIVILEGED_ACTION which implies a human actor). The
  // append-only RULE on audit_log preserves the run history for SOC 2
  // evidence — "we automated retention, here's the daily proof."
  await logAuditEvent({
    eventType: "CONFIG_CHANGE",
    action: "retention.purge",
    outcome: summary.totalErrors > 0 ? "ANOMALOUS" : "SUCCESS",
    actorEmail: "system@cron",
    metadata: {
      ranAt: summary.ranAt.toISOString(),
      totalRowsDeleted: summary.totalRowsDeleted,
      totalErrors: summary.totalErrors,
      results: summary.results,
    },
  });

  return NextResponse.json({
    ok: true,
    ...summary,
    ranAt: summary.ranAt.toISOString(),
  });
}
