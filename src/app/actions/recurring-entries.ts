"use server";

// Server Actions for managing + executing recurring journal entry
// templates. All four are admin-gated:
//
//   - createRecurringEntryAction: creates a new template + lines.
//     Validates entity/book/account codes upfront so users see a clear
//     error before the runner ever fires.
//
//   - runRecurringEntriesAction: fires the engine against a chosen
//     throughDate. Designed to be invokable from the UI ("Run through
//     today") or from a cron at night. Returns per-template counts +
//     any per-period failures.
//
//   - setRecurringActiveAction: toggle isActive. Inactive templates
//     are skipped by the runner.
//
//   - deleteRecurringEntryAction: hard-deletes the template + cascades
//     to lines. JEs ALREADY POSTED stay in place — they're real history
//     and the template's lineage is recorded on each one.
//
// All four write a PRIVILEGED_ACTION audit row.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { Decimal } from "decimal.js";
import type { Cadence } from "@prisma/client";
import { withTenantContext } from "@/lib/tenant-context";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import {
  canManageRecurringEntries,
  PermissionDeniedError,
} from "@/lib/auth/policy";
import {
  auditPrivilegedAction,
  auditAccessDenied,
} from "@/lib/audit/log";
import {
  runRecurringEntries,
  enumerateDueDates,
} from "@/lib/accounting/recurring";
import { isMonthEnd } from "@/lib/accounting/allocation";

// ─── Create ────────────────────────────────────────────────────────────────

export interface CreateRecurringEntryInput {
  /** Tenant-unique code, e.g. "MONTHLY_RENT". 2-40 chars, uppercase letters / digits / _ / -. */
  code: string;
  /** Header memo applied to every produced JE. */
  memo: string;
  entityCode: string;
  bookCode: string;
  /** ISO currency code. Defaults to "USD" if omitted. */
  currencyCode?: string;
  cadence: Cadence;
  /** First posting date. */
  startDate: string; // ISO date "YYYY-MM-DD"
  /** Optional sunset (inclusive). */
  endDate?: string;
  /** STANDARD (default) posts lines verbatim; ALLOCATION computes them
   *  from the source account's window activity by line percents. */
  kind?: "STANDARD" | "ALLOCATION";
  /** ALLOCATION only: the account whose activity gets allocated. */
  allocationSourceAccountCode?: string;
  lines: Array<{
    accountCode: string;
    debit?: string | number;
    credit?: string | number;
    /** ALLOCATION only: this target's share, 0–100. */
    allocationPercent?: string | number;
    description?: string;
    partyCode?: string;
    itemCode?: string;
  }>;
}

export interface CreateRecurringEntryState {
  ok: boolean;
  message?: string;
  id?: string;
}

const CODE_RE = /^[A-Z0-9](?:[A-Z0-9]|[_-](?![_-]))*[A-Z0-9]$/;

export async function createRecurringEntryAction(
  input: CreateRecurringEntryInput
): Promise<CreateRecurringEntryState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "recurringEntry.manage",
      canManageRecurringEntries
    );

    // ── Validate code ────────────────────────────────────────────────────
    const code = input.code?.trim().toUpperCase() ?? "";
    if (code.length < 2 || code.length > 40 || !CODE_RE.test(code)) {
      return {
        ok: false,
        message:
          "Code must be 2–40 chars: uppercase letters, digits, single _ or -. No double separators.",
      };
    }
    const memo = input.memo?.trim() ?? "";
    if (memo.length < 1 || memo.length > 200) {
      return { ok: false, message: "Memo must be 1–200 chars." };
    }
    const kind = input.kind ?? "STANDARD";
    if (kind === "ALLOCATION") {
      // Allocation templates: lines are TARGETS (percent, no amounts);
      // the clearing line against the source is generated per run.
      const source = input.allocationSourceAccountCode?.trim();
      if (!source) {
        return { ok: false, message: "Allocation templates need a source account." };
      }
      if (!input.lines || input.lines.length < 1) {
        return { ok: false, message: "Allocation template needs at least 1 target line." };
      }
      let percentSum = new Decimal(0);
      for (const [i, l] of input.lines.entries()) {
        if (!l.accountCode) {
          return { ok: false, message: `Line ${i + 1}: accountCode required.` };
        }
        if (l.accountCode === source) {
          return { ok: false, message: `Line ${i + 1}: a target cannot be the source account.` };
        }
        let pct: Decimal;
        try {
          pct = new Decimal(l.allocationPercent ?? 0);
        } catch {
          return { ok: false, message: `Line ${i + 1}: invalid percent.` };
        }
        if (!pct.isFinite() || pct.lessThanOrEqualTo(0) || pct.greaterThan(100)) {
          return { ok: false, message: `Line ${i + 1}: percent must be in (0, 100].` };
        }
        if (new Decimal(l.debit ?? 0).greaterThan(0) || new Decimal(l.credit ?? 0).greaterThan(0)) {
          return { ok: false, message: `Line ${i + 1}: allocation lines carry percents, not amounts.` };
        }
        percentSum = percentSum.plus(pct);
      }
      if (!percentSum.equals(100)) {
        return {
          ok: false,
          message: `Allocation percents must sum to exactly 100 (got ${percentSum.toString()}).`,
        };
      }
    } else if (!input.lines || input.lines.length < 2) {
      return { ok: false, message: "Template needs at least 2 lines." };
    }

    // ── Resolve entity + book + currency in tenant scope ─────────────────
    // RLS Phase 2b shape T2: full resolver chain + create runs inside
    // withTenantContext using the action's requireCurrentTenant() result.
    // (Unlike shape E in period-close, here the tenant comes from the
    // auth layer, not from the entity lookup — so the wrap can include
    // the entity lookup too, and the tenant-scoped predicate is now
    // defense in depth alongside the GUC.)
    const currencyCode = input.currencyCode ?? "USD";

    // ── Validate lines: balanced + non-negative + non-empty ─────────────
    // (STANDARD only — allocation lines were validated above and carry
    // no amounts.)
    if (kind === "STANDARD") {
    let debitTotal = new Decimal(0);
    let creditTotal = new Decimal(0);
    for (const [i, l] of input.lines.entries()) {
      const debit = new Decimal(l.debit ?? 0);
      const credit = new Decimal(l.credit ?? 0);
      if (debit.isNegative() || credit.isNegative()) {
        return { ok: false, message: `Line ${i + 1}: amounts must be non-negative.` };
      }
      if (debit.greaterThan(0) && credit.greaterThan(0)) {
        return {
          ok: false,
          message: `Line ${i + 1}: cannot have both debit and credit non-zero.`,
        };
      }
      if (debit.isZero() && credit.isZero()) {
        return {
          ok: false,
          message: `Line ${i + 1}: must have a debit or credit > 0.`,
        };
      }
      if (!l.accountCode) {
        return { ok: false, message: `Line ${i + 1}: accountCode required.` };
      }
      debitTotal = debitTotal.plus(debit);
      creditTotal = creditTotal.plus(credit);
    }
    if (!debitTotal.equals(creditTotal)) {
      return {
        ok: false,
        message: `Template unbalanced: debits ${debitTotal.toFixed(2)} ≠ credits ${creditTotal.toFixed(2)}.`,
      };
    }
    }

    // ── Validate dates ───────────────────────────────────────────────────
    const startDate = new Date(input.startDate);
    if (isNaN(startDate.getTime())) {
      return { ok: false, message: "startDate must be a valid date (YYYY-MM-DD)." };
    }
    const endDate = input.endDate ? new Date(input.endDate) : null;
    if (endDate && isNaN(endDate.getTime())) {
      return { ok: false, message: "endDate must be a valid date (YYYY-MM-DD)." };
    }
    if (endDate && endDate < startDate) {
      return { ok: false, message: "endDate must be on or after startDate." };
    }
    // Allocation windows run [first of month, run date], so anything but
    // a month-end MONTHLY anchor leaves part of every month unallocated
    // with nothing to show for it. Refuse at creation — the runner
    // refuses too, but a user should never get a template that can only
    // fail. (v1 bound; a period-derived window would lift it.)
    if (kind === "ALLOCATION") {
      if (input.cadence !== "MONTHLY") {
        return {
          ok: false,
          message:
            "Allocation templates run monthly — a quarterly or annual cadence would skip the months in between.",
        };
      }
      if (!isMonthEnd(startDate)) {
        return {
          ok: false,
          message:
            "Allocation templates must start on a month-end date — the schedule allocates a full month at a time.",
        };
      }
    }

    // ── Create ───────────────────────────────────────────────────────────
    type CreateOutcome =
      | { kind: "unknownEntity" }
      | { kind: "unknownBook" }
      | { kind: "ok"; id: string };

    const outcome = await withTenantContext(prisma, tenant.id, async (tx): Promise<CreateOutcome> => {
      const entity = await tx.legalEntity.findFirst({
        where: { tenantId: tenant.id, code: input.entityCode },
        select: { id: true },
      });
      if (!entity) return { kind: "unknownEntity" };

      const book = await tx.book.findUnique({
        where: { code: input.bookCode },
        select: { id: true },
      });
      if (!book) return { kind: "unknownBook" };

      const created = await tx.recurringEntry.create({
        data: {
          tenantId: tenant.id,
          entityId: entity.id,
          bookId: book.id,
          code,
          memo,
          currencyId: currencyCode,
          cadence: input.cadence,
          startDate,
          endDate,
          createdBy: admin.email,
          kind,
          allocationSourceAccountCode:
            kind === "ALLOCATION" ? input.allocationSourceAccountCode!.trim() : null,
          lines: {
            create: input.lines.map((l, idx) => ({
              lineNo: idx + 1,
              accountCode: l.accountCode,
              debit: new Decimal(l.debit ?? 0).toFixed(4),
              credit: new Decimal(l.credit ?? 0).toFixed(4),
              allocationPercent:
                kind === "ALLOCATION" ? new Decimal(l.allocationPercent ?? 0).toFixed(4) : null,
              description: l.description,
              partyCode: l.partyCode,
              itemCode: l.itemCode,
            })),
          },
        },
        select: { id: true },
      });
      return { kind: "ok", id: created.id };
    });

    if (outcome.kind === "unknownEntity") {
      return { ok: false, message: `Unknown entity: ${input.entityCode}` };
    }
    if (outcome.kind === "unknownBook") {
      return { ok: false, message: `Unknown book: ${input.bookCode}` };
    }
    const created = { id: outcome.id };

    await auditPrivilegedAction({
      actor: admin,
      action: "create-recurring-entry",
      resource: "RecurringEntry",
      resourceId: created.id,
      tenantId: tenant.id,
      metadata: {
        code,
        cadence: input.cadence,
        entityCode: input.entityCode,
        bookCode: input.bookCode,
        lineCount: input.lines.length,
      },
    });

    revalidatePath("/recurring-entries");
    return { ok: true, id: created.id, message: `Template ${code} created.` };
  } catch (e) {
    return handleAuthError(e, "create-recurring-entry");
  }
}

// ─── Run ───────────────────────────────────────────────────────────────────

export interface RunRecurringInput {
  throughDate: string;
  /** Optional: run only one template. */
  templateId?: string;
}

export interface RunRecurringState {
  ok: boolean;
  message?: string;
  entriesPosted?: number;
  templatesIdle?: number;
  errors?: Array<{ templateCode: string; docDate: string; message: string }>;
}

export async function runRecurringEntriesAction(
  input: RunRecurringInput
): Promise<RunRecurringState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "recurringEntry.manage",
      canManageRecurringEntries
    );

    const throughDate = new Date(input.throughDate);
    if (isNaN(throughDate.getTime())) {
      return { ok: false, message: "throughDate must be a valid date (YYYY-MM-DD)." };
    }

    const result = await runRecurringEntries(prisma, {
      throughDate,
      tenantId: tenant.id,
      templateId: input.templateId,
      triggeredBy: admin.email,
    });

    const errors = result.templates.flatMap((t) =>
      t.errors.map((e) => ({
        templateCode: t.code,
        docDate: e.docDate,
        message: e.message,
      }))
    );

    await auditPrivilegedAction({
      actor: admin,
      action: "run-recurring-entries",
      resource: "RecurringEntry",
      resourceId: input.templateId ?? "ALL",
      tenantId: tenant.id,
      metadata: {
        throughDate: input.throughDate,
        entriesPosted: result.entriesPosted,
        templatesIdle: result.templatesIdle,
        errorCount: errors.length,
      },
    });

    revalidatePath("/recurring-entries");
    revalidatePath("/journal-entries");
    return {
      ok: true,
      entriesPosted: result.entriesPosted,
      templatesIdle: result.templatesIdle,
      errors,
      message: errors.length
        ? `Posted ${result.entriesPosted} entries with ${errors.length} error${errors.length === 1 ? "" : "s"}.`
        : `Posted ${result.entriesPosted} ${result.entriesPosted === 1 ? "entry" : "entries"}; ${result.templatesIdle} template${result.templatesIdle === 1 ? "" : "s"} idle.`,
    };
  } catch (e) {
    return handleAuthError(e, "run-recurring-entries");
  }
}

// ─── Activate / pause ──────────────────────────────────────────────────────

export interface SetActiveInput {
  id: string;
  isActive: boolean;
}

export interface SetActiveState {
  ok: boolean;
  message?: string;
}

export async function setRecurringActiveAction(
  input: SetActiveInput
): Promise<SetActiveState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "recurringEntry.manage",
      canManageRecurringEntries
    );
    // RLS Phase 2b shape W2 (no helper involved): wrap the single
    // updateMany in withTenantContext. Tenant-scoped predicate retained
    // as defense in depth.
    const updated = await withTenantContext(prisma, tenant.id, async (tx) =>
      tx.recurringEntry.updateMany({
        where: { id: input.id, tenantId: tenant.id },
        data: { isActive: input.isActive },
      })
    );
    if (updated.count === 0) {
      return { ok: false, message: "Template not found in this tenant." };
    }
    await auditPrivilegedAction({
      actor: admin,
      action: input.isActive ? "activate-recurring-entry" : "pause-recurring-entry",
      resource: "RecurringEntry",
      resourceId: input.id,
      tenantId: tenant.id,
    });
    revalidatePath("/recurring-entries");
    return {
      ok: true,
      message: input.isActive ? "Template activated." : "Template paused.",
    };
  } catch (e) {
    return handleAuthError(e, "set-recurring-active");
  }
}

// ─── Delete ────────────────────────────────────────────────────────────────

export interface DeleteRecurringInput {
  id: string;
}

export interface DeleteRecurringState {
  ok: boolean;
  message?: string;
}

export async function deleteRecurringEntryAction(
  input: DeleteRecurringInput
): Promise<DeleteRecurringState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "recurringEntry.manage",
      canManageRecurringEntries
    );
    // RLS Phase 2b shape T2: findFirst + delete inside one
    // withTenantContext tx. Tenant-scoped predicate retained.
    // Cascade deletes lines (FK ON DELETE CASCADE). JEs already posted
    // stay in place — they carry their own lineage triple recording
    // which template produced them.
    const target = await withTenantContext(prisma, tenant.id, async (tx) => {
      const t = await tx.recurringEntry.findFirst({
        where: { id: input.id, tenantId: tenant.id },
        select: { id: true, code: true },
      });
      if (!t) return null;
      await tx.recurringEntry.delete({ where: { id: t.id } });
      return t;
    });
    if (!target) {
      return { ok: false, message: "Template not found in this tenant." };
    }
    await auditPrivilegedAction({
      actor: admin,
      action: "delete-recurring-entry",
      resource: "RecurringEntry",
      resourceId: target.id,
      tenantId: tenant.id,
      metadata: { code: target.code },
    });
    revalidatePath("/recurring-entries");
    return { ok: true, message: `Template ${target.code} deleted.` };
  } catch (e) {
    return handleAuthError(e, "delete-recurring-entry");
  }
}

// ─── Shared error handler ──────────────────────────────────────────────────

function handleAuthError(
  e: unknown,
  attemptedAction: string
): { ok: false; message: string } {
  if (e instanceof NotAuthenticatedError) {
    void auditAccessDenied({
      attemptedAction,
      reason: "Not authenticated",
      resource: "RecurringEntry",
    });
    return { ok: false, message: "You must be signed in." };
  }
  if (e instanceof PermissionDeniedError) {
    // requirePermitted already wrote the ACCESS_DENIED audit row.
    return { ok: false, message: "Recurring entries require admin permission." };
  }
  return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
}

// Re-export the pure helper so the list page can show "next due" without
// duplicating cadence math.
export { enumerateDueDates };
