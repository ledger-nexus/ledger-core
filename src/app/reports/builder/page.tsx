// Report Builder PR 9 — Template registry with persistence.
//
// Lists every template visible in the current tenant:
//   - System templates (IS / BS / CF / EQ) — same regardless of tenant
//   - User-defined templates (clones + edits) — per-tenant from DB
//
// Each row has an "Open" link to render it. User-defined rows also get
// "Rename" + "Delete". Every system row has a "Clone" button that
// creates a copy in the tenant's DB so they can customize it (PR 10
// will ship the editor; this PR proves the persistence pipeline works).

import Link from "next/link";

import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getViewerRole } from "@/lib/auth/authorize";
import { canManageReportTemplates } from "@/lib/auth/policy";

import { SYSTEM_TEMPLATES } from "@/lib/accounting/reports/builder/templates";
import { listTemplates } from "@/lib/accounting/reports/builder/repository";
import {
  cloneReportTemplate,
  deleteReportTemplate,
} from "@/app/actions/report-templates";

export const dynamic = "force-dynamic";

interface RowVM {
  id: string | null; // null for unseeded SYSTEM defaults
  code: string;
  name: string;
  isSystem: boolean;
  version: number;
  source: "db" | "registry";
}

export default async function ReportBuilderIndex() {
  const tenant = await getCurrentTenant();
  // Affordance gate only — the Server Actions re-check and audit.
  const canManage = canManageReportTemplates(await getViewerRole());

  // Build the unified template list:
  //   - DB rows for this tenant (system + user)
  //   - SYSTEM_TEMPLATES fallback for codes the tenant hasn't been
  //     seeded with yet (so the index always shows the 4 GAAP defaults)
  const dbRows: RowVM[] = tenant
    ? (await listTemplates(prisma, tenant.id)).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        isSystem: r.isSystem,
        version: r.version,
        source: "db" as const,
      }))
    : [];
  const dbCodes = new Set(dbRows.map((r) => r.code));
  const registryRows: RowVM[] = SYSTEM_TEMPLATES.filter(
    (t) => !dbCodes.has(t.code)
  ).map((t) => ({
    id: null,
    code: t.code,
    name: t.name,
    isSystem: true,
    version: t.version,
    source: "registry" as const,
  }));
  const all = [...registryRows, ...dbRows];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Reports — Builder</h2>
        <p className="text-sm text-ink-500">
          The 4 GAAP financial statements (system templates) plus any
          tenant-specific clones. Clone a system template to customize
          rows / columns / filters for your chart. Editor lands in PR 10
          — for now the clone is a verbatim copy you can rename and
          render.
        </p>
      </div>

      {!tenant ? (
        <EmptyState
          title="No tenant selected"
          description="Sign in and select a tenant to see your templates."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {all.map((t) => {
            return (
              <Card key={`${t.source}-${t.code}-${t.id ?? "reg"}`}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle>{t.name}</CardTitle>
                    {t.isSystem ? (
                      <Badge tone="info">system</Badge>
                    ) : (
                      <Badge tone="positive">custom</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex items-end justify-between gap-3">
                  <div className="text-sm text-ink-500">
                    <p>
                      <code className="text-xs">{t.code}</code> · v{t.version}
                    </p>
                    {t.source === "registry" && (
                      <p className="text-xs text-ink-500">
                        not yet persisted in this tenant — will lazy-seed on first
                        clone
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/reports/builder/${t.code}`}
                      className="rounded border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
                    >
                      Open →
                    </Link>
                    {t.isSystem && canManage && (
                      <form
                        action={async () => {
                          "use server";
                          await cloneReportTemplate({
                            sourceCode: t.code,
                            newCode: `${t.code}_COPY`,
                            newName: `${t.name} (copy)`,
                          });
                        }}
                      >
                        <button
                          type="submit"
                          className="rounded border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
                        >
                          Clone
                        </button>
                      </form>
                    )}
                    {!t.isSystem && t.id && canManage && (
                      <form
                        action={async () => {
                          "use server";
                          await deleteReportTemplate({ templateId: t.id! });
                        }}
                      >
                        <button
                          type="submit"
                          className="rounded border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </form>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
