// /import/netsuite — NS import landing page. Server Component shell;
// the interactive form lives in import-form.tsx.
//
// What this solves: until now, importing a NetSuite export required the
// CLI (`pnpm demo:ns-multi-sub` or hand-running tsx prisma/...). Real
// operators have an NS export sitting on their desktop and want a UI
// that takes the file and runs the import. That's this page.
//
// The page is a thin shell — auth + entity list + book list. The form
// in import-form.tsx wraps the importNsAction Server Action.

import { prisma } from "@/lib/db";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { EmptyState } from "@/components/ui/empty-state";
import ImportForm from "./import-form";

export default async function ImportNetSuitePage() {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return (
      <EmptyState
        title="No active tenant"
        description="Sign in and select a tenant before importing."
      />
    );
  }

  const [entities, books] = await Promise.all([
    prisma.legalEntity.findMany({
      where: { tenantId: tenant.id },
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
        <h2 className="text-xl font-semibold text-ink-900">
          Import from NetSuite
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-500">
          Drop in a NetSuite SuiteAnalytics JSON export. Single-sub mode
          collapses everything into one ledger-core entity. Multi-sub mode
          (OneWorld) creates one entity per NS Subsidiary and routes each
          transaction to its origin sub. Either way, the importer is
          idempotent — re-running is safe.
        </p>
      </div>
      <ImportForm entities={entities} books={books} />
    </div>
  );
}
