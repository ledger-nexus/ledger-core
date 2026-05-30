// New account page. Server Component fetches the candidate-parents
// list; the form is the adjacent client component.

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser, isAdmin } from "@/lib/auth/current-user";
import { EmptyState } from "@/components/ui/empty-state";
import NewAccountForm from "./new-account-form";

export default async function NewAccountPage() {
  const user = await getCurrentUser();
  // Tenant-verified scope replaces getScope() + manual getCurrentTenant().
  const scope = await getCurrentScope();

  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before creating an account."
      />
    );
  }
  if (!isAdmin(user)) {
    return (
      <EmptyState
        title="Admin required"
        description="Creating accounts is an admin action."
      />
    );
  }

  // Candidate parents = every active account in the same scope as the
  // potential new account. The form can filter further by type after
  // the user picks a type.
  const candidates = await prisma.account.findMany({
    where: {
      tenantId: scope.tenantId,
      active: true,
      OR: [{ entityId: null }, { entityId: scope.entityId }],
    },
    orderBy: { code: "asc" },
    select: {
      code: true,
      name: true,
      type: true,
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">New account</h2>
        <p className="text-sm text-ink-500 max-w-prose">
          Adds a row to the chart of accounts. Posts a PRIVILEGED_ACTION
          audit row. Code + entity scope are immutable after creation
          (load-bearing for posting + report grouping); everything else
          can be edited later.
        </p>
      </div>
      <NewAccountForm candidates={candidates} defaultEntityCode={scope.entityCode} />
    </div>
  );
}
