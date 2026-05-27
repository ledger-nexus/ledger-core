// Per-tenant role-based access control policy.
//
// One source of truth for "what can a TenantRole do?". The four roles
// form a strict hierarchy:
//
//   OWNER  > ADMIN  > MEMBER  > VIEWER
//
// Each permission below maps to the MINIMUM role required. Server
// Actions and pages call the matching helper instead of hard-coding
// role-string comparisons. When the rubric changes (e.g. a new role
// joins, or a permission moves between roles), this is the only file
// to edit.
//
// Why a TS module and not a database table:
//   - The permission catalog is stable. Changes are code review-able.
//   - No N+1 DB lookups per permission check.
//   - Type safety: each helper takes a TenantRole, not a string.
//   - Companion repos can mirror the same module without DB sync.
//
// Migration note: this module replaces the email-allowlist isAdmin()
// check that current-user.ts inherited from before per-tenant RBAC
// landed. The old isAdmin/requireAdmin are still exported but delegate
// here; new code should call the named permission helpers directly.

import type { TenantRole } from "@prisma/client";

// ─── Role hierarchy ───────────────────────────────────────────────────────

const ROLE_RANK: Record<TenantRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN:  2,
  OWNER:  3,
};

/** True when actual role >= required role on the hierarchy. */
function meets(actual: TenantRole | undefined | null, required: TenantRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ─── Named permissions (the public API) ──────────────────────────────────
//
// Group helpers by the surface they gate so reviewers can scan the
// permission catalog by feature, not alphabetically.

// READ — every role can view, including VIEWER.
export const canViewReports = (role: TenantRole | undefined | null): boolean =>
  meets(role, "VIEWER");

export const canViewAuditLog = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canViewAdminPages = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

// WRITE — MEMBER+ for operational mutations. VIEWER refused.

export const canPostJournalEntries = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canEditAccounts = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canApproveAiSuggestions = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canRunDepreciation = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canApplyArApPayments = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

// ADMIN — period close, user lifecycle, AI budget config, recurring entries.

export const canClosePeriods = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageUsers = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageRecurringEntries = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageReassignmentRules = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageAiBudget = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageMemberships = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

// OWNER — tenant deletion + billing changes only.

export const canDeleteTenant = (role: TenantRole | undefined | null): boolean =>
  meets(role, "OWNER");

export const canManageBilling = (role: TenantRole | undefined | null): boolean =>
  meets(role, "OWNER");

export const canRemoveOwner = (role: TenantRole | undefined | null): boolean =>
  false; // No role can remove the owner. Tenant deletion takes the owner with it.

// ─── Generic require-helper ──────────────────────────────────────────────
//
// Most callers will use the named helpers above (`canPostJournalEntries(role)`)
// and surface a domain-appropriate error. For Server Actions that just
// need a hard refusal, requirePermission gives a one-liner.

export class PermissionDeniedError extends Error {
  constructor(public readonly permission: string, public readonly role: TenantRole | null) {
    super(
      role
        ? `This action requires a higher role than ${role}. (permission: ${permission})`
        : `This action requires being signed in to a tenant. (permission: ${permission})`
    );
    this.name = "PermissionDeniedError";
  }
}

/** Throws PermissionDeniedError if the check returns false. */
export function requirePermission(
  permission: string,
  role: TenantRole | null,
  check: (r: TenantRole | null) => boolean
): void {
  if (!check(role)) throw new PermissionDeniedError(permission, role);
}
