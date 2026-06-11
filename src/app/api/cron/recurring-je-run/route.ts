// POST /api/cron/recurring-je-run
//
// Cron-only route. Drives the recurring-JE engine against today as
// the throughDate. Walks every active template across every tenant
// and posts whatever cadence steps are due. Idempotent — the engine's
// (sourceSystem, sourceRecordType, sourceRecordId) lineage triple
// dedupes against the partial unique index on journal_entry, so
// re-firing the cron is safe.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` header (Vercel cron
// default) or `?cron_secret=<...>` query param (manual trigger).
//
// Schedule: vercel.json fires this nightly at 02:00 UTC. Aligned
// with month-end so any template whose docDate falls today (e.g. the
// last day of the month) gets posted before the next business day.
// The dedupe makes any cadence safe — daily is just sufficient.
//
// Response: aggregate counters across all tenants + per-template
// detail surfaced from runRecurringEntries. Returns 200 even when
// individual template posts fail; failures are reflected in the
// per-template `errors` array.
//
// SOC 2:
//   CC6.3  cron-secret auth via timing-safe compare
//   CC6.1  the engine's queries are tenant-scoped; we pass no
//          tenantId override, so the runner walks every tenant
//   CC7.2  one aggregate audit_log row per cron tick; per-JE
//          PRIVILEGED_ACTION rows are written by postJournalEntry
//          itself for each produced entry

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { logAuditEvent } from "@/lib/audit/log";
import { runRecurringEntries } from "@/lib/accounting/recurring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  // throughDate = end-of-today (23:59:59.999 UTC) so any template
  // anchored on today's calendar date is included. enumerateDueDates
  // uses `<= throughDate` comparison.
  const throughDate = new Date(startedAt);
  throughDate.setUTCHours(23, 59, 59, 999);

  const result = await runRecurringEntries(prisma, {
    throughDate,
    triggeredBy: "system:cron",
  });

  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "recurring.cron.run",
    actorUserId: null,
    actorEmail: "system:cron",
    resource: "RecurringEntry",
    resourceId: `tick:${startedAt.toISOString().slice(0, 10)}`,
    tenantId: null,
    metadata: {
      entriesPosted: result.entriesPosted,
      templatesIdle: result.templatesIdle,
      templatesProcessed: result.templates.length,
      templatesWithErrors: result.templates.filter((t) => t.errors.length > 0).length,
      durationMs: Date.now() - startedAt.getTime(),
    },
  });

  return NextResponse.json({
    ok: true,
    startedAt: startedAt.toISOString(),
    throughDate: throughDate.toISOString(),
    summary: {
      entriesPosted: result.entriesPosted,
      templatesIdle: result.templatesIdle,
      templatesProcessed: result.templates.length,
    },
    templates: result.templates,
  });
}

// GET returns 405 so accidental browser visits don't trigger a run.
// Cron-only.
export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Use POST with the Authorization: Bearer header" },
    { status: 405 }
  );
}
