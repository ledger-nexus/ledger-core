// Period-end FX revaluation page.
//
// Read the current scope, render a preview form (entity / book /
// as-of date), and offer Preview + Post actions. The user typically
// previews first, eyeballs the per-account adjustments + the net
// unrealized gain/loss, and then commits.
//
// Posting is ADMIN+ via canClosePeriods (FX revaluation is conceptually
// a month-end closing entry — same role floor as period close).

import * as React from "react";
import {
  getCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { canClosePeriods } from "@/lib/auth/policy";
import { getCurrentScope } from "@/lib/scope";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FxRevaluationForm } from "./fx-form";

export default async function FxRevaluationPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <Card>
        <CardContent className="px-6 py-10 text-center">
          <h2 className="text-base font-semibold text-ink-900">
            FX revaluation
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {new NotAuthenticatedError().message}
          </p>
        </CardContent>
      </Card>
    );
  }
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return (
      <Card>
        <CardContent className="px-6 py-10 text-center">
          <h2 className="text-base font-semibold text-ink-900">
            FX revaluation
          </h2>
          <p className="mt-1 text-sm text-ink-500">Pick a workspace first.</p>
        </CardContent>
      </Card>
    );
  }
  if (!canClosePeriods(tenant.role)) {
    return (
      <Card>
        <CardContent className="px-6 py-10 text-center">
          <h2 className="text-base font-semibold text-ink-900">
            FX revaluation
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            FX revaluation requires ADMIN or OWNER role. (Same role
            floor as period close — this is a month-end closing entry.)
          </p>
        </CardContent>
      </Card>
    );
  }

  // Tenant-verified scope. The form already null-handles via the
  // `?? ""` / `?? "US_GAAP"` fallbacks below, so we don't gate-block.
  const scope = await getCurrentScope();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">
          Period-end FX revaluation
        </h2>
        <p className="text-xs text-ink-500">
          Adjust foreign-currency balance-sheet account carrying values
          to the period-end <span className="font-mono">CLOSE</span>{" "}
          rate. Per-account adjustments roll up into a single JE with
          an unrealized FX gain or loss line. Run after every line
          posts but before the period closes.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Preview + post</CardTitle>
          <span className="text-xs text-ink-500">
            Preview is non-destructive. Posting commits a single JE
            stamped with{" "}
            <code className="font-mono">sourceRecordType=FxRevaluation</code>{" "}
            and the as-of date in the lineage record-id, so re-runs
            on the same date won&rsquo;t create duplicates (subsequent
            runs would produce a zero delta anyway).
          </span>
        </CardHeader>
        <CardContent>
          <FxRevaluationForm
            initialEntity={scope?.entityCode ?? ""}
            initialBook={scope?.bookCode ?? "US_GAAP"}
            initialAsOfDate={today}
          />
        </CardContent>
      </Card>
    </div>
  );
}
