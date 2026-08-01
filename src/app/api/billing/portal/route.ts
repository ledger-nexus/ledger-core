// POST /api/billing/portal
//
// Opens a Stripe billing-portal session so the workspace OWNER can
// update the card, switch plans, cancel, or pull invoices. Same posture
// as /checkout: OWNER-only, audited, and the customer id comes from the
// tenant row rather than the request — a client cannot ask for someone
// else's portal.
//
// No body: there is nothing to send. The only input is who you are.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { NoTenantSelectedError } from "@/lib/auth/tenant";
import { requirePermitted } from "@/lib/auth/authorize";
import { canManageBilling, PermissionDeniedError } from "@/lib/auth/policy";
import { createPortalSession } from "@/lib/billing/stripe-client";
import { auditPrivilegedAction } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest): Promise<NextResponse> {
  let ctx;
  try {
    ctx = await requirePermitted("billing.manage", canManageBilling);
  } catch (e) {
    return mapErrorResponse(e);
  }
  const { user, tenant } = ctx;

  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { ok: false, error: "APP_BASE_URL env var is not set." },
      { status: 503 }
    );
  }

  const t = await prisma.tenant.findUnique({
    where: { id: tenant.id },
    select: { stripeCustomerId: true },
  });
  if (!t?.stripeCustomerId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "No Stripe customer for this workspace yet — start a checkout first.",
      },
      { status: 400 }
    );
  }

  try {
    const session = await createPortalSession({
      customerId: t.stripeCustomerId,
      returnUrl: `${baseUrl}/admin/billing`,
    });

    await auditPrivilegedAction({
      actor: { id: user.id, email: user.email },
      tenantId: tenant.id,
      action: "billing.open_portal",
      resource: "Tenant",
      resourceId: tenant.id,
      metadata: { sessionId: session.id },
    });

    return NextResponse.json({ ok: true, url: session.url });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
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
