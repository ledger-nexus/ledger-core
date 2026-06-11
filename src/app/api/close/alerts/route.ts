// GET /api/close/alerts?period=YYYY-MM
//
// BlackLine arc — Phase 4 PR 2 sibling. JSON endpoint that returns
// the same alert stream the page renders. Intended for downstream
// integrations (Slack notifier, daily-digest emailer, etc.).
//
// Default behavior: pulls alerts for the latest OPEN period in the
// active scope. Supports ?period=YYYY-MM override.
//
// Tenant-scoped + auth-gated like every other API route. Every pull
// writes a DATA_EXPORT audit row (the alerts payload includes
// account names / task names — names tagged as confidential by
// the encryption stack).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { resolveCurrentScope } from "@/lib/scope";
import { auditDataExport } from "@/lib/audit/log";
import { getCloseAlerts, summarizeAlerts } from "@/lib/close/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  const tenant = await getCurrentTenant();
  if (!user || !tenant) {
    return NextResponse.json(
      { error: "Sign in required" },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const periodParam = url.searchParams.get("period");
  const scope = await resolveCurrentScope(url.searchParams);
  if (!scope) {
    return NextResponse.json(
      { error: "No scope available" },
      { status: 403 }
    );
  }

  const entity = await prisma.legalEntity.findFirst({
    where: { code: scope.entityCode, tenantId: tenant.id },
    select: { id: true, code: true },
  });
  const book = await prisma.book.findUnique({
    where: { code: scope.bookCode },
    select: { id: true, code: true },
  });
  if (!entity || !book) {
    return NextResponse.json({ error: "Scope not found" }, { status: 404 });
  }

  // Period resolution: explicit param wins; else latest OPEN.
  const allPeriods = await prisma.period.findMany({
    where: { calendar: { entityId: entity.id } },
    orderBy: { startsOn: "desc" },
    select: { id: true, code: true, endsOn: true },
  });
  if (allPeriods.length === 0) {
    return NextResponse.json(
      { error: "No periods seeded" },
      { status: 404 }
    );
  }
  let selected = allPeriods[0];
  if (periodParam) {
    const match = allPeriods.find((p) => p.code === periodParam);
    if (!match) {
      return NextResponse.json(
        { error: `Unknown period: ${periodParam}` },
        { status: 404 }
      );
    }
    selected = match;
  } else {
    const closes = await prisma.periodClose.findMany({
      where: { entityId: entity.id, bookId: book.id },
      select: { periodId: true },
    });
    const closedIds = new Set(closes.map((c) => c.periodId));
    const latestOpen = allPeriods.find((p) => !closedIds.has(p.id));
    if (latestOpen) selected = latestOpen;
  }

  const alerts = await getCloseAlerts(prisma, {
    tenantId: tenant.id,
    entityId: entity.id,
    bookId: book.id,
    periodId: selected.id,
    periodCode: selected.code,
  });
  const histogram = summarizeAlerts(alerts);

  await auditDataExport({
    actor: { id: user.id, email: user.email },
    format: "json",
    resource: "CloseAlerts",
    resourceId: `${entity.code}/${book.code}/${selected.code}`,
    rowCount: alerts.length,
    tenantId: tenant.id,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  // Serialize Date objects to ISO strings — JSON.stringify does this
  // by default, but be explicit so consumers know what format to expect.
  return NextResponse.json({
    scope: {
      entity: entity.code,
      book: book.code,
      period: selected.code,
    },
    histogram,
    alerts: alerts.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
    })),
  });
}
