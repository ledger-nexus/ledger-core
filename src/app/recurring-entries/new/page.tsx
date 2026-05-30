// New recurring entry template — Server Component fetches dropdowns;
// the form lives in the adjacent client component.

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser, isAdmin } from "@/lib/auth/current-user";
import { EmptyState } from "@/components/ui/empty-state";
import NewRecurringForm from "./new-recurring-form";

export default async function NewRecurringPage() {
  const user = await getCurrentUser();
  // Tenant-verified scope replaces getScope() + manual getCurrentTenant().
  const scope = await getCurrentScope();

  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before creating a template."
      />
    );
  }
  if (!isAdmin(user)) {
    return (
      <EmptyState
        title="Admin required"
        description="Creating recurring entry templates is an admin action."
      />
    );
  }

  const [accounts, books, entities] = await Promise.all([
    prisma.account.findMany({
      where: {
        active: true,
        tenantId: scope.tenantId,
        OR: [{ entityId: null }, { entityId: scope.entityId }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true, type: true },
    }),
    prisma.book.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
    prisma.legalEntity.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">New recurring template</h2>
        <p className="text-sm text-ink-500 max-w-prose">
          Define a balanced JE shape + a cadence. Every cadence step will produce a
          fresh entry via <code className="font-mono">postJournalEntry</code> when
          the runner fires. The first entry is dated the start date; subsequent
          entries step forward by cadence.
        </p>
      </div>
      <NewRecurringForm
        accounts={accounts}
        books={books}
        entities={entities}
        defaultEntityCode={scope.entityCode}
        defaultBookCode={scope.bookCode}
      />
    </div>
  );
}
