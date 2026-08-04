"use server";

// Server Actions for managing the chart of accounts.
//
//   - createAccountAction:     create a new account in the active scope.
//                              Admin-gated; tenant-scoped; validates
//                              code uniqueness within entity, cycle-
//                              free parent, parent in same scope.
//   - updateAccountAction:     edit name / flags / parent. Cannot
//                              change code or type after creation
//                              (those are load-bearing for posting +
//                              report grouping).
//   - deactivateAccountAction: soft-deactivate (active=false). Posted
//                              JE lines reference the account by id, so
//                              we never hard-delete. Reversible via
//                              updateAccountAction({active: true}).
//
// All three write PRIVILEGED_ACTION audit rows. Chart-of-accounts
// changes are exactly the kind of thing SOC 2 reviewers check —
// who added the new "Director Bonus" expense account in November?

import { revalidatePath } from "next/cache";
import type { AccountType, NormalBalance, Prisma, PrismaClient } from "@prisma/client";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import { canEditAccounts, PermissionDeniedError } from "@/lib/auth/policy";
import {
  auditPrivilegedAction,
  auditAccessDenied,
} from "@/lib/audit/log";
import { prisma } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-context";

// RLS Phase 2b widening — local helpers take either PrismaClient OR
// TransactionClient. Used by wouldCreateCycle which is called from
// inside withTenantContext.
type Db = PrismaClient | Prisma.TransactionClient;

// Account codes are short, alphanumeric-ish: 1000, 1010-A, RE, etc.
// 2-15 chars; letters / digits / single hyphen between alphanumerics.
const CODE_RE = /^[A-Z0-9](?:[A-Z0-9]|[-_](?![-_]))*[A-Z0-9]$/;

// ─── Create ────────────────────────────────────────────────────────────────

export interface CreateAccountInput {
  /** Tenant-unique within an entity, e.g. "1000". Will be uppercased. */
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  /** Optional parent account code. Must exist in the same entity scope. */
  parentCode?: string;
  /** Optional entity scope. If omitted, account is "shared" (entityId=null). */
  entityCode?: string;
  subtype?: string;
  isContra?: boolean;
  isControlAccount?: boolean;
  isBank?: boolean;
}

export interface CreateAccountState {
  ok: boolean;
  message?: string;
  accountId?: string;
}

export async function createAccountAction(
  input: CreateAccountInput
): Promise<CreateAccountState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "account.manage",
      canEditAccounts
    );

    // ── Validate code shape ────────────────────────────────────────────
    const code = input.code?.trim().toUpperCase() ?? "";
    if (code.length < 2 || code.length > 15 || !CODE_RE.test(code)) {
      return {
        ok: false,
        message:
          "Code must be 2–15 chars: uppercase letters, digits, single - or _.",
      };
    }

    const name = input.name?.trim() ?? "";
    if (name.length < 1 || name.length > 200) {
      return { ok: false, message: "Name must be 1–200 chars." };
    }

    if (!["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"].includes(input.type)) {
      return { ok: false, message: "Invalid account type." };
    }
    if (!["DEBIT", "CREDIT"].includes(input.normalBalance)) {
      return { ok: false, message: "Invalid normal balance." };
    }

    // RLS Phase 2b shape T2: entity-resolve + parent-resolve + uniqueness
    // + create all run inside one withTenantContext tx.
    type CreateOutcome =
      | { kind: "unknownEntity" }
      | { kind: "unknownParent" }
      | { kind: "duplicateCode" }
      | { kind: "ok"; id: string };

    const outcome = await withTenantContext(prisma, tenant.id, async (tx): Promise<CreateOutcome> => {
      // ── Resolve entity (optional) ──────────────────────────────────────
      let entityId: string | null = null;
      if (input.entityCode) {
        const entity = await tx.legalEntity.findFirst({
          where: { tenantId: tenant.id, code: input.entityCode },
          select: { id: true },
        });
        if (!entity) return { kind: "unknownEntity" };
        entityId = entity.id;
      }

      // ── Resolve parent (optional) ──────────────────────────────────────
      let parentAccountId: string | null = null;
      if (input.parentCode) {
        const parent = await tx.account.findFirst({
          where: {
            tenantId: tenant.id,
            code: input.parentCode,
            // Parent must be in same scope (shared OR same entity).
            OR: [{ entityId: null }, { entityId: entityId ?? undefined }],
          },
          select: { id: true, type: true },
        });
        if (!parent) return { kind: "unknownParent" };
        // Soft-enforce: parent's type should match (a Cash account doesn't
        // make sense under a Revenue parent). We warn but don't block —
        // some shops use unusual rollups for reporting flexibility.
        if (parent.type !== input.type) {
          // Could return an error, but instead just allow it (real CPAs
          // sometimes nest mixed types for management reporting).
        }
        parentAccountId = parent.id;
      }

      // ── Uniqueness check (better message than the DB constraint) ───────
      const existing = await tx.account.findFirst({
        where: {
          tenantId: tenant.id,
          code,
          // Match the (entityId, code) unique key — null is treated as
          // distinct in Postgres, so this query naturally scopes per
          // entity. For shared accounts entityId is null.
          entityId,
        },
        select: { id: true },
      });
      if (existing) return { kind: "duplicateCode" };

      const created = await tx.account.create({
        data: {
          tenantId: tenant.id,
          entityId,
          code,
          name,
          type: input.type,
          normalBalance: input.normalBalance,
          parentAccountId,
          subtype: input.subtype?.trim() || null,
          isContra: input.isContra ?? false,
          isControlAccount: input.isControlAccount ?? false,
          isBank: input.isBank ?? false,
        },
        select: { id: true },
      });
      return { kind: "ok", id: created.id };
    });

    if (outcome.kind === "unknownEntity") {
      return { ok: false, message: `Unknown entity: ${input.entityCode}` };
    }
    if (outcome.kind === "unknownParent") {
      return {
        ok: false,
        message: `Parent account "${input.parentCode}" not found in this scope.`,
      };
    }
    if (outcome.kind === "duplicateCode") {
      return {
        ok: false,
        message: `An account with code "${code}" already exists in this scope.`,
      };
    }
    const created = { id: outcome.id };

    await auditPrivilegedAction({
      actor: admin,
      action: "create-account",
      resource: "Account",
      resourceId: created.id,
      tenantId: tenant.id,
      metadata: {
        code,
        name,
        type: input.type,
        normalBalance: input.normalBalance,
        entityCode: input.entityCode ?? null,
        parentCode: input.parentCode ?? null,
      },
    });

    revalidatePath("/accounts");
    revalidatePath("/reports/trial-balance");
    revalidatePath("/reports/balance-sheet");
    revalidatePath("/reports/income-statement");
    return {
      ok: true,
      accountId: created.id,
      message: `Account ${code} — ${name} created.`,
    };
  } catch (e) {
    return handleAuthError(e, "create-account");
  }
}

// ─── Update ────────────────────────────────────────────────────────────────

export interface UpdateAccountInput {
  id: string;
  name?: string;
  subtype?: string | null;
  isContra?: boolean;
  isControlAccount?: boolean;
  isBank?: boolean;
  /**
   * Set parent. Pass null to clear; pass undefined to leave unchanged.
   * The parent's code (not id) — same scope resolution as create.
   */
  parentCode?: string | null;
  /** Soft-deactivate / re-activate. */
  active?: boolean;
}

export interface UpdateAccountState {
  ok: boolean;
  message?: string;
}

export async function updateAccountAction(
  input: UpdateAccountInput
): Promise<UpdateAccountState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "account.manage",
      canEditAccounts
    );

    // Pre-tx validation that doesn't need DB access.
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length < 1 || name.length > 200) {
        return { ok: false, message: "Name must be 1–200 chars." };
      }
      data.name = name;
    }
    if (input.subtype !== undefined) {
      data.subtype = input.subtype === null ? null : input.subtype.trim() || null;
    }
    if (input.isContra !== undefined) data.isContra = input.isContra;
    if (input.isControlAccount !== undefined) data.isControlAccount = input.isControlAccount;
    if (input.isBank !== undefined) data.isBank = input.isBank;
    if (input.active !== undefined) data.active = input.active;

    // RLS Phase 2b shape T2: target-find + parent-resolve + cycle-check
    // (calls widened wouldCreateCycle) + update inside one withTenantContext tx.
    type UpdateOutcome =
      | { kind: "notFound" }
      | { kind: "noChanges" }
      | { kind: "unknownParent" }
      | { kind: "selfParent" }
      | { kind: "cycle" }
      | { kind: "ok"; code: string };

    const outcome = await withTenantContext(prisma, tenant.id, async (tx): Promise<UpdateOutcome> => {
      const target = await tx.account.findFirst({
        where: { id: input.id, tenantId: tenant.id },
        select: { id: true, code: true, entityId: true, parentAccountId: true },
      });
      if (!target) return { kind: "notFound" };

      // Parent update: special handling for cycle prevention.
      if (input.parentCode !== undefined) {
        if (input.parentCode === null || input.parentCode === "") {
          data.parentAccountId = null;
        } else {
          const parent = await tx.account.findFirst({
            where: {
              tenantId: tenant.id,
              code: input.parentCode,
              OR: [{ entityId: null }, { entityId: target.entityId ?? undefined }],
            },
            select: { id: true },
          });
          if (!parent) return { kind: "unknownParent" };
          if (parent.id === target.id) return { kind: "selfParent" };
          // Cycle prevention: walk up parent.parentAccountId chain. If we
          // hit `target.id`, the proposed parent has target as an ancestor —
          // setting target.parent = parent would create a cycle.
          const cycleHit = await wouldCreateCycle(tx, target.id, parent.id);
          if (cycleHit) return { kind: "cycle" };
          data.parentAccountId = parent.id;
        }
      }

      if (Object.keys(data).length === 0) return { kind: "noChanges" };

      await tx.account.update({
        where: { id: target.id },
        data,
      });
      return { kind: "ok", code: target.code };
    });

    if (outcome.kind === "notFound") {
      return { ok: false, message: "Account not found in this tenant." };
    }
    if (outcome.kind === "unknownParent") {
      return {
        ok: false,
        message: `Parent account "${input.parentCode}" not found in this scope.`,
      };
    }
    if (outcome.kind === "selfParent") {
      return { ok: false, message: "An account cannot be its own parent." };
    }
    if (outcome.kind === "cycle") {
      return {
        ok: false,
        message: "Cannot set parent: this would create a cycle in the account hierarchy.",
      };
    }
    if (outcome.kind === "noChanges") {
      return { ok: true, message: "No changes." };
    }
    const target = { id: input.id, code: outcome.code };

    await auditPrivilegedAction({
      actor: admin,
      action: "update-account",
      resource: "Account",
      resourceId: target.id,
      tenantId: tenant.id,
      metadata: {
        accountCode: target.code,
        changed: Object.keys(data),
      },
    });

    revalidatePath("/accounts");
    revalidatePath(`/accounts/${target.code}`);
    revalidatePath("/reports/trial-balance");
    revalidatePath("/reports/balance-sheet");
    revalidatePath("/reports/income-statement");
    return { ok: true, message: `Account ${target.code} updated.` };
  } catch (e) {
    return handleAuthError(e, "update-account");
  }
}

// ─── Deactivate ────────────────────────────────────────────────────────────

export interface DeactivateAccountInput {
  id: string;
}

export interface DeactivateAccountState {
  ok: boolean;
  message?: string;
}

export async function deactivateAccountAction(
  input: DeactivateAccountInput
): Promise<DeactivateAccountState> {
  // Reuse updateAccountAction's machinery — deactivate is just an
  // update with active=false.
  return await updateAccountAction({ id: input.id, active: false });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Walk up parent chain from `candidateParentId`. If we ever encounter
 * `targetId`, setting target.parent = candidate would create a cycle.
 * Returns true iff a cycle would form. Capped at 50 levels for safety
 * (real charts are 4–5 levels max).
 */
async function wouldCreateCycle(
  db: Db,
  targetId: string,
  candidateParentId: string
): Promise<boolean> {
  let cursor: string | null = candidateParentId;
  for (let i = 0; i < 50 && cursor; i++) {
    if (cursor === targetId) return true;
    const nextRow: { parentAccountId: string | null } | null = await db.account.findUnique({
      where: { id: cursor },
      select: { parentAccountId: true },
    });
    cursor = nextRow?.parentAccountId ?? null;
  }
  return false;
}

function handleAuthError(
  e: unknown,
  attemptedAction: string
): { ok: false; message: string } {
  if (e instanceof NotAuthenticatedError) {
    void auditAccessDenied({
      attemptedAction,
      reason: "Not authenticated",
      resource: "Account",
    });
    return { ok: false, message: "You must be signed in." };
  }
  if (e instanceof PermissionDeniedError) {
    // requirePermitted already wrote the ACCESS_DENIED audit row.
    return { ok: false, message: "Managing accounts requires admin permission." };
  }
  return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
}
