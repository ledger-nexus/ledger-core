// GET /api/cron/close-alerts-digest
//
// Counterpart to /api/cron/close-alerts-dispatch. Walks every enabled
// SLACK channel in DIGEST_DAILY mode and posts ONE batched Slack
// message per channel summarizing every NEW close alert since the
// last successful digest. Idempotent — a duplicate cron tick finds
// every alert already in NotificationDispatch and sends nothing.
//
// Verb: GET. Vercel Cron always issues a GET and cannot be configured
// to send anything else, so a route registered in vercel.json that
// exports only POST is scheduled on paper and 405s on every fire,
// silently, forever. See /api/cron/retention for the long-form version
// of this reasoning.
//
// This route sends outbound Slack messages, so GET is doing real work.
// It is acceptable because isAuthorizedCronRequest gates it with a
// timing-safe CRON_SECRET check that fails closed when the secret is
// unset or under 16 chars, and because the dispatch dedupe table makes
// an extra fire a no-op rather than a double-page.
//
// Auth: same as the immediate dispatch route — `Authorization: Bearer
// <CRON_SECRET>` header (Vercel cron default) or `?cron_secret=`
// query (manual triggering).
//
// Schedule: once daily 09:00 UTC. The dedupe table makes any cadence
// safe but a second daily tick is operationally pointless.
//
// Response: aggregate counters across all tenants. Returns 200 even
// when individual sends fail; failures land as NotificationDispatch
// rows with sendStatus / sendError set, mirroring the immediate path.
//
// SOC 2:
//   CC6.3  cron-secret auth via timing-safe compare
//   CC7.2  every batched alert writes a notification_dispatch row;
//          one aggregate audit_log row per tick summarizes the run

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { logAuditEvent } from "@/lib/audit/log";
import { dispatchCloseDigests } from "@/lib/notifications/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  const result = await dispatchCloseDigests(prisma);

  // One aggregate audit row per digest tick. Granular per-alert audit
  // lives in notification_dispatch (the row IS the audit record for
  // each outbound alert). `actorEmail` carries the "system:cron"
  // sentinel — same convention as the IMMEDIATE dispatch route.
  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "notifications.cron.digest",
    actorUserId: null,
    actorEmail: "system:cron",
    resource: "NotificationDispatch",
    resourceId: `digest:${startedAt.toISOString()}`,
    tenantId: null,
    metadata: {
      tenantsScanned: result.summary.tenantsScanned,
      channelsConsidered: result.summary.channelsConsidered,
      channelsSent: result.summary.channelsSent,
      alertsBatched: result.summary.alertsBatched,
      alertsSkippedDedupe: result.summary.alertsSkippedDedupe,
      alertsSkippedSeverity: result.summary.alertsSkippedSeverity,
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
