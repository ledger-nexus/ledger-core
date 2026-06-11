// GET /api/close/retrospective/csv?lookback=N&target=N
//
// Close-process retrospective CSV export. Same data as the
// /close/retrospective page, formatted as four sections in one CSV
// so the controller can drop it straight into a board deck without
// re-keying numbers.
//
// Sections (each preceded by a banner row):
//   1. SUMMARY        — overall stats (avg days-to-close, etc.)
//   2. DAYS_TO_CLOSE  — per-period close dates vs SLA
//   3. TASK_LEAD_TIME — avg lead time by category
//   4. EXCEPTION_RATE — per-period recon exception rate
//   5. RECURRING_BLOCKERS — top templates by ever-blocked count
//
// Tenant-scoped + auth-gated. Every pull writes a DATA_EXPORT audit
// row — same as the alerts JSON endpoint. The CSV utility's formula-
// injection guard (escapeFormula) protects against tasks/account
// names that start with `=` etc.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { resolveCurrentScope } from "@/lib/scope";
import { auditDataExport } from "@/lib/audit/log";
import { getCloseRetrospective } from "@/lib/close/retrospective";
import { toCsv, csvFilename, type CsvCell } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOKBACK_MIN = 3;
const LOOKBACK_MAX = 36;
const TARGET_MIN = 1;
const TARGET_MAX = 30;
const LOOKBACK_DEFAULT = 12;
const TARGET_DEFAULT = 5;

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number
): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  const user = await getCurrentUser();
  const tenant = await getCurrentTenant();
  if (!user || !tenant) {
    return NextResponse.json({ error: "Sign in required" }, { status: 403 });
  }

  const url = new URL(req.url);
  const scope = await resolveCurrentScope(url.searchParams);
  if (!scope) {
    return NextResponse.json(
      { error: "No scope available" },
      { status: 403 }
    );
  }

  const entity = await prisma.legalEntity.findFirst({
    where: { code: scope.entityCode, tenantId: tenant.id },
    select: { id: true, code: true, name: true },
  });
  const book = await prisma.book.findUnique({
    where: { code: scope.bookCode },
    select: { id: true, code: true, name: true },
  });
  if (!entity || !book) {
    return NextResponse.json({ error: "Scope not found" }, { status: 404 });
  }

  const lookback = clampInt(
    url.searchParams.get("lookback"),
    LOOKBACK_MIN,
    LOOKBACK_MAX,
    LOOKBACK_DEFAULT
  );
  const targetDays = clampInt(
    url.searchParams.get("target"),
    TARGET_MIN,
    TARGET_MAX,
    TARGET_DEFAULT
  );

  const retro = await getCloseRetrospective(
    prisma,
    { tenantId: tenant.id, entityId: entity.id, bookId: book.id },
    lookback,
    targetDays
  );

  // Build the CSV. Each section header is a single-cell banner;
  // sub-headers + data follow. Empty rows separate sections so the
  // file reads cleanly when opened in Excel.
  const rows: CsvCell[][] = [];

  // ── SUMMARY section ──────────────────────────────────────────
  rows.push(["SUMMARY"]);
  rows.push(["entity", entity.code]);
  rows.push(["book", book.code]);
  rows.push(["lookback_periods", lookback]);
  rows.push(["target_days", targetDays]);
  rows.push(["closed_periods_in_window", retro.summary.closedPeriodCount]);
  rows.push([
    "avg_days_to_close",
    retro.summary.avgDaysToClose === null
      ? ""
      : retro.summary.avgDaysToClose.toFixed(2),
  ]);
  rows.push([
    "pct_met_target",
    retro.summary.pctMetTarget === null
      ? ""
      : (retro.summary.pctMetTarget * 100).toFixed(2) + "%",
  ]);
  rows.push([
    "avg_exception_rate",
    retro.summary.avgExceptionRate === null
      ? ""
      : (retro.summary.avgExceptionRate * 100).toFixed(2) + "%",
  ]);
  rows.push(["total_recons_in_window", retro.summary.totalReconsCompleted]);
  rows.push(["total_tasks_completed", retro.summary.totalTasksCompleted]);
  rows.push([]);

  // ── DAYS_TO_CLOSE section ────────────────────────────────────
  rows.push(["DAYS_TO_CLOSE"]);
  rows.push(["period_code", "period_ends_on", "closed_at", "days_to_close", "met_target"]);
  for (const p of retro.daysToCloseTrend) {
    rows.push([
      p.periodCode,
      p.endsOn.toISOString().slice(0, 10),
      p.closedAt.toISOString().slice(0, 10),
      p.daysToClose,
      p.metTarget ? "true" : "false",
    ]);
  }
  rows.push([]);

  // ── TASK_LEAD_TIME section ───────────────────────────────────
  rows.push(["TASK_LEAD_TIME"]);
  rows.push(["category", "avg_lead_days", "sample_size"]);
  for (const c of retro.taskLeadTime) {
    rows.push([c.category, c.avgLeadDays.toFixed(2), c.sampleSize]);
  }
  rows.push([]);

  // ── EXCEPTION_RATE section ───────────────────────────────────
  rows.push(["EXCEPTION_RATE"]);
  rows.push(["period_code", "total_recons", "exception_count", "rate_pct"]);
  for (const p of retro.exceptionRateTrend) {
    rows.push([
      p.periodCode,
      p.totalRecons,
      p.exceptionCount,
      (p.rate * 100).toFixed(2) + "%",
    ]);
  }
  rows.push([]);

  // ── RECURRING_BLOCKERS section ───────────────────────────────
  rows.push(["RECURRING_BLOCKERS"]);
  rows.push(["template_key", "task_name", "blocked_count", "total_count", "block_rate_pct"]);
  for (const b of retro.recurringBlockers) {
    rows.push([
      b.templateKey ?? "adhoc",
      b.name,
      b.blockedCount,
      b.totalCount,
      (b.blockRate * 100).toFixed(2) + "%",
    ]);
  }

  const csv = toCsv(rows);

  // rowCount approximates "data rows" — exclude banners, sub-
  // headers, and blank separators. Five sections × ~2 non-data
  // rows = 10 rows of structure. Close-enough for the audit log;
  // the resourceId carries the period + lookback for the precise
  // identification.
  const rowCount =
    retro.daysToCloseTrend.length +
    retro.taskLeadTime.length +
    retro.exceptionRateTrend.length +
    retro.recurringBlockers.length;

  await auditDataExport({
    actor: { id: user.id, email: user.email },
    format: "csv",
    resource: "CloseRetrospective",
    resourceId: `${entity.code}/${book.code}/lookback=${lookback}/target=${targetDays}`,
    rowCount,
    tenantId: tenant.id,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(
        `retrospective-${entity.code}-${book.code}`
      )}"`,
    },
  });
}
