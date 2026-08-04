// POST /api/billing/checkout
//
// Starts a Stripe Checkout subscription session for the current
// workspace and returns the URL for the browser to follow.
//
//   1. OWNER-only (canManageBilling). requirePermitted writes the
//      ACCESS_DENIED audit row on refusal.
//   2. Zod-validate the body — the only input is a plan key, and it
//      must resolve to a plan in our own catalog. The client never
//      supplies a price id or a tenant id.
//   3. Resolve (or create) the workspace's Stripe Customer.
//   4. Create the Checkout Session, return its URL.
//
// This endpoint does NOT grant entitlement. Payment success arrives
// later, unauthenticated, at /api/billing/webhook, and only a
// signature-verified event writes the subscription columns. A user who
// completes checkout and closes the tab still gets their subscription;
// a user who hits this endpoint and never pays gets nothing.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { NoTenantSelectedError } from "@/lib/auth/tenant";
import { requirePermitted } from "@/lib/auth/authorize";
import { canManageBilling, PermissionDeniedError } from "@/lib/auth/policy";
import { findPlan } from "@/lib/billing/plans";
import {
  createCustomer,
  createCheckoutSession,
} from "@/lib/billing/stripe-client";
import { auditPrivilegedAction } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CheckoutBody = z.object({
  plan: z.string().min(1).max(64),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  let ctx;
  try {
    ctx = await requirePermitted("billing.manage", canManageBilling);
  } catch (e) {
    return mapErrorResponse(e);
  }
  const { user, tenant } = ctx;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const parsed = CheckoutBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Body must be { plan: string }" },
      { status: 400 }
    );
  }

  const plan = findPlan(parsed.data.plan);
  if (!plan) {
    // Echo nothing back from the request — an unknown key is a client
    // bug, and the catalog is not a thing to probe.
    return NextResponse.json(
      { ok: false, error: "Unknown plan" },
      { status: 400 }
    );
  }
  if (!plan.priceId) {
    return NextResponse.json(
      {
        ok: false,
        error: `Plan ${plan.key} has no Stripe Price configured (set STRIPE_PRICE_${plan.key.toUpperCase()}).`,
      },
      { status: 503 }
    );
  }

  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "APP_BASE_URL env var is not set; checkout success/cancel URLs require it.",
      },
      { status: 503 }
    );
  }

  try {
    // First-time setup: mint the Stripe Customer if this workspace has
    // none. We do NOT dedupe by email — one person can own several
    // workspaces, and each gets its own customer so subscriptions never
    // cross-entitle. metadata.tenantId is what the webhook reads back.
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
      actor: { id: user.id, email: user.email },
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
