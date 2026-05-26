// Onboarding page — entry point for users with 0 TenantMemberships.
//
// Flow:
//   1. User signs up via Clerk (or picks a seed user in dev) → User row.
//   2. Layout detects user has no memberships → redirects here.
//   3. User picks a slug + name → createMyFirstTenantAction creates the
//      Tenant + OWNER membership atomically + sets the lc-tenant cookie.
//   4. Redirect to / — the layout's getCurrentTenant() now resolves.
//
// Users who already have a membership are bounced back to / so this
// page can't be used to spin up extra tenants accidentally (multi-
// tenant signup happens via an invite flow not built here).

import { redirect } from "next/navigation";
import {
  getCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { listMyTenants } from "@/lib/auth/tenant";
import { OnboardingForm } from "./form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) {
    // Not signed in. With Clerk active, middleware redirects /onboarding
    // to /sign-in before we get here; with the dev stub, just show a
    // message since there's no sign-in flow to redirect to.
    return (
      <div className="mx-auto max-w-md p-8">
        <Card>
          <CardHeader>
            <CardTitle>Not signed in</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-ink-600">
              Sign in first (use the user switcher in the header, or your
              identity provider in production), then return to this page.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tenants = await listMyTenants();
  if (tenants.length > 0) {
    // Already onboarded. Send them home.
    redirect("/");
  }

  return (
    <div className="mx-auto max-w-md p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-ink-900">Welcome to ledger-core</h1>
        <p className="mt-1 text-sm text-ink-600">
          Create your first workspace to get started. A workspace owns one
          or more legal entities, their books, and journal entries.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Create workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <OnboardingForm />
        </CardContent>
      </Card>
    </div>
  );
}
