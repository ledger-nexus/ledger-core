// Report Builder PR 8 — Generic PDF export for any system template.
//
// One route handles all 4 GAAP statements (and any user-defined template
// once persistence lands in PR 9):
//
//   GET /api/reports/builder/IS/pdf?asOf=2026-03-31
//   GET /api/reports/builder/BS/pdf?asOf=2026-03-31
//   GET /api/reports/builder/CF/pdf?asOf=2026-03-31
//   GET /api/reports/builder/EQ/pdf?asOf=2026-03-31
//
// Same SOC 2 baseline as the CSV route: scope from session cookie,
// audit logged via auditDataExport, never trusts client-provided
// tenant / entity, input-validated (400 on bad asOf, 404 on unknown
// code, 403 on no scope). React-PDF runs server-side via @react-pdf/renderer.

import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";

import { renderTemplate } from "@/lib/accounting/reports/builder/render";
import { SYSTEM_TEMPLATES } from "@/lib/accounting/reports/builder/templates";
import { BuilderPdfDocument } from "@/lib/accounting/reports/builder/pdf";

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

  // Audit before serializing — SOC 2 CC7.2.
  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "pdf",
    resource: `ReportTemplate:${template.code}`,
    resourceId: `${scope.entityCode}/${scope.bookCode}/${asOfStr}`,
    rowCount: matrix.rows.filter((r) => !r.isSpacer && !r.isHeader).length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  // Marshal the RenderedMatrix to PDF-friendly plain data. The component
  // file stays JSON-shaped — no Decimal imports, no React-PDF outside
  // pdf.tsx.
  const docProps = {
    template: {
      code: template.code,
      name: template.name,
      version: template.version,
    },
    scope: {
      entityCode: scope.entityCode,
      bookCode: scope.bookCode,
      asOf: asOfStr,
    },
    columns: matrix.columns.map((c) => ({ id: c.id, label: c.label })),
    rows: matrix.rows.map((r) => ({
      id: r.id,
      label: r.label,
      cells: r.cells.map((c) => ({ display: c.display })),
      isHeader: Boolean(r.isHeader),
      isSpacer: Boolean(r.isSpacer),
      isFormula: Boolean(r.isFormula),
      isSubtotal: Boolean(r.isSubtotal),
    })),
    generatedAt:
      new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC",
  };

  const pdfBuffer = await renderToBuffer(BuilderPdfDocument(docProps));
  const filename = `${template.code.toLowerCase()}-${scope.entityCode}-${scope.bookCode}-${asOfStr}.pdf`;

  // Cast through `unknown` — Node 25's stricter Buffer/Uint8Array typing
  // is ahead of @types/node consumers of NextResponse on Next 14.2. The
  // runtime accepts a Buffer fine; this only quiets tsc. Same pattern as
  // src/app/api/reports/month-end/pdf/route.ts.
  return new NextResponse(pdfBuffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.byteLength),
    },
  });
}
