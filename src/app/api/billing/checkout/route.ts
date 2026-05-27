// POST /api/billing/checkout
//
// Server-side initiation of a Stripe Checkout subscription session.
// Flow:
//
//   1. Caller (the /admin/billing page form) POSTs { plan: "starter" }
//   2. We require ADMIN+ in the current tenant (only admins can change
//      the workspace plan). Audit-logged via auditPrivilegedAction.
//   3. Resolve the tenant's Stripe Customer (create if first-time).
//   4. Create a Checkout Session targeting the requested plan's
//      Price id, with success/cancel URLs back to /admin/billing.
//   5. Return the session URL; the page redirects the browser to it.
//
// The webhook (POST /api/billing/webhook) handles the post-payment
// side — flipping subscriptionStatus to "active" + filling in
// subscriptionId. This endpoint is just the entry point.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { requireCurrentTenant, NoTenantSelectedError } from "@/lib/auth/tenant";
import {
  canManageBilling,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";
import { findPlan } from "@/lib/billing/plans";
import {
  createCustomer,
  createCheckoutSession,
} from "@/lib/billing/stripe-client";
import { auditPrivilegedAction } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  plan?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let user;
  let tenant;
  try {
    user = await requireCurrentUser();
    tenant = await requireCurrentTenant();
    // Only the OWNER can change billing. canManageBilling = role >= OWNER.
    requirePermission("manage_billing", tenant.role, canManageBilling);
  } catch (e) {
    return mapErrorResponse(e);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const plan = findPlan(body.plan);
  if (!plan) {
    return NextResponse.json(
      { ok: false, error: `Unknown plan: ${body.plan}` },
      { status: 400 }
    );
  }
  if (!plan.priceId) {
    return NextResponse.json(
      {
        ok: false,
        error: `Plan ${plan.key} has no Stripe Price configured (set STRIPE_PRICE_${plan.key.toUpperCase()})`,
      },
      { status: 500 }
    );
  }

  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: "APP_BASE_URL env var is not set; checkout success/cancel URLs require it.",
      },
      { status: 500 }
    );
  }

  try {
    // First-time setup: create the Stripe Customer if we don't have one
    // for this tenant. Stripe enforces email uniqueness per customer,
    // but tenants can share an owner email across workspaces, so we
    // don't dedupe by email here — the tenantId metadata distinguishes.
    let stripeCustomerId = (
      await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { stripeCustomerId: true },
      })
    )?.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await createCustomer({
        email: user.email,
        name: tenant.name,
        tenantId: tenant.id,
      });
      stripeCustomerId = customer.id;
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { stripeCustomerId },
      });
    }

    const session = await createCheckoutSession({
      customerId: stripeCustomerId,
      priceId: plan.priceId,
      successUrl: `${baseUrl}/admin/billing?status=success`,
      cancelUrl: `${baseUrl}/admin/billing?status=cancel`,
      tenantId: tenant.id,
    });

    if (!session.url) {
      return NextResponse.json(
        { ok: false, error: "Stripe returned a session without a URL" },
        { status: 502 }
      );
    }

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "billing.start_checkout",
      resource: "Tenant",
      resourceId: tenant.id,
      metadata: { plan: plan.key, sessionId: session.id },
    });

    return NextResponse.json({ ok: true, url: session.url });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Unknown checkout error",
      },
      { status: 500 }
    );
  }
}

function mapErrorResponse(e: unknown): NextResponse {
  if (e instanceof NotAuthenticatedError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 401 });
  }
  if (e instanceof NoTenantSelectedError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
  if (e instanceof PermissionDeniedError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 403 });
  }
  return NextResponse.json(
    { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
    { status: 500 }
  );
}
