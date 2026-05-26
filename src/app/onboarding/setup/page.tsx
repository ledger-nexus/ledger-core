// Onboarding step 2: set up the first entity in the workspace.
//
// Reached after the user creates their tenant in step 1. Also entry-point
// for users who created a tenant but bailed before adding an entity
// (the layout / dashboard CTA can deep-link here).
//
// Guards:
//   - Signed-in user
//   - Has at least one tenant membership (created in step 1)
//   - Tenant has zero LegalEntity rows (otherwise → /)

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  getCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { SetupForm } from "./form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function OnboardingSetupPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Card>
          <CardHeader>
            <CardTitle>Not signed in</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-ink-600">
              {new NotAuthenticatedError().message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    // No active tenant — they haven't run step 1 yet.
    redirect("/onboarding");
  }

  // If this tenant already has entities, the setup is done. Send them
  // to the dashboard. This also handles the "user clicked back / hit
  // refresh after completion" case.
  const entityCount = await prisma.legalEntity.count({
    where: { tenantId: tenant.id },
  });
  if (entityCount > 0) {
    redirect("/");
  }

  // Default suggested name: the tenant's display name. Default entity
  // code: tenant slug uppercased with hyphens (acme-co → ACME-CO).
  const suggestedName = tenant.name;
  const suggestedCode = tenant.slug.toUpperCase().replace(/-+/g, "-");

  return (
    <div className="mx-auto max-w-xl p-8">
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wider text-ink-500">
          Workspace: {tenant.name}
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-ink-900">
          Set up your first entity
        </h1>
        <p className="mt-1 text-sm text-ink-600">
          A workspace owns one or more legal entities (companies / subsidiaries / clients).
          You can add more entities later. Right now we just need one to get
          the books, calendar, and chart of accounts in place.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Entity setup</CardTitle>
        </CardHeader>
        <CardContent>
          <SetupForm
            suggestedName={suggestedName}
            suggestedCode={suggestedCode}
          />
        </CardContent>
      </Card>
    </div>
  );
}
