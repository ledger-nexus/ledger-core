// Tenant context — which Tenant the current request is acting against.
//
// A user can belong to N tenants via TenantMembership. The "current"
// tenant for a request is resolved in this order:
//
//   1. The `lc-tenant` cookie's tenantSlug, IF the current user has
//      a non-revoked membership in that tenant.
//   2. If the user has exactly ONE membership, that tenant.
//   3. null (the user must pick via the tenant switcher).
//
// Why a slug, not an ID, in the cookie: slugs are URL-safe, stable,
// human-readable, and re-encodable across environments. UUIDs in
// cookies leak the tenant's internal ID; slugs don't.
//
// Phase 2 of docs/multi-tenancy.md. Phase 4 will plumb the returned
// tenantId through every prisma query.

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getCurrentUser, NotAuthenticatedError } from "./current-user";
import type { TenantRole } from "@prisma/client";

export interface CurrentTenant {
  id: string;
  slug: string;
  name: string;
  role: TenantRole;
}

const COOKIE_NAME = "lc-tenant";

/**
 * Read the cookie, verify the current user has membership in that
 * tenant, and return the tenant + role. Returns null when:
 *   - no current user
 *   - cookie is unset and user has 0 or >1 memberships
 *   - cookie points at a tenant the user is not a member of
 *
 * The single-membership case auto-resolves without a cookie set, so
 * solo users never see a tenant switcher.
 */
export async function getCurrentTenant(): Promise<CurrentTenant | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: user.id },
    include: { tenant: { select: { id: true, slug: true, name: true, deletedAt: true } } },
  });

  const active = memberships.filter((m) => m.tenant.deletedAt == null);
  if (active.length === 0) return null;

  const cookieSlug = cookies().get(COOKIE_NAME)?.value;
  if (cookieSlug) {
    const match = active.find((m) => m.tenant.slug === cookieSlug);
    if (match) {
      return {
        id: match.tenant.id,
        slug: match.tenant.slug,
        name: match.tenant.name,
        role: match.role,
      };
    }
    // Cookie names a tenant the user isn't in — fall through to
    // auto-resolve. Don't return null because the user may still
    // have a single valid membership we should pick by default.
  }

  if (active.length === 1) {
    const only = active[0];
    return {
      id: only.tenant.id,
      slug: only.tenant.slug,
      name: only.tenant.name,
      role: only.role,
    };
  }

  // Multi-tenant user without a valid cookie selection — caller MUST
  // route to the tenant picker. Returning null forces requireCurrentTenant
  // to throw a NoTenantSelectedError that the layout / route handles.
  return null;
}

// NotAuthenticatedError is ONE class, defined in ./current-user and
// re-exported here.
//
// This file used to declare a second class of the same name and its own
// message. Nothing imported it — but `requireCurrentTenant` THREW it,
// and every `catch (e) { if (e instanceof NotAuthenticatedError) ... }`
// in the action layer imports the other one. Two classes named the same
// thing make that check silently false: the handled branch is skipped,
// the caller falls through to its generic catch, and the ACCESS_DENIED
// row never gets written.
//
// Today every call site happens to reach `requireCurrentUser` first, so
// the current-user class always throws first and the checks match. That
// is luck, not design — the first site to need only a tenant would have
// found the trap. One class removes the question.
export { NotAuthenticatedError };

export class NoTenantSelectedError extends Error {
  constructor() {
    super(
      "No tenant selected — you belong to multiple tenants. Pick one via the tenant switcher."
    );
    this.name = "NoTenantSelectedError";
  }
}

export class NoTenantMembershipError extends Error {
  constructor() {
    super(
      "No tenant membership — your account is not a member of any tenant. Create one to continue."
    );
    this.name = "NoTenantMembershipError";
  }
}

/**
 * Require a current tenant. Throws when:
 *   - no current user (NotAuthenticatedError)
 *   - user has 0 memberships (NoTenantMembershipError)
 *   - user has >1 memberships and no valid cookie selection (NoTenantSelectedError)
 *
 * Server Actions and Server Components that touch tenant-scoped data
 * MUST call this — never trust an unscoped query.
 */
export async function requireCurrentTenant(): Promise<CurrentTenant> {
  const user = await getCurrentUser();
  if (!user) throw new NotAuthenticatedError();

  const tenant = await getCurrentTenant();
  if (tenant) return tenant;

  // Disambiguate which sub-error to throw for the caller to handle.
  const count = await prisma.tenantMembership.count({
    where: { userId: user.id, tenant: { deletedAt: null } },
  });
  if (count === 0) throw new NoTenantMembershipError();
  throw new NoTenantSelectedError();
}

/**
 * List the active memberships for the current user. Used by the tenant
 * switcher UI. Returns [] when not authenticated (callers branch on
 * empty-list rather than null/undefined).
 */
export async function listMyTenants(): Promise<CurrentTenant[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: user.id, tenant: { deletedAt: null } },
    include: { tenant: { select: { id: true, slug: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({
    id: m.tenant.id,
    slug: m.tenant.slug,
    name: m.tenant.name,
    role: m.role,
  }));
}

/**
 * Admin-tier check within the current tenant. ADMIN and OWNER are
 * both admin-level; MEMBER is not. Mirrors the role rubric in
 * docs/multi-tenancy.md.
 *
 * NOTE: this is distinct from the global isAdmin() in current-user.ts
 * which today checks an email allowlist. Once Clerk + per-tenant
 * RBAC lands, the global isAdmin retires and callers move to this.
 */
export function isTenantAdmin(tenant: CurrentTenant | null): boolean {
  if (!tenant) return false;
  return tenant.role === "OWNER" || tenant.role === "ADMIN";
}

export class NotTenantAdminError extends Error {
  constructor() {
    super("This action requires tenant ADMIN or OWNER permission");
    this.name = "NotTenantAdminError";
  }
}

export async function requireTenantAdmin(): Promise<CurrentTenant> {
  const t = await requireCurrentTenant();
  if (!isTenantAdmin(t)) throw new NotTenantAdminError();
  return t;
}

export const TENANT_COOKIE_NAME = COOKIE_NAME;
