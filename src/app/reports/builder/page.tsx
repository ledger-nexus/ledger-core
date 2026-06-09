// Report Builder PR 6 — Template registry index.
//
// Lists every SYSTEM_TEMPLATE with a link to the matrix renderer at
// /reports/builder/[code]. PR 7 will add user-defined templates from
// the ReportTemplate table.

import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SYSTEM_TEMPLATES } from "@/lib/accounting/reports/builder/templates";

export const dynamic = "force-dynamic";

export default function ReportBuilderIndex() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Reports — Builder</h2>
        <p className="text-sm text-ink-500">
          The 4 GAAP financial statements, rendered by the report-builder
          engine. Each template can be cloned + customized per-tenant in PR 7.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {SYSTEM_TEMPLATES.map((t) => (
          <Card key={t.code}>
            <CardHeader>
              <CardTitle>{t.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-end justify-between">
              <div className="text-sm text-ink-500">
                <p>
                  <code className="text-xs">{t.code}</code> · v{t.version}
                </p>
                <p>
                  {t.definition.rows.filter((r) => r.kind === "ACCOUNTS").length}{" "}
                  account rows · {t.definition.columns.length} column
                  {t.definition.columns.length === 1 ? "" : "s"}
                </p>
              </div>
              <Link
                href={`/reports/builder/${t.code}`}
                className="rounded border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
              >
                Open →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
