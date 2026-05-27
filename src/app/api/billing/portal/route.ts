// POST /api/billing/portal
//
// Creates a Stripe billing-portal session so the workspace OWNER can
// update card details, cancel, switch plans, or download invoices.
// Same auth posture as /checkout — OWNER-only.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { requireCurrentTenant, NoTenantSelectedError } from "@/lib/auth/tenant";
import {
  canManageBilling,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";
import { createPortalSession } from "@/lib/billing/stripe-client";
import { auditPrivilegedAction } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let user;
  let tenant;
  try {
    user = await requireCurrentUser();
    tenant = await requireCurrentTenant();
    requirePermission("manage_billing", tenant.role, canManageBilling);
  } catch (e) {
    return mapErrorResponse(e);
  }

  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { ok: false, error: "APP_BASE_URL env var is not set." },
      { status: 500 }
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
        error: "No Stripe customer for this workspace yet — start a checkout first.",
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
      actor: user,
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
