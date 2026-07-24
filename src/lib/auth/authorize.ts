// Authorization glue — resolves the current session and enforces a
// named permission from the policy catalog (./policy.ts).
//
// Two entry points:
//
//   requirePermitted(permission, check)
//     For Server Actions and route handlers. Resolves the current user
//     AND current tenant, evaluates the permission against the caller's
//     TenantMembership.role, writes an ACCESS_DENIED audit row on
//     refusal, and throws PermissionDeniedError. Returns { user, tenant }
//     so the action has its audit actor and tenant scope in one call.
//
//   getViewerRole()
//     For Server Components that branch UI on role (hide admin nav,
//     swap an edit form for a read-only card). Never throws, never
//     writes audit rows — rendering a page with fewer buttons is not
//     an access-denial event.
//
// Denials are audited with the PERMISSION name as the resource id, so
// the audit log answers "who keeps poking at period.close?" without
// leaking anything about the underlying rows.

import type { TenantRole } from "@prisma/client";
import { requireCurrentUser, type CurrentUser } from "./current-user";
import {
  getCurrentTenant,
  requireCurrentTenant,
  type CurrentTenant,
} from "./tenant";
import { auditAccessDenied } from "@/lib/audit/log";
import { PermissionDeniedError } from "./policy";

export interface AuthzContext {
  user: CurrentUser;
  tenant: CurrentTenant;
}

export async function requirePermitted(
  permission: string,
  check: (role: TenantRole | undefined | null) => boolean
): Promise<AuthzContext> {
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  if (!check(tenant.role)) {
    await auditAccessDenied({
      attemptedAction: permission,
      actor: { id: user.id, email: user.email },
      reason: `role ${tenant.role} is below the required floor`,
      resource: "Permission",
      resourceId: permission,
    });
    throw new PermissionDeniedError(permission, tenant.role);
  }

  return { user, tenant };
}

/**
 * Role of the current user in the current tenant, or null when signed
 * out / no tenant resolved. Pages feed this to the `can*` helpers.
 */
export async function getViewerRole(): Promise<TenantRole | null> {
  const tenant = await getCurrentTenant();
  return tenant?.role ?? null;
}
