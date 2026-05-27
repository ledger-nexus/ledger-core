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
import { prisma } from "@/lib/db";
import type { AccountType, NormalBalance } from "@prisma/client";
import {
  requireAdmin,
  NotAuthenticatedError,
  NotAuthorizedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import {
  auditPrivilegedAction,
  auditAccessDenied,
} from "@/lib/audit/log";

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
    const admin = await requireAdmin();
    const tenant = await requireCurrentTenant();

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

    // ── Resolve entity (optional) ──────────────────────────────────────
    let entityId: string | null = null;
    if (input.entityCode) {
      const entity = await prisma.legalEntity.findFirst({
        where: { tenantId: tenant.id, code: input.entityCode },
        select: { id: true },
      });
      if (!entity) {
        return { ok: false, message: `Unknown entity: ${input.entityCode}` };
      }
      entityId = entity.id;
    }

    // ── Resolve parent (optional) ──────────────────────────────────────
    let parentAccountId: string | null = null;
    if (input.parentCode) {
      const parent = await prisma.account.findFirst({
        where: {
          tenantId: tenant.id,
          code: input.parentCode,
          // Parent must be in same scope (shared OR same entity).
          OR: [{ entityId: null }, { entityId: entityId ?? undefined }],
        },
        select: { id: true, type: true },
      });
      if (!parent) {
        return {
          ok: false,
          message: `Parent account "${input.parentCode}" not found in this scope.`,
        };
      }
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
    const existing = await prisma.account.findFirst({
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
    if (existing) {
      return {
        ok: false,
        message: `An account with code "${code}" already exists in this scope.`,
      };
    }

    const created = await prisma.account.create({
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
    const admin = await requireAdmin();
    const tenant = await requireCurrentTenant();

    const target = await prisma.account.findFirst({
      where: { id: input.id, tenantId: tenant.id },
      select: { id: true, code: true, entityId: true, parentAccountId: true },
    });
    if (!target) {
      return { ok: false, message: "Account not found in this tenant." };
    }

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

    // Parent update: special handling for cycle prevention.
    if (input.parentCode !== undefined) {
      if (input.parentCode === null || input.parentCode === "") {
        data.parentAccountId = null;
      } else {
        const parent = await prisma.account.findFirst({
          where: {
            tenantId: tenant.id,
            code: input.parentCode,
            OR: [{ entityId: null }, { entityId: target.entityId ?? undefined }],
          },
          select: { id: true },
        });
        if (!parent) {
          return {
            ok: false,
            message: `Parent account "${input.parentCode}" not found in this scope.`,
          };
        }
        if (parent.id === target.id) {
          return { ok: false, message: "An account cannot be its own parent." };
        }
        // Cycle prevention: walk up parent.parentAccountId chain. If we
        // hit `target.id`, the proposed parent has target as an ancestor —
        // setting target.parent = parent would create a cycle.
        const cycleHit = await wouldCreateCycle(target.id, parent.id);
        if (cycleHit) {
          return {
            ok: false,
            message:
              "Cannot set parent: this would create a cycle in the account hierarchy.",
          };
        }
        data.parentAccountId = parent.id;
      }
    }

    if (Object.keys(data).length === 0) {
      return { ok: true, message: "No changes." };
    }

    await prisma.account.update({
      where: { id: target.id },
      data,
    });

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
  targetId: string,
  candidateParentId: string
): Promise<boolean> {
  let cursor: string | null = candidateParentId;
  for (let i = 0; i < 50 && cursor; i++) {
    if (cursor === targetId) return true;
    const nextRow: { parentAccountId: string | null } | null = await prisma.account.findUnique({
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
  if (e instanceof NotAuthorizedError) {
    void auditAccessDenied({
      attemptedAction,
      reason: "Not admin",
      resource: "Account",
    });
    return { ok: false, message: "Managing accounts requires admin permission." };
  }
  return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
}
