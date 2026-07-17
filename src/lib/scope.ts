// Per-request scope: which (entity, book) the UI is viewing.
//
// Stored in a single cookie `lc-scope`. Defaults to NORTHWIND / US_GAAP
// (matching the seed). Read by Server Components via getScope(); written
// via the setScope Server Action in src/app/actions/set-scope.ts.
//
// SECURITY: getScope() returns the RAW cookie value — it does NOT
// verify that the entityCode belongs to the current tenant. It is now
// MODULE-PRIVATE (not exported) so no application page can read it
// directly: pages MUST use `getCurrentScope()` / `resolveCurrentScope()`
// below, which resolve the cookie against the tenant's entities (and
// fall back to the tenant's first entity when the cookie names one
// outside the tenant). Without that verification, a signed-in user
// could hand-edit the lc-scope cookie to any entity code and have a
// page render that entity's data — a cross-tenant read leak. Keeping
// this reader un-exported makes that class of bug unrepresentable.

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getCurrentTenant } from "@/lib/auth/tenant";

export interface LedgerScope {
  entityCode: string;
  bookCode: string;
}

export const DEFAULT_SCOPE: LedgerScope = {
  entityCode: "NORTHWIND",
  bookCode: "US_GAAP",
};

const COOKIE_NAME = "lc-scope";

function getScope(): LedgerScope {
  const raw = cookies().get(COOKIE_NAME)?.value;
  if (!raw) return DEFAULT_SCOPE;
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerScope>;
    return {
      entityCode: parsed.entityCode ?? DEFAULT_SCOPE.entityCode,
      bookCode: parsed.bookCode ?? DEFAULT_SCOPE.bookCode,
    };
  } catch {
    return DEFAULT_SCOPE;
  }
}

/**
 * Resolve the effective scope from URL overrides, falling back to the
 * cookie. Lets pages and route handlers accept `?entity=X&book=Y` query
 * parameters that override the sidebar-switched scope cookie for a
 * single request. Critical for shareable demo URLs — paste the link,
 * see the right entity's data, no cookie surgery required.
 */
export function resolveScope(
  searchParams: URLSearchParams | Record<string, string | undefined>
): LedgerScope {
  const cookieScope = getScope();
  const get = (k: string): string | undefined =>
    searchParams instanceof URLSearchParams
      ? searchParams.get(k) ?? undefined
      : searchParams[k];
  return {
    entityCode: get("entity") ?? cookieScope.entityCode,
    bookCode: get("book") ?? cookieScope.bookCode,
  };
}

export const SCOPE_COOKIE_NAME = COOKIE_NAME;

// ─── Tenant-verified scope ────────────────────────────────────────────────

/**
 * The authoritative scope for tenant-scoped data reads. The entityCode
 * has been verified to belong to the current tenant; entityId and
 * tenantId are pre-resolved so callers can use them in queries without
 * a second round-trip.
 *
 * Always prefer this to `getScope()` when reading data — bookCode is
 * platform-level (US_GAAP, IFRS, etc.) so it doesn't need verification,
 * but entityCode is tenant-scoped after Phase 4b and MUST be checked.
 */
/**
 * A tenant-VERIFIED scope. `tenantId` and `entityId` have been resolved and
 * confirmed to belong to the current session's tenant (via getCurrentScope
 * / resolveCurrentScope); `entityCode`/`bookCode` are presentation
 * attributes, NOT authorization keys.
 *
 * This is the type tenant-facing data services should require in their
 * signature: accepting an `AuthorizedLedgerScope` is the type-level proof
 * that the caller resolved the scope through the verified path rather than
 * reading a raw cookie. It makes "queried with an unverified scope" an
 * unrepresentable state at the service boundary.
 */
export interface AuthorizedLedgerScope {
  tenantId: string;
  entityId: string;
  entityCode: string;
  bookCode: string;
}

/**
 * @deprecated Prefer `AuthorizedLedgerScope` — same shape, clearer intent.
 * Retained as an alias so existing imports keep compiling.
 */
export type CurrentScope = AuthorizedLedgerScope;

/**
 * Resolve the request's scope against the current tenant's entities.
 *
 *   - No current tenant      → null (caller should redirect / empty state)
 *   - Cookie names an entity NOT in this tenant → fall back to the
 *     tenant's first entity (silently — the user sees THEIR data, not
 *     an error, and they can switch scope via the picker)
 *   - Tenant has zero entities → null (caller should send to onboarding)
 *
 * The fallback is deliberate: a stale cookie from a different tenant or
 * the default NORTHWIND seed shouldn't error-out users on the dashboard;
 * it should silently switch to a tenant-owned entity. The cross-tenant
 * leak the cookie could theoretically cause is closed because the
 * resolved entityId is ALWAYS from this tenant.
 */
export async function getCurrentScope(): Promise<CurrentScope | null> {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;
  const raw = getScope();

  // Try the cookie's entity first. Note: we filter by BOTH tenantId
  // and code, so even if entityCode collides across tenants (Phase 4b
  // allows that), we only match the one in THIS tenant.
  let entity = await prisma.legalEntity.findFirst({
    where: { tenantId: tenant.id, code: raw.entityCode },
    select: { id: true, code: true },
  });
  if (!entity) {
    // Cookie doesn't match this tenant — fall back to the tenant's
    // first entity (code-asc, mirrors the chart layout convention).
    entity = await prisma.legalEntity.findFirst({
      where: { tenantId: tenant.id },
      orderBy: { code: "asc" },
      select: { id: true, code: true },
    });
    if (!entity) return null; // tenant has no entities yet
  }
  return {
    tenantId: tenant.id,
    entityId: entity.id,
    entityCode: entity.code,
    bookCode: raw.bookCode,
  };
}

/**
 * Same as getCurrentScope but throws when no scope can be resolved.
 * Use this in Server Actions / API routes where you want the request
 * to fail closed rather than render an empty UI.
 */
export class NoScopeError extends Error {
  constructor() {
    super(
      "No scope could be resolved — no active tenant or tenant has no entities."
    );
    this.name = "NoScopeError";
  }
}

export async function requireCurrentScope(): Promise<CurrentScope> {
  const s = await getCurrentScope();
  if (!s) throw new NoScopeError();
  return s;
}

/**
 * Tenant-verified variant of `resolveScope` for pages/routes that
 * accept URL `?entity=&book=` overrides (shareable links). The override
 * is honored ONLY if the named entity belongs to the current tenant;
 * otherwise falls back the same way getCurrentScope does. Without this,
 * anyone with a /reports/month-end?entity=X URL can read X's data
 * regardless of which tenant they're signed in to.
 */
export async function resolveCurrentScope(
  searchParams: URLSearchParams | Record<string, string | undefined>
): Promise<CurrentScope | null> {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;
  const raw = resolveScope(searchParams);
  let entity = await prisma.legalEntity.findFirst({
    where: { tenantId: tenant.id, code: raw.entityCode },
    select: { id: true, code: true },
  });
  if (!entity) {
    entity = await prisma.legalEntity.findFirst({
      where: { tenantId: tenant.id },
      orderBy: { code: "asc" },
      select: { id: true, code: true },
    });
    if (!entity) return null;
  }
  return {
    tenantId: tenant.id,
    entityId: entity.id,
    entityCode: entity.code,
    bookCode: raw.bookCode,
  };
}
