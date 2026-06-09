// Report Builder PR 6 — Generic /reports/builder/[code] matrix renderer.
//
// One dynamic route renders ANY ReportTemplate by its code:
//
//   /reports/builder/IS  → Income Statement
//   /reports/builder/BS  → Balance Sheet
//   /reports/builder/CF  → Cash Flow Statement
//   /reports/builder/EQ  → Statement of Stockholders' Equity
//   /reports/builder/MY-CUSTOM-1 → user-defined template (PR 7+)
//
// v1 resolves [code] against SYSTEM_TEMPLATES only. When per-tenant
// ReportTemplate rows land (PR 7), this page will fall through to the
// DB. For now, the 4 GAAP defaults plus any user-cloned variant (which
// gets seeded via seedSystemTemplates) render here.
//
// Multi-tenant: scope comes from getCurrentScope (session cookie →
// tenant-verified entity). Cross-tenant reads impossible — entityCode
// resolution and getAccountBalances both tenant-scope.

import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { formatDate } from "@/lib/utils/format";

import { renderTemplate } from "@/lib/accounting/reports/builder/render";
import { SYSTEM_TEMPLATES } from "@/lib/accounting/reports/builder/templates";
import type { ReportTemplate } from "@/lib/accounting/reports/builder/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { code: string };
  searchParams: { asOf?: string };
}

export default async function ReportBuilderPage({ params, searchParams }: PageProps) {
  const code = params.code.toUpperCase();
  const template: ReportTemplate | undefined = SYSTEM_TEMPLATES.find(
    (t) => t.code === code
  );
  if (!template) {
    notFound();
  }

  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before viewing reports."
      />
    );
  }

  const asOfStr = searchParams.asOf ?? new Date().toISOString().slice(0, 10);
  const asOfDate = new Date(asOfStr);

  const matrix = await renderTemplate(prisma, template, {
    asOfDate,
    entityCode: scope.entityCode,
    bookCode: scope.bookCode,
    tenantId: scope.tenantId,
  });

  // Filter out spacer rows for cleaner UI presentation. Header rows
  // stay; they get rendered as section headings.
  const displayRows = matrix.rows;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">{template.name}</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · as of {formatDate(asOfDate)}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <form method="GET" className="flex items-end gap-2">
            <div>
              <Label htmlFor="asOf">As of</Label>
              <Input type="date" name="asOf" id="asOf" defaultValue={asOfStr} />
            </div>
            <button
              type="submit"
              className="rounded border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
            >
              Update
            </button>
          </form>
          <Link
            href={`/api/reports/builder/${template.code}/csv?asOf=${asOfStr}`}
            className="rounded border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
          <Link
            href={`/api/reports/builder/${template.code}/pdf?asOf=${asOfStr}`}
            className="rounded border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            Download PDF
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{template.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Row</TH>
                {matrix.columns.map((col) => (
                  <TH key={col.id} className="text-right">
                    {col.label}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {displayRows.map((row) => {
                if (row.isSpacer) {
                  return (
                    <TR key={row.id}>
                      <TD colSpan={matrix.columns.length + 1}>&nbsp;</TD>
                    </TR>
                  );
                }
                if (row.isHeader) {
                  return (
                    <TR key={row.id} className="bg-ink-50">
                      <TD
                        colSpan={matrix.columns.length + 1}
                        className="font-semibold text-ink-800"
                      >
                        {row.label}
                      </TD>
                    </TR>
                  );
                }
                const emphasize = row.isSubtotal || row.isFormula;
                return (
                  <TR key={row.id} className={emphasize ? "font-semibold" : ""}>
                    <TD>{row.label}</TD>
                    {row.cells.map((cell, idx) => (
                      <TD key={idx} className="text-right tabular-nums">
                        {cell.display}
                      </TD>
                    ))}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-ink-500">
        Rendered by the report-builder engine (template <code>{template.code}</code>,
        version {template.version}). System templates ship as the 4 GAAP defaults
        and operators can clone + customize per-tenant (PR 7).
      </p>
    </div>
  );
}
