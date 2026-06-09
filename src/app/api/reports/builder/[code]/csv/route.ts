// Report Builder PR 6 — Generic CSV export for any system template.
//
// One route handles all 4 GAAP statements (and any user-defined
// template once persistence lands in PR 7):
//
//   GET /api/reports/builder/IS/csv?asOf=2026-03-31
//   GET /api/reports/builder/BS/csv?asOf=2026-03-31
//   GET /api/reports/builder/CF/csv?asOf=2026-03-31
//   GET /api/reports/builder/EQ/csv?asOf=2026-03-31
//
// Multi-tenant: scope from session cookie via getCurrentScope. NEVER
// trusts client-provided entity / tenant. Audit logged via
// auditDataExport. CSV formula injection (CWE-1236) handled at the
// shared `toCsv` helper.

import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";

import { renderTemplate } from "@/lib/accounting/reports/builder/render";
import { SYSTEM_TEMPLATES } from "@/lib/accounting/reports/builder/templates";
import {
  renderedMatrixToCsv,
  builderCsvFilename,
} from "@/lib/accounting/reports/builder/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: { code: string };
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const code = params.code.toUpperCase();
  const template = SYSTEM_TEMPLATES.find((t) => t.code === code);
  if (!template) {
    return new NextResponse(`Unknown template: ${code}`, { status: 404 });
  }

  const scope = await getCurrentScope();
  if (!scope) {
    return new NextResponse(
      "No scope available — sign in and select a tenant",
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const asOfStr =
    url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const asOfDate = new Date(asOfStr);
  if (Number.isNaN(asOfDate.getTime())) {
    return new NextResponse(`Invalid asOf: ${asOfStr}`, { status: 400 });
  }

  const matrix = await renderTemplate(prisma, template, {
    asOfDate,
    entityCode: scope.entityCode,
    bookCode: scope.bookCode,
    tenantId: scope.tenantId,
  });

  // Audit before serializing — captures intent even if serialization
  // throws. SOC 2 CC7.2: every export is recorded.
  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: `ReportTemplate:${template.code}`,
    rowCount: matrix.rows.filter((r) => !r.isSpacer && !r.isHeader).length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  const csv = renderedMatrixToCsv(matrix, {
    scopeLabel: `${scope.entityCode} / ${scope.bookCode} · as of ${asOfStr}`,
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${builderCsvFilename(template, asOfStr)}"`,
    },
  });
}
