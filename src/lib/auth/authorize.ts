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

/**
 * Resolve the caller, auditing any refusal to resolve one.
 *
 * `requireActor` is `requirePermitted` without the permission check —
 * for actions every member of the tenant may perform, where there is no
 * role floor to name. Reaching for it is a positive statement ("this is
 * open to any member"), which is why it takes an `attemptedAction`: the
 * audit row still has to say what was being attempted.
 *
 * Not a way to skip authorization. An action with a floor uses
 * `requirePermitted`; an action whose rule is richer than a role (the
 * ownership transfer's only-OWNER-initiates, only-TARGET-accepts) still
 * enforces it in its own domain layer.
 */
export async function requireActor(
  attemptedAction: string
): Promise<AuthzContext> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    return { user, tenant };
  } catch (e) {
    await auditUnresolvedActor(attemptedAction, e);
    throw e;
  }
}

/** Audit a caller we could not resolve, then let the error through. */
async function auditUnresolvedActor(
  attemptedAction: string,
  e: unknown
): Promise<void> {
  const reason = refusalReason(e);
  if (!reason) return;
  // Best-effort actor: absent when nobody is signed in, present for the
  // tenant cases (the session resolved, the tenant did not), so the row
  // names who when it can.
  const actor = await getCurrentUser().catch(() => null);
  await auditAccessDenied({
    attemptedAction,
    actor: actor ? { id: actor.id, email: actor.email } : null,
    reason,
    resource: "Permission",
    resourceId: attemptedAction,
  });
}

export async function requirePermitted(
  permission: string,
  check: (role: TenantRole | undefined | null) => boolean
): Promise<AuthzContext> {
  const { user, tenant } = await requireActor(permission);

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
