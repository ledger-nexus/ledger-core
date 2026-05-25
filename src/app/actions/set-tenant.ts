"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { TENANT_COOKIE_NAME } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";

// Server Action invoked by the TenantSwitcher form. Validates the
// requested tenant slug against the current user's memberships before
// writing the cookie — a forged cookie can't grant access to a tenant
// the user isn't a member of (the membership check happens in
// getCurrentTenant on every read, but we double-check at write time
// so the cookie never holds a tenant the user can't access).
export async function setTenantAction(formData: FormData): Promise<void> {
  const user = await requireCurrentUser();
  const slug = String(formData.get("tenantSlug") ?? "");

  if (!slug) {
    throw new Error("tenantSlug is required");
  }

  // Look up the tenant + membership in a single query.
  const membership = await prisma.tenantMembership.findFirst({
    where: {
      userId: user.id,
      tenant: { slug, deletedAt: null },
    },
    include: { tenant: { select: { id: true, slug: true } } },
  });

  if (!membership) {
    throw new Error(
      `Cannot switch to tenant '${slug}' — you are not a member`
    );
  }

  cookies().set(TENANT_COOKIE_NAME, membership.tenant.slug, {
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    sameSite: "lax",
    httpOnly: false, // readable by client-side for tenant-switcher UI
  });

  // Best-effort audit log — see lib/audit/log.ts contract: never throws.
  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "switch-tenant",
    resource: "Tenant",
    resourceId: membership.tenant.id,
    metadata: { tenantSlug: membership.tenant.slug },
  });

  revalidatePath("/", "layout");
}

// Helper input for createMyFirstTenantAction.
export interface CreateTenantInput {
  slug: string;   // url-safe; validated
  name: string;   // human-readable; validated
}

// Slug validation: lowercase alphanumeric + hyphens. No leading/trailing
// hyphens; no double hyphens; 3-40 chars. Matches the convention auditors
// like (no surprises in URL parameters).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

export interface CreateMyFirstTenantState {
  ok: boolean;
  tenantSlug?: string;
  message?: string;
}

// Server Action used by the onboarding page. Creates a Tenant with the
// current user as OWNER and atomically writes the membership row.
// Idempotent in the sense that re-running with the same (userId, slug)
// returns the existing tenant rather than failing.
export async function createMyFirstTenantAction(
  input: CreateTenantInput
): Promise<CreateMyFirstTenantState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return { ok: false, message: "You must be signed in to create a tenant" };
  }

  const slug = input.slug?.trim().toLowerCase() ?? "";
  const name = input.name?.trim() ?? "";

  if (slug.length < 3 || slug.length > 40 || !SLUG_RE.test(slug)) {
    return {
      ok: false,
      message:
        "Slug must be 3–40 chars, lowercase letters/numbers/hyphens, no leading/trailing or double hyphens",
    };
  }
  if (name.length < 1 || name.length > 100) {
    return { ok: false, message: "Name must be 1–100 chars" };
  }

  // Tenant slug must be globally unique. We check first for a friendlier
  // error than the DB constraint violation, but the DB still enforces.
  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    return { ok: false, message: `A tenant with slug '${slug}' already exists` };
  }

  // Atomic create: tenant + owner membership in one transaction.
  const created = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        slug,
        name,
        ownerUserId: user!.id,
      },
    });
    await tx.tenantMembership.create({
      data: {
        tenantId: tenant.id,
        userId: user!.id,
        role: "OWNER",
      },
    });
    return tenant;
  });

  // Set the cookie so the new tenant is auto-selected on the next request.
  cookies().set(TENANT_COOKIE_NAME, created.slug, {
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
    httpOnly: false,
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "create-tenant",
    resource: "Tenant",
    resourceId: created.id,
    metadata: { tenantSlug: created.slug, tenantName: created.name },
  });

  revalidatePath("/", "layout");

  return { ok: true, tenantSlug: created.slug };
}
