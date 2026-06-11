// POST /api/cron/close-alerts-dispatch
//
// Cron-only route. Walks all tenants' enabled SLACK channels and
// dispatches new close alerts. Idempotent — a duplicate cron tick
// surfaces as DEDUPED, not a re-send.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` header (Vercel cron
// default) or `?cron_secret=<CRON_SECRET>` query param (manual).
//
// Schedule: vercel.json adds this in PR 4/4. Recommended cadence is
// every 15 minutes during business hours; the dedupe table makes
// even a 1-minute cadence safe but it's wasteful.
//
// Response: aggregate counters across all tenants. The route returns
// 200 even when individual dispatches fail; errors are reflected in
// the counters and the NotificationDispatch rows.
//
// SOC 2:
//   CC6.3  cron-secret auth via timing-safe compare
//   CC7.2  every dispatch (success or fail) writes a NotificationDispatch
//          row; one aggregate audit_log row per invocation summarizes
//          the cron tick

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { logAuditEvent } from "@/lib/audit/log";
import { dispatchCloseAlerts } from "@/lib/notifications/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  const result = await dispatchCloseAlerts(prisma);

  // One aggregate audit row per cron tick. Granular per-dispatch
  // audit lives in the notification_dispatch table itself (the row
  // IS the audit record for that outbound action). Cron events have
  // no human actor — `actorUserId` left null, `actorEmail` carries
  // the "system:cron" sentinel so quarterly access reviews can
  // distinguish unattended events.
  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "notifications.cron.dispatch",
    actorUserId: null,
    actorEmail: "system:cron",
    resource: "NotificationDispatch",
    resourceId: `tick:${startedAt.toISOString()}`,
    tenantId: null,
    metadata: {
      tenantsScanned: result.summary.tenantsScanned,
      channelsConsidered: result.summary.channelsConsidered,
      alertsConsidered: result.summary.alertsConsidered,
      dispatched: result.summary.dispatched,
      skippedDedupe: result.summary.skippedDedupe,
      skippedSeverity: result.summary.skippedSeverity,
      errors: result.summary.errors,
      durationMs: Date.now() - startedAt.getTime(),
    },
  });

  return NextResponse.json({
    ok: true,
    startedAt: startedAt.toISOString(),
    summary: result.summary,
    tenants: result.tenants,
  });
}

// GET returns 405 so accidental browser visits don't trigger a
// dispatch. Cron-only.
export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Use POST with the Authorization: Bearer header" },
    { status: 405 }
  );
}
