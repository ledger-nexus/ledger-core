// Admin billing page.
//
// Shows the workspace's current subscription state + lets the OWNER
// start checkout or open the Stripe billing portal. Read-only for
// ADMIN; OWNER-only for the action buttons.
//
// Tenant.stripeCustomerId / stripeSubscriptionId / billingPlan /
// subscriptionStatus / currentPeriodEnd are the source of truth here,
// kept in sync by /api/billing/webhook.

import * as React from "react";
import { getCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { canViewAdminPages, canManageBilling } from "@/lib/auth/policy";
import { prisma } from "@/lib/db";
import { PLANS, findPlan } from "@/lib/billing/plans";
import { getTenantLimits } from "@/lib/billing/limits";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckoutButton, PortalButton } from "./billing-actions";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const user = await getCurrentUser();
  if (!user) {
    return <Forbidden reason={new NotAuthenticatedError().message} />;
  }
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return <Forbidden reason="Pick a workspace first." />;
  }
  if (!canViewAdminPages(tenant.role)) {
    return <Forbidden reason="Billing requires ADMIN or OWNER role." />;
  }

  const isOwner = canManageBilling(tenant.role);

  const [billing, limits] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: {
        stripeCustomerId: true,
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
    !!billing?.stripeSubscriptionId && billing.subscriptionStatus !== "canceled";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Billing</h2>
        <p className="text-xs text-ink-500">
          Subscription state for <span className="font-mono">{tenant.slug}</span>.
          Only the workspace OWNER can change plans or update payment methods.
        </p>
      </div>

      {searchParams.status === "success" && (
        <Card>
          <CardContent className="px-5 py-3 bg-emerald-50">
            <div className="text-sm text-emerald-800">
              Checkout complete. Your subscription is being activated — the
              status below updates within a few seconds.
            </div>
          </CardContent>
        </Card>
      )}
      {searchParams.status === "cancel" && (
        <Card>
          <CardContent className="px-5 py-3 bg-amber-50">
            <div className="text-sm text-amber-800">
              Checkout canceled. No charges were made.
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
        </CardHeader>
        <CardContent className="px-5 py-4">
          {hasSubscription && currentPlan ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-ink-900">
                  {currentPlan.label}
                </div>
                <div className="text-xs text-ink-500">
                  {currentPlan.displayPrice}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                  <Badge
                    tone={
                      billing!.subscriptionStatus === "active"
                        ? "positive"
                        : billing!.subscriptionStatus === "trialing"
                          ? "info"
                          : billing!.subscriptionStatus === "past_due"
                            ? "negative"
                            : "neutral"
                    }
                  >
                    {billing!.subscriptionStatus?.toUpperCase()}
                  </Badge>
                  {billing!.currentPeriodEnd && (
                    <span className="text-ink-500">
                      Renews{" "}
                      {billing!.currentPeriodEnd.toISOString().slice(0, 10)}
                    </span>
                  )}
                </div>
              </div>
              {isOwner && <PortalButton />}
            </div>
          ) : (
            <div className="text-sm text-ink-700">
              No active subscription. {isOwner
                ? "Pick a plan below to get started."
                : "Ask the workspace OWNER to subscribe."}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plan limits</CardTitle>
          <span className="text-xs text-ink-500">
            Resource usage against the limits of your current plan
            (<span className="font-mono">{limits.plan.key}</span>).
            Cells with <Badge tone="negative">AT LIMIT</Badge> refuse new
            adds until you upgrade or remove existing rows.
          </span>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <LimitCell
            label="Users"
            current={limits.users.current}
            cap={limits.users.cap}
            atLimit={limits.users.atLimit}
          />
          <LimitCell
            label="Legal entities"
            current={limits.entities.current}
            cap={limits.entities.cap}
            atLimit={limits.entities.atLimit}
          />
          <div className="rounded-lg border border-ink-200 p-3 bg-white">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Monthly AI spend cap
            </div>
            <div className="mt-1 text-base font-semibold text-ink-900 amount-cell">
              {limits.aiSpendCapUsd != null
                ? `$${limits.aiSpendCapUsd.toFixed(2)}`
                : "Unlimited"}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-500">
              Enforced by the companion repos. Override per-tenant via{" "}
              <code className="font-mono">tenant.monthlyAiSpendCapUsd</code>.
            </div>
          </div>
          <div className="rounded-lg border border-ink-200 p-3 bg-white sm:col-span-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Available companion repos
            </div>
            <div className="mt-1 flex flex-wrap gap-2">
              {(["recon", "revenue-rec", "fa-amort", "integrations"] as const).map(
                (repo) => {
                  const included = limits.availableRepos.includes(repo);
                  return (
                    <Badge
                      key={repo}
                      tone={included ? "positive" : "neutral"}
                    >
                      <span className="font-mono">{repo}</span>
                      {included ? " ✓" : " — upgrade"}
                    </Badge>
                  );
                }
              )}
            </div>
            <div className="mt-1 text-[11px] text-ink-500">
              Companion-repo plan gating is not yet enforced server-side
              (display only). Cross-repo enforcement is a follow-up.
            </div>
          </div>
        </CardContent>
      </Card>

      {!hasSubscription && isOwner && (
        <Card>
          <CardHeader>
            <CardTitle>Choose a plan</CardTitle>
            <span className="text-xs text-ink-500">
              Pick the tier that fits your team. You can upgrade or cancel
              anytime from the Stripe billing portal.
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
        <Card>
          <CardContent className="px-5 py-3">
            <div className="text-xs text-ink-500">
              You&rsquo;re viewing as <span className="font-mono">{tenant.role}</span>.
              Only the workspace OWNER can change the plan or open the billing portal.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function LimitCell({
  label,
  current,
  cap,
  atLimit,
}: {
  label: string;
  current: number;
  cap: number | null;
  atLimit: boolean;
}) {
  // Display the cap as "∞" for unlimited (cap=null) plans.
  const capDisplay = cap == null ? "∞" : cap.toString();
  return (
    <div className="rounded-lg border border-ink-200 p-3 bg-white">
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-base font-semibold tabular-nums text-ink-900">
          {current}
        </span>
        <span className="text-sm tabular-nums text-ink-500">/ {capDisplay}</span>
        {atLimit && (
          <Badge tone="negative" className="ml-auto">
            AT LIMIT
          </Badge>
        )}
      </div>
    </div>
  );
}

function PlanCard({ plan }: { plan: { key: string; label: string; description: string; displayPrice: string; priceId: string | null } }) {
  const configured = !!plan.priceId;
  return (
    <div className="rounded-lg border border-ink-200 p-4 bg-white">
      <div className="text-base font-semibold text-ink-900">{plan.label}</div>
      <div className="mt-0.5 text-sm font-medium text-ink-700">{plan.displayPrice}</div>
      <p className="mt-2 text-xs text-ink-500">{plan.description}</p>
      <div className="mt-3">
        {configured ? (
          <CheckoutButton plan={plan.key} />
        ) : (
          <div className="text-[11px] text-ink-400">
            Stripe Price id not configured —{" "}
            <code className="font-mono">STRIPE_PRICE_{plan.key.toUpperCase()}</code>
          </div>
        )}
      </div>
    </div>
  );
}

function Forbidden({ reason }: { reason: string }) {
  return (
    <Card>
      <CardContent className="px-6 py-10 text-center">
        <h2 className="text-base font-semibold text-ink-900">Billing</h2>
        <p className="mt-1 text-sm text-ink-500">{reason}</p>
      </CardContent>
    </Card>
  );
}
