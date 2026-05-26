// CSV export of audit_log rows — admin-only + tenant-scoped.
//
// Mirrors /admin/audit-log's filter contract so the user can apply
// filters in the UI, then hit "Download CSV" to grab the same rows
// they're looking at.
//
// Quarterly access reviews for SOC 2 CC4 want this as a spreadsheet
// (the reviewer sorts, marks off, sets up pivots). Pasting from the
// HTML table loses metadata structure; the CSV preserves it.
//
// The export itself is a DATA_EXPORT audit event (auditDataExport),
// recorded BEFORE the response is streamed. The download is logged
// even if the user closes the tab mid-transfer.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getCurrentUser,
  isAdmin,
} from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
import { toCsv, csvFilename } from "@/lib/utils/csv";
import type { AuditEventType, AuditOutcome, Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard cap on the row count exported in a single download. The UI lists
// 50 per page; exports take the same filters but should fit a reasonable
// spreadsheet without choking the browser. 10k rows = ~3 MB CSV, well
// within Excel/Sheets limits. Beyond that, the user should narrow filters.
const MAX_ROWS = 10_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ─── Auth + tenant gate ───────────────────────────────────────────────
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  const tenant = await getCurrentTenant();

  // ─── Parse + validate filter params ───────────────────────────────────
  const url = new URL(req.url);
  const event = url.searchParams.get("event");
  const outcome = url.searchParams.get("outcome");
  const actor = url.searchParams.get("actor");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  // Default range = last 7 days (matches the page's default so a button
  // click without filter overrides produces the same view).
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromDate = new Date(fromParam ?? sevenDaysAgo.toISOString().slice(0, 10));
  const toDate = new Date(toParam ?? today.toISOString().slice(0, 10));
  toDate.setHours(23, 59, 59, 999);

  // ─── Build the where clause ──────────────────────────────────────────
  // Same logic as the list page. Default-tenant admin sees their tenant's
  // rows + platform NULL-tenant rows.
  const where: Prisma.AuditLogWhereInput = {
    occurredAt: { gte: fromDate, lte: toDate },
  };
  if (tenant && tenant.slug === "default") {
    where.OR = [{ tenantId: tenant.id }, { tenantId: null }];
  } else if (tenant) {
    where.tenantId = tenant.id;
  } else {
    where.tenantId = "00000000-0000-0000-0000-000000000000";
  }
  if (event) where.eventType = event as AuditEventType;
  if (outcome) where.outcome = outcome as AuditOutcome;
  if (actor) where.actorEmail = { contains: actor, mode: "insensitive" };

  // ─── Fetch ────────────────────────────────────────────────────────────
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    take: MAX_ROWS + 1, // peek one extra so we can warn on truncation
    select: {
      id: true,
      occurredAt: true,
      eventType: true,
      action: true,
      outcome: true,
      actorUserId: true,
      actorEmail: true,
      ipAddress: true,
      userAgent: true,
      resource: true,
      resourceId: true,
      metadata: true,
      tenantId: true,
    },
  });
  const truncated = rows.length > MAX_ROWS;
  const exported = truncated ? rows.slice(0, MAX_ROWS) : rows;

  // ─── Audit the export itself ──────────────────────────────────────────
  // We record this BEFORE shipping the response so even a mid-transfer
  // disconnect leaves a row. Note: the row written here is also visible
  // in subsequent downloads — that's intentional, the trail is self-
  // documenting.
  await auditDataExport({
    actor: { id: currentUser.id, email: currentUser.email },
    format: "csv",
    resource: "AuditLog",
    rowCount: exported.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  // ─── Build CSV ────────────────────────────────────────────────────────
  // Header row + metadata header rows so a downstream reader sees the
  // filter context without needing to inspect the URL.
  const filterDescription = [
    `From: ${fromDate.toISOString().slice(0, 10)}`,
    `To: ${toDate.toISOString().slice(0, 10)}`,
    event ? `Event: ${event}` : "Event: all",
    outcome ? `Outcome: ${outcome}` : "Outcome: all",
    actor ? `Actor: ${actor}` : "Actor: all",
  ].join(" · ");

  const csvRows: (string | number | null)[][] = [
    [
      `Audit log export · ${tenant?.name ?? "(no tenant)"} · ${filterDescription}`,
    ],
    [],
    [
      "Occurred at (UTC)",
      "Event type",
      "Outcome",
      "Action",
      "Actor email",
      "Actor user id",
      "Resource",
      "Resource id",
      "IP address",
      "User agent",
      "Metadata (JSON)",
      "Tenant id",
      "Row id",
    ],
    ...exported.map((r) => [
      r.occurredAt.toISOString(),
      r.eventType,
      r.outcome,
      r.action,
      r.actorEmail ?? "",
      r.actorUserId ?? "",
      r.resource ?? "",
      r.resourceId ?? "",
      r.ipAddress ?? "",
      r.userAgent ?? "",
      r.metadata ? JSON.stringify(r.metadata) : "",
      r.tenantId ?? "",
      r.id,
    ]),
  ];
  if (truncated) {
    csvRows.push([]);
    csvRows.push([
      `Truncated at ${MAX_ROWS} rows — narrow your filters to see the rest.`,
    ]);
  }

  return new NextResponse(toCsv(csvRows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(
        "audit-log",
        new Date().toISOString().slice(0, 10)
      )}"`,
    },
  });
}
