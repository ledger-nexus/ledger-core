// Per-tenant role-based access control policy.
//
// One source of truth for "what can a TenantRole do?". The three roles
// form a strict hierarchy:
//
//   OWNER > ADMIN > MEMBER
//
// (A read-only VIEWER role below MEMBER is planned for the team-invites
// slice — auditors need view-without-write. Adding it is an additive
// enum migration; every floor below already anticipates it.)
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
// check that current-user.ts carried from before per-tenant RBAC
// landed ("controller@northwind.test" was the entire admin cohort).
// Admin is now a fact about your TenantMembership.role in the CURRENT
// tenant, not about your email. `requireTenantAdmin` in tenant.ts is
// the generic ancestor of these named helpers; call sites should
// prefer the named permission so the catalog stays scannable.

import type { TenantRole } from "@prisma/client";

// ─── Role hierarchy ──────────────────────────────────────────────────────

const ROLE_RANK: Record<TenantRole, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

/** True when actual role >= required role on the hierarchy. */
function meets(actual: TenantRole | undefined | null, required: TenantRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ─── Named permissions (the public API) ──────────────────────────────────
//
// Grouped by the surface they gate so reviewers can scan the permission
// catalog by feature, not alphabetically. Helpers marked "consumer
// arrives with <slice>" have no call site yet — they document the
// agreed rubric so later slices add consumers, not policy decisions.

// READ — every membership can view; drops to VIEWER when that role lands.

export const canViewReports = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canViewAuditLog = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canViewAdminPages = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

// WRITE — MEMBER+ for operational mutations.

export const canPostJournalEntries = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

// Maker-checker (consumer arrives with the JE-approvals slice):
// ADMIN+ approves; MEMBER+ can submit for approval. The "self-approval"
// guard (a user can't approve their own submission) is an actor-identity
// check enforced at the approval action — this gate is the role floor.
export const canApproveJournalEntries = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canSubmitJournalEntries = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

// Chart-of-accounts edits. NOTE: the original #46 rubric proposed
// MEMBER here; today's UI gates COA changes behind admin and this
// migration deliberately preserves every existing floor. Lowering to
// MEMBER is a one-line policy decision once someone wants it.
export const canEditAccounts = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canApproveAiSuggestions = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canRunDepreciation = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canApplyArApPayments = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

// ADMIN — period close, user lifecycle, ERP imports, recurring entries.

export const canClosePeriods = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageUsers = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageRecurringEntries = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageReassignmentRules = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

// ERP imports rewrite the chart of accounts and post journal entries
// wholesale — strictly more power than canEditAccounts + canPost.
export const canRunErpImports = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

// Editing or deleting ANOTHER user's JE note. Authors always manage
// their own notes; that ownership check lives at the action.
export const canModerateNotes = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canManageNotificationChannels = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

// Consumer arrives with the team-invites slice.
export const canManageMemberships = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

// Consumer arrives with the AI-budget slice.
export const canManageAiBudget = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

// OWNER — tenant deletion + billing changes only.
// Consumers arrive with the team and billing slices.

export const canDeleteTenant = (role: TenantRole | undefined | null): boolean =>
  meets(role, "OWNER");

export const canManageBilling = (role: TenantRole | undefined | null): boolean =>
  meets(role, "OWNER");

export const canRemoveOwner = (_role: TenantRole | undefined | null): boolean =>
  false; // No role can remove the owner. Tenant deletion takes the owner with it.

// ─── Generic require-helper ──────────────────────────────────────────────
//
// Most callers use the named helpers above and surface a domain-
// appropriate error. For Server Actions that just need a hard refusal,
// requirePermission gives a one-liner. Prefer `requirePermitted` in
// ./authorize.ts, which also resolves the session and writes the
// ACCESS_DENIED audit row.

export class PermissionDeniedError extends Error {
  constructor(
    public readonly permission: string,
    public readonly role: TenantRole | null
  ) {
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
