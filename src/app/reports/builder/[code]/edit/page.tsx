// Report Builder PR 10 — JSON-based definition editor for cloned templates.
//
// v1 ships a textarea + "Save" form. The operator sees the current
// `definition` Json column pretty-printed and edits in place. The
// Server Action validates via Zod + integrity check before persisting.
//
// This is the "honest" first cut — a per-row form editor (drag-reorder,
// add/remove rows, AccountFilter picker) is a much larger UI surface
// that can layer on top later. For now, an operator who wants to add a
// row pastes the current JSON, edits, and hits Save. The route still
// catches malformed input and never lets bad data hit the DB.
//
// System templates redirect to the read-only matrix renderer — they
// can't be edited from this surface (clone first).

import { notFound, redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { loadTemplate } from "@/lib/accounting/reports/builder/repository";
import { updateReportTemplateDefinition } from "@/app/actions/report-templates";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { code: string };
  searchParams: { err?: string };
}

export default async function ReportBuilderEditPage({
  params,
  searchParams,
}: PageProps) {
  const code = params.code.toUpperCase();

  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before editing reports."
      />
    );
  }

  // Resolve via DB (the editor only operates on persisted rows).
  const dbRow = await prisma.reportTemplate.findUnique({
    where: { tenantId_code: { tenantId: scope.tenantId, code } },
    select: { id: true, code: true, name: true, isSystem: true, version: true, definition: true },
  });
  if (!dbRow) {
    // Maybe this is a system template that hasn't been seeded — fall
    // through to loadTemplate to confirm code is real, then nudge user
    // to clone first.
    const tpl = await loadTemplate(prisma, code, scope.tenantId);
    if (!tpl) notFound();
    return (
      <EmptyState
        title={`"${tpl.code}" is a system template — clone first`}
        description="System templates are immutable. Use the Clone button on the Reports → Builder index to create a tenant-scoped copy you can edit."
        action={{ href: "/reports/builder", label: "Back to builder" }}
      />
    );
  }
  if (dbRow.isSystem) {
    redirect(`/reports/builder/${dbRow.code}`);
  }

  const pretty = JSON.stringify(dbRow.definition, null, 2);

  async function save(formData: FormData): Promise<void> {
    "use server";
    const json = String(formData.get("definitionJson") ?? "");
    // PR 11 adversarial-pass fix: optimistic concurrency. Send the
    // version the editor was loaded with; the Server Action rejects
    // the write if the on-disk version moved.
    const expectedVersionRaw = String(formData.get("expectedVersion") ?? "");
    const expectedVersion = Number.parseInt(expectedVersionRaw, 10);
    if (Number.isNaN(expectedVersion)) {
      const params = new URLSearchParams({
        err: "Missing or invalid expectedVersion — refresh and retry.",
      });
      redirect(`/reports/builder/${dbRow!.code}/edit?${params.toString()}`);
    }
    const result = await updateReportTemplateDefinition({
      templateId: dbRow!.id,
      definitionJson: json,
      expectedVersion,
    });
    if (!result.ok) {
      // Surface the error back through ?err= on the URL — no DB write
      // happens on validation failure OR concurrency conflict.
      const params = new URLSearchParams({ err: result.error });
      redirect(`/reports/builder/${dbRow!.code}/edit?${params.toString()}`);
    }
    redirect(`/reports/builder/${dbRow!.code}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">
          Edit definition — {dbRow.name}
        </h2>
        <p className="text-sm text-ink-500">
          <code className="text-xs">{dbRow.code}</code> · v{dbRow.version} ·
          custom template (tenant-scoped)
        </p>
      </div>

      {searchParams.err && (
        <Card>
          <CardContent>
            <p className="text-sm font-medium text-negative">
              Validation failed — no changes saved.
            </p>
            <pre className="mt-2 whitespace-pre-wrap text-xs text-negative">
              {searchParams.err}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Definition JSON</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-ink-500">
            Edit the JSON below and click Save. The Server Action validates
            shape + cross-references before persisting. On success, the
            template version bumps and the matrix re-renders with your
            changes. On failure, no DB write happens and you'll see the
            validation error above the textarea.
          </p>
          <form action={save} className="flex flex-col gap-3">
            <input
              type="hidden"
              name="expectedVersion"
              value={dbRow.version}
            />
            <textarea
              name="definitionJson"
              defaultValue={pretty}
              rows={30}
              className="w-full rounded border border-ink-300 bg-white p-3 font-mono text-xs leading-relaxed text-ink-800"
              spellCheck={false}
            />
            <div className="flex items-center justify-end gap-2">
              <a
                href={`/reports/builder/${dbRow.code}`}
                className="rounded border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
              >
                Cancel
              </a>
              <button
                type="submit"
                className="rounded border border-ink-700 bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800"
              >
                Save
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
