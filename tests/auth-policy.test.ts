// Policy module tests — pure functions, no DB needed.
//
// Verifies the role hierarchy + every named permission helper returns
// the right answer for every role. The test matrix is exhaustive (5
// inputs × 16 permissions = 80 assertions) so a future "I'll just nudge
// canPostJournalEntries to require ADMIN" can't silently regress.

import { describe, it, expect } from "vitest";
import type { TenantRole } from "@prisma/client";
import {
  canViewReports,
  canViewAuditLog,
  canViewAdminPages,
  canPostJournalEntries,
  canEditAccounts,
  canApproveAiSuggestions,
  canRunDepreciation,
  canApplyArApPayments,
  canClosePeriods,
  canManageUsers,
  canManageRecurringEntries,
  canManageReassignmentRules,
  canManageAiBudget,
  canManageMemberships,
  canDeleteTenant,
  canManageBilling,
  canRemoveOwner,
  requirePermission,
  PermissionDeniedError,
} from "../src/lib/auth/policy";

type RoleOrNull = TenantRole | null;

const ALL_ROLES: RoleOrNull[] = ["VIEWER", "MEMBER", "ADMIN", "OWNER", null];

interface Case {
  name: string;
  fn: (r: RoleOrNull) => boolean;
  /** Minimum role that returns true. null = nobody ever returns true. */
  minRole: TenantRole | null;
}

const CASES: Case[] = [
  // READ tier
  { name: "canViewReports",            fn: canViewReports,            minRole: "VIEWER" },
  { name: "canViewAuditLog",           fn: canViewAuditLog,           minRole: "ADMIN" },
  { name: "canViewAdminPages",         fn: canViewAdminPages,         minRole: "ADMIN" },
  // WRITE tier
  { name: "canPostJournalEntries",     fn: canPostJournalEntries,     minRole: "MEMBER" },
  { name: "canEditAccounts",           fn: canEditAccounts,           minRole: "MEMBER" },
  { name: "canApproveAiSuggestions",   fn: canApproveAiSuggestions,   minRole: "MEMBER" },
  { name: "canRunDepreciation",        fn: canRunDepreciation,        minRole: "MEMBER" },
  { name: "canApplyArApPayments",      fn: canApplyArApPayments,      minRole: "MEMBER" },
  // ADMIN tier
  { name: "canClosePeriods",           fn: canClosePeriods,           minRole: "ADMIN" },
  { name: "canManageUsers",            fn: canManageUsers,            minRole: "ADMIN" },
  { name: "canManageRecurringEntries", fn: canManageRecurringEntries, minRole: "ADMIN" },
  { name: "canManageReassignmentRules",fn: canManageReassignmentRules,minRole: "ADMIN" },
  { name: "canManageAiBudget",         fn: canManageAiBudget,         minRole: "ADMIN" },
  { name: "canManageMemberships",      fn: canManageMemberships,      minRole: "ADMIN" },
  // OWNER tier
  { name: "canDeleteTenant",           fn: canDeleteTenant,           minRole: "OWNER" },
  { name: "canManageBilling",          fn: canManageBilling,          minRole: "OWNER" },
  // Universally denied
  { name: "canRemoveOwner",            fn: canRemoveOwner,            minRole: null },
];

const RANK: Record<string, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

describe("policy: role hierarchy", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      for (const role of ALL_ROLES) {
        const expectedTrue =
          c.minRole !== null && role !== null && RANK[role] >= RANK[c.minRole];
        it(`role=${role ?? "null"} → ${expectedTrue}`, () => {
          expect(c.fn(role)).toBe(expectedTrue);
        });
      }
    });
  }
});

describe("policy: requirePermission", () => {
  it("does not throw when the check passes", () => {
    expect(() =>
      requirePermission("test", "ADMIN", canClosePeriods)
    ).not.toThrow();
  });

  it("throws PermissionDeniedError when the check fails", () => {
    expect(() =>
      requirePermission("close_periods", "MEMBER", canClosePeriods)
    ).toThrow(PermissionDeniedError);
  });

  it("error includes the role and permission name", () => {
    try {
      requirePermission("close_periods", "VIEWER", canClosePeriods);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionDeniedError);
      const err = e as PermissionDeniedError;
      expect(err.role).toBe("VIEWER");
      expect(err.permission).toBe("close_periods");
      expect(err.message).toMatch(/VIEWER/);
      expect(err.message).toMatch(/close_periods/);
    }
  });

  it("throws with null role too (signed-out caller)", () => {
    expect(() =>
      requirePermission("close_periods", null, canClosePeriods)
    ).toThrow(PermissionDeniedError);
  });

  it("canRemoveOwner refuses every role including OWNER", () => {
    expect(canRemoveOwner("OWNER")).toBe(false);
    expect(canRemoveOwner("ADMIN")).toBe(false);
    expect(canRemoveOwner(null)).toBe(false);
  });
});
