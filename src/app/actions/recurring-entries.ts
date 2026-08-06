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
import { Decimal } from "@/lib/utils/decimal";
import { z } from "zod";
import type { Cadence } from "@prisma/client";
import { withTenantContext } from "@/lib/tenant-context";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import {
  canManageRecurringEntries,
  PermissionDeniedError,
} from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";
import {
  runRecurringEntries,
  enumerateDueDates,
} from "@/lib/accounting/recurring";
import { isMonthEnd } from "@/lib/accounting/allocation";
import { sanitizeActionError } from "@/lib/actions/action-error";

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

/**
 * Runtime shape of the create payload.
 *
 * A Server Action's TypeScript signature is erased at the boundary — the
 * client sends whatever it likes. `cadence` in particular was typed as
 * the Prisma `Cadence` enum and never checked, so an unrecognized value
 * travelled all the way to `prisma.recurringEntry.create` and came back
 * as a raw Prisma error in the user-facing `message`. Enum membership is
 * exactly what a schema is for (CC6.8).
 *
 * Field shape and enums live here; the accounting rules live in the
 * superRefine below, where their wording is worth preserving.
 */
const AmountLike = z.union([z.string(), z.number()]).optional();

const LineSchema = z.object({
  accountCode: z.string(),
  debit: AmountLike,
  credit: AmountLike,
  allocationPercent: AmountLike,
  description: z.string().max(200).optional(),
  partyCode: z.string().max(40).optional(),
  itemCode: z.string().max(40).optional(),
});

/** Decimal, or null when the value isn't a number at all. */
function toDecimalOrNull(v: string | number | undefined): Decimal | null {
  try {
    const d = new Decimal(v ?? 0);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

const CreateRecurringEntrySchema = z
  .object({
    code: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .refine((c) => c.length >= 2 && c.length <= 40 && CODE_RE.test(c), {
        message:
          "Code must be 2–40 chars: uppercase letters, digits, single _ or -. No double separators.",
      }),
    memo: z
      .string()
      .transform((v) => v.trim())
      .refine((m) => m.length >= 1 && m.length <= 200, {
        message: "Memo must be 1–200 chars.",
      }),
    entityCode: z.string().min(1).max(30),
    bookCode: z.string().min(1).max(30),
    // The FK enforces existence; this catches shape before it gets there.
    currencyCode: z.string().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code.").optional(),
    cadence: z.enum(["MONTHLY", "QUARTERLY", "ANNUALLY"], {
      errorMap: () => ({ message: "Cadence must be MONTHLY, QUARTERLY, or ANNUALLY." }),
    }),
    kind: z.enum(["STANDARD", "ALLOCATION"]).optional(),
    allocationSourceAccountCode: z.string().max(40).optional(),
    startDate: z
      .string()
      .refine((v) => !isNaN(new Date(v).getTime()), {
        message: "startDate must be a valid date (YYYY-MM-DD).",
      }),
    endDate: z
      .string()
      .refine((v) => v === "" || !isNaN(new Date(v).getTime()), {
        message: "endDate must be a valid date (YYYY-MM-DD).",
      })
      .optional(),
    lines: z.array(LineSchema),
  })
  .superRefine((v, ctx) => {
    const fail = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const kind = v.kind ?? "STANDARD";

    if (kind === "ALLOCATION") {
      // Allocation lines are TARGETS (percent, no amounts); the clearing
      // line against the source is generated per run.
      const source = v.allocationSourceAccountCode?.trim();
      if (!source) return fail("Allocation templates need a source account.");
      if (v.lines.length < 1) {
        return fail("Allocation template needs at least 1 target line.");
      }
      let percentSum = new Decimal(0);
      for (const [i, l] of v.lines.entries()) {
        if (!l.accountCode) return fail(`Line ${i + 1}: accountCode required.`);
        if (l.accountCode === source) {
          return fail(`Line ${i + 1}: a target cannot be the source account.`);
        }
        const pct = toDecimalOrNull(l.allocationPercent);
        if (pct === null) return fail(`Line ${i + 1}: invalid percent.`);
        if (pct.lessThanOrEqualTo(0) || pct.greaterThan(100)) {
          return fail(`Line ${i + 1}: percent must be in (0, 100].`);
        }
        const d = toDecimalOrNull(l.debit);
        const c = toDecimalOrNull(l.credit);
        if (d === null || c === null) return fail(`Line ${i + 1}: invalid amount.`);
        if (d.greaterThan(0) || c.greaterThan(0)) {
          return fail(`Line ${i + 1}: allocation lines carry percents, not amounts.`);
        }
        percentSum = percentSum.plus(pct);
      }
      if (!percentSum.equals(100)) {
        return fail(
          `Allocation percents must sum to exactly 100 (got ${percentSum.toString()}).`
        );
      }
      // The window runs [first of month, run date], so anything but a
      // month-end MONTHLY anchor leaves part of every month unallocated
      // with nothing to show for it.
      if (v.cadence !== "MONTHLY") {
        return fail(
          "Allocation templates run monthly — a quarterly or annual cadence would skip the months in between."
        );
      }
      if (!isMonthEnd(new Date(v.startDate))) {
        return fail(
          "Allocation templates must start on a month-end date — the schedule allocates a full month at a time."
        );
      }
    } else {
      if (v.lines.length < 2) return fail("Template needs at least 2 lines.");
      let debitTotal = new Decimal(0);
      let creditTotal = new Decimal(0);
      for (const [i, l] of v.lines.entries()) {
        const debit = toDecimalOrNull(l.debit);
        const credit = toDecimalOrNull(l.credit);
        if (debit === null || credit === null) {
          return fail(`Line ${i + 1}: invalid amount.`);
        }
        if (debit.isNegative() || credit.isNegative()) {
          return fail(`Line ${i + 1}: amounts must be non-negative.`);
        }
        if (debit.greaterThan(0) && credit.greaterThan(0)) {
          return fail(`Line ${i + 1}: cannot have both debit and credit non-zero.`);
        }
        if (debit.isZero() && credit.isZero()) {
          return fail(`Line ${i + 1}: must have a debit or credit > 0.`);
        }
        if (!l.accountCode) return fail(`Line ${i + 1}: accountCode required.`);
        debitTotal = debitTotal.plus(debit);
        creditTotal = creditTotal.plus(credit);
      }
      if (!debitTotal.equals(creditTotal)) {
        return fail(
          `Template unbalanced: debits ${debitTotal.toFixed(2)} ≠ credits ${creditTotal.toFixed(2)}.`
        );
      }
    }

    if (v.endDate && new Date(v.endDate) < new Date(v.startDate)) {
      return fail("endDate must be on or after startDate.");
    }
  });


export async function createRecurringEntryAction(
  input: CreateRecurringEntryInput
): Promise<CreateRecurringEntryState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "recurringEntry.manage",
      canManageRecurringEntries
    );

    const parsed = CreateRecurringEntrySchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.errors[0]?.message ?? "Invalid input." };
    }
    const data = parsed.data;
    const code = data.code;
    const memo = data.memo;
    const kind = data.kind ?? "STANDARD";
    const currencyCode = data.currencyCode ?? "USD";
    const startDate = new Date(data.startDate);
    const endDate = data.endDate ? new Date(data.endDate) : null;

    // ── Create ───────────────────────────────────────────────────────────
    type CreateOutcome =
      | { kind: "unknownEntity" }
      | { kind: "unknownBook" }
      | { kind: "ok"; id: string };

    const outcome = await withTenantContext(prisma, tenant.id, async (tx): Promise<CreateOutcome> => {
      const entity = await tx.legalEntity.findFirst({
        where: { tenantId: tenant.id, code: data.entityCode },
        select: { id: true },
      });
      if (!entity) return { kind: "unknownEntity" };

      const book = await tx.book.findUnique({
        where: { code: data.bookCode },
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
          cadence: data.cadence,
          startDate,
          endDate,
          createdBy: admin.email,
          kind,
          allocationSourceAccountCode:
            kind === "ALLOCATION" ? data.allocationSourceAccountCode!.trim() : null,
          lines: {
            create: data.lines.map((l, idx) => ({
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
      return { ok: false, message: `Unknown entity: ${data.entityCode}` };
    }
    if (outcome.kind === "unknownBook") {
      return { ok: false, message: `Unknown book: ${data.bookCode}` };
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
        cadence: data.cadence,
        entityCode: data.entityCode,
        bookCode: data.bookCode,
        lineCount: data.lines.length,
      },
    });

    revalidatePath("/recurring-entries");
    return { ok: true, id: created.id, message: `Template ${code} created.` };
  } catch (e) {
    return handleAuthError(e, "create-recurring-entry");
  }
}

// The other three actions take ids and dates straight from the client
// too. A malformed uuid or a non-boolean reaching Prisma surfaces as a
// raw driver error in the user-facing message — same gap as `cadence`,
// smaller blast radius.
const RunRecurringSchema = z.object({
  throughDate: z.string().refine((v) => !isNaN(new Date(v).getTime()), {
    message: "throughDate must be a valid date (YYYY-MM-DD).",
  }),
  templateId: z.string().uuid("templateId must be a valid id.").optional(),
});

const SetActiveSchema = z.object({
  id: z.string().uuid("Template id must be a valid id."),
  isActive: z.boolean(),
});

const DeleteRecurringSchema = z.object({
  id: z.string().uuid("Template id must be a valid id."),
});

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

    const parsed = RunRecurringSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.errors[0]?.message ?? "Invalid input." };
    }
    const throughDate = new Date(parsed.data.throughDate);

    const result = await runRecurringEntries(prisma, {
      throughDate,
      tenantId: tenant.id,
      templateId: parsed.data.templateId,
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
      resourceId: parsed.data.templateId ?? "ALL",
      tenantId: tenant.id,
      metadata: {
        throughDate: parsed.data.throughDate,
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
    const parsed = SetActiveSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.errors[0]?.message ?? "Invalid input." };
    }
    const updated = await withTenantContext(prisma, tenant.id, async (tx) =>
      tx.recurringEntry.updateMany({
        where: { id: parsed.data.id, tenantId: tenant.id },
        data: { isActive: parsed.data.isActive },
      })
    );
    if (updated.count === 0) {
      return { ok: false, message: "Template not found in this tenant." };
    }
    await auditPrivilegedAction({
      actor: admin,
      action: parsed.data.isActive ? "activate-recurring-entry" : "pause-recurring-entry",
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
    const parsed = DeleteRecurringSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.errors[0]?.message ?? "Invalid input." };
    }
    const target = await withTenantContext(prisma, tenant.id, async (tx) => {
      const t = await tx.recurringEntry.findFirst({
        where: { id: parsed.data.id, tenantId: tenant.id },
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
    // requirePermitted wrote the ACCESS_DENIED row at the throw site —
    // logging here too would double-count the same refusal.
    return { ok: false, message: "You must be signed in." };
  }
  if (e instanceof PermissionDeniedError) {
    // requirePermitted already wrote the ACCESS_DENIED audit row.
    return { ok: false, message: "Recurring entries require admin permission." };
  }
  return { ok: false, message: sanitizeActionError(e, "Unknown error") };
}

// Re-export the pure helper so the list page can show "next due" without
// duplicating cadence math.
export { enumerateDueDates };
