// Paste-from-Excel JE entry — Server Component shell, interactive form
// lives in paste-form.tsx.
//
// What this solves: a CPA has a list of JE lines in Excel (typically 5-50
// rows: complex year-end accruals, customer-detail billings rolled up
// into one JE, a prepaid-amortization schedule). Today they'd re-key
// each line in the new-entry form. Now they paste once.

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { EmptyState } from "@/components/ui/empty-state";
import PasteForm from "./paste-form";

export default async function PastePage() {
  // Tenant-verified scope replaces the prior getScope() + manual
  // getCurrentTenant() pattern.
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before pasting entries."
      />
    );
  }
  const [entities, books] = await Promise.all([
    prisma.legalEntity.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
    prisma.book.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Paste from Excel</h2>
        <p className="text-sm text-ink-500 mt-1 max-w-prose">
          Copy lines from Excel (or any spreadsheet) and paste them below.
          Tab-separated columns; one row per JE line. The parser balances on
          your behalf and shows a preview before posting via the substrate.
        </p>
      </div>
      <PasteForm
        entities={entities}
        books={books}
        defaultEntityCode={scope.entityCode}
        defaultBookCode={scope.bookCode}
      />
    </div>
  );
}
