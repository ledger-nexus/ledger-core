// Billing — subscription state and plan caps for this workspace.
//
// Readable by ADMIN+; only the OWNER gets the buttons (canManageBilling).
// Everything shown here is a mirror of Stripe written by
// /api/billing/webhook; this page never calls Stripe itself.
//
// Ships dark: with no STRIPE_PRICE_* env vars every plan renders as
// "not configured" and no Subscribe button appears, so the page is an
// honest read-only view of "you are on the free tier" until someone
// sets up the Stripe side (docs/billing-setup.md).

import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { canViewAdminPages, canManageBilling } from "@/lib/auth/policy";
import { prisma } from "@/lib/db";
import { PLANS, findPlan, type Plan } from "@/lib/billing/plans";
import { getTenantLimits } from "@/lib/billing/limits";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckoutButton, PortalButton } from "./billing-actions";

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const user = await getCurrentUser();
  if (!user) return <Forbidden reason="Sign in first." />;

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return <Forbidden reason="Pick a workspace via the tenant switcher first." />;
  }
  if (!canViewAdminPages(tenant.role)) {
    return <Forbidden reason="Billing is visible to admins and the owner." />;
  }

  const isOwner = canManageBilling(tenant.role);

  const [billing, limits] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: {
        stripeSubscriptionId: true,
        billingPlan: true,
        subscriptionStatus: true,
        currentPeriodEnd: true,
      },
    }),
    getTenantLimits(tenant.id),
  ]);

  const currentPlan = findPlan(billing?.billingPlan);
  const hasSubscription =
    !!billing?.stripeSubscriptionId &&
    billing.subscriptionStatus !== "canceled";
  const enforcing = process.env.BILLING_ENFORCE_LIMITS === "true";

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">
          Billing
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          Subscription and plan caps for{" "}
          <span className="font-medium text-ink-700">{tenant.name}</span>. Only
          the workspace owner can change the plan or payment method.
        </p>
      </div>

      {searchParams.status === "success" && (
        <Card className="border-positive-200 bg-positive-50">
          <CardContent className="pt-6 text-sm text-positive-800">
            Checkout complete. Stripe confirms the subscription in the
            background — this page shows the new plan within a few seconds of
            a refresh.
          </CardContent>
        </Card>
      )}
      {searchParams.status === "cancel" && (
        <Card className="border-warning-200 bg-warning-50">
          <CardContent className="pt-6 text-sm text-warning-800">
            Checkout canceled. Nothing was charged.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          {hasSubscription && isOwner && <PortalButton />}
        </CardHeader>
        <CardContent>
          {hasSubscription && currentPlan ? (
            <div>
              <div className="text-lg font-semibold text-ink-900">
                {currentPlan.label}
              </div>
              <div className="text-sm text-ink-500">
                {currentPlan.displayPrice}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <Badge tone={statusTone(billing?.subscriptionStatus)}>
                  {(billing?.subscriptionStatus ?? "unknown").toUpperCase()}
                </Badge>
                {billing?.currentPeriodEnd && (
                  <span className="text-ink-500">
                    Renews {billing.currentPeriodEnd.toISOString().slice(0, 10)}
                  </span>
                )}
              </div>
              {billing?.subscriptionStatus === "past_due" && (
                <p className="mt-3 text-sm text-negative">
                  Payment failed. The workspace is on free-tier caps until the
                  card is updated.
                </p>
              )}
            </div>
          ) : (
            <div className="text-sm text-ink-700">
              No active subscription — this workspace is on the{" "}
              <span className="font-medium">Free</span> tier.{" "}
              {isOwner
                ? "Pick a plan below to change that."
                : "Ask the workspace owner to subscribe."}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plan caps</CardTitle>
          <span className="text-xs text-ink-500">
            {enforcing
              ? "Enforced — new adds are refused at the cap."
              : "Not enforced yet — over-cap adds are logged, not blocked."}
          </span>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <CapCell
            label="Users"
            current={limits.users.current}
            cap={limits.users.cap}
            atLimit={limits.users.atLimit}
            note="Members plus outstanding invites."
          />
          <CapCell
            label="Legal entities"
            current={limits.entities.current}
            cap={limits.entities.cap}
            atLimit={limits.entities.atLimit}
            note="Separate sets of books in this workspace."
          />
        </CardContent>
      </Card>

      {!hasSubscription && isOwner && (
        <Card>
          <CardHeader>
            <CardTitle>Choose a plan</CardTitle>
            <span className="text-xs text-ink-500">
              Change or cancel any time from the Stripe portal.
            </span>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <PlanCard key={plan.key} plan={plan} />
            ))}
          </CardContent>
        </Card>
      )}

      {!isOwner && (
        <p className="text-xs text-ink-500">
          You are viewing as {tenant.role}. Only the workspace owner can change
          the plan or open the billing portal.
        </p>
      )}
    </div>
  );
}

function statusTone(
  status: string | null | undefined
): "positive" | "info" | "negative" | "neutral" {
  switch (status) {
    case "active":
      return "positive";
    case "trialing":
      return "info";
    case "past_due":
    case "unpaid":
      return "negative";
    default:
      return "neutral";
  }
}

function CapCell({
  label,
  current,
  cap,
  atLimit,
  note,
}: {
  label: string;
  current: number;
  cap: number | null;
  atLimit: boolean;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-ink-200 p-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-500">
          {label}
        </div>
        {atLimit && <Badge tone="negative">At cap</Badge>}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-ink-900">
          {current}
        </span>
        <span className="text-sm tabular-nums text-ink-500">
          / {cap == null ? "unlimited" : cap}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-ink-500">{note}</p>
    </div>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div className="flex flex-col rounded-lg border border-ink-200 p-4">
      <div className="text-base font-semibold text-ink-900">{plan.label}</div>
      <div className="mt-0.5 text-sm font-medium text-ink-700">
        {plan.displayPrice}
      </div>
      <p className="mt-2 flex-1 text-xs text-ink-500">{plan.description}</p>
      <div className="mt-4">
        {plan.priceId ? (
          <CheckoutButton plan={plan.key} />
        ) : (
          <p className="text-[11px] text-ink-500">
            Not available — no Stripe price configured for this tier.
          </p>
        )}
      </div>
    </div>
  );
}

function Forbidden({ reason }: { reason: string }) {
  return (
    <div className="p-6">
      <Card>
        <CardContent className="py-10 text-center">
          <h2 className="text-base font-semibold text-ink-900">Billing</h2>
          <p className="mt-1 text-sm text-ink-500">{reason}</p>
        </CardContent>
      </Card>
    </div>
  );
}
