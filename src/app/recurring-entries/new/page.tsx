// New recurring entry template — Server Component fetches dropdowns;
// the form lives in the adjacent client component.

import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getCurrentUser, isAdmin } from "@/lib/auth/current-user";
import { EmptyState } from "@/components/ui/empty-state";
import NewRecurringForm from "./new-recurring-form";

export default async function NewRecurringPage() {
  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  const scope = getScope();

  if (!tenant) {
    return (
      <EmptyState
        title="No active tenant"
        description="Sign in and select a tenant before creating a template."
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
        tenantId: tenant.id,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
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
      where: { tenantId: tenant.id },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">New recurring template</h2>
        <p className="text-sm text-ink-500 max-w-prose">
          Define a balanced entry and how often it repeats. Each time it comes
          due, a fresh entry posts automatically. The first is dated the start
          date; each one after steps forward by the cadence.
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
