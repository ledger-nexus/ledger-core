// Authorization glue — resolves the current session and enforces a
// named permission from the policy catalog (./policy.ts).
//
// Two entry points:
//
//   requirePermitted(permission, check)
//     For Server Actions and route handlers. Resolves the current user
//     AND current tenant, evaluates the permission against the caller's
//     TenantMembership.role, writes an ACCESS_DENIED audit row on ANY
//     refusal, and rethrows. Returns { user, tenant } so the action has
//     its audit actor and tenant scope in one call.
//
//     "ANY refusal" is load-bearing and used to be false. Only the ROLE
//     check audited; a caller who could not be resolved to an actor at
//     all — not signed in, no membership, no tenant selected — was
//     refused silently, and whether that attempt reached the audit log
//     depended on which of four hand-copied catch blocks the action
//     happened to inherit. Ten action files wrote the row; eighteen did
//     not, including approve-journal-entry, owner-transfer and the DSR
//     erasure path. Auditing at the throw site rather than the catch
//     site means a new action cannot forget it.
//
//     All three unresolved-actor cases are audited, each with its own
//     `reason`, so "no tenant selected" (a routing state for a
//     multi-tenant user) stays filterable apart from "not authenticated"
//     without being dropped. logAuditEvent swallows its own failures, so
//     a logging outage can never mask the underlying auth error.
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
import {
  getCurrentUser,
  requireCurrentUser,
  NotAuthenticatedError,
  type CurrentUser,
} from "./current-user";
import {
  getCurrentTenant,
  requireCurrentTenant,
  NoTenantMembershipError,
  NoTenantSelectedError,
  type CurrentTenant,
} from "./tenant";
import { auditAccessDenied } from "@/lib/audit/log";
import { PermissionDeniedError } from "./policy";

export interface AuthzContext {
  user: CurrentUser;
  tenant: CurrentTenant;
}

/** Why the caller could not be resolved to an actor, or null when the
 *  failure is not an authorization refusal and should propagate as-is. */
function refusalReason(e: unknown): string | null {
  if (e instanceof NotAuthenticatedError) return "Not authenticated";
  if (e instanceof NoTenantMembershipError) return "No tenant membership";
  if (e instanceof NoTenantSelectedError) return "No tenant selected";
  return null;
}

export async function requirePermitted(
  permission: string,
  check: (role: TenantRole | undefined | null) => boolean
): Promise<AuthzContext> {
  let user: CurrentUser;
  let tenant: CurrentTenant;
  try {
    user = await requireCurrentUser();
    tenant = await requireCurrentTenant();
  } catch (e) {
    const reason = refusalReason(e);
    if (reason) {
      // Best-effort actor: absent when nobody is signed in, present for
      // the tenant cases (the session resolved, the tenant did not), so
      // the row names who when it can.
      const actor = await getCurrentUser().catch(() => null);
      await auditAccessDenied({
        attemptedAction: permission,
        actor: actor ? { id: actor.id, email: actor.email } : null,
        reason,
        resource: "Permission",
        resourceId: permission,
      });
    }
    throw e;
  }

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
