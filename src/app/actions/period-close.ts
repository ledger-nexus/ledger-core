"use server";

// Period close + reopen Server Actions.
//
// The substrate has had PeriodClose enforcement since v0.2 — postJournalEntry
// rejects writes against any (entity, book, period) with a row in
// `period_close`. What's been missing is a UI / Server Action path to
// create or remove those rows. Until now closes happened only via direct
// DB writes or via seed data. This adds the proper admin-gated workflow.
//
// Semantics:
//
//   closePeriodAction({entityCode, bookCode, periodCode})
//     → upserts a PeriodClose row, stamps closedAt + closedBy from the
//       current admin user. Idempotent: closing an already-closed
//       period returns ok=true with wasAlreadyClosed=true and does NOT
//       update closedAt (preserves the original close timestamp for
//       audit).
//
//   reopenPeriodAction({entityCode, bookCode, periodCode})
//     → deletes the PeriodClose row. Idempotent: reopening an already-
//       open period returns ok=true with wasAlreadyOpen=true.
//
// Audit trail: every close stamps the admin's userId/email into closedBy.
// Reopen has no equivalent audit column today; the deletion is logged
// in RecordEvent (the same audit table reassignments use) — see v0.3
// of this file for the RecordEvent wiring.
//
// Permission: both actions require canClosePeriods (ADMIN+ in the
// current tenant). Period close is one of the highest-impact admin
// operations in an accounting system — it freezes the books for a
// (book, period) tuple — so the explicit gate is non-negotiable. Reopen
// is similarly gated because it can resurrect posting on a period
// that's already been reported on to stakeholders.
//
// Per-book independence: GAAP April can be closed while Tax April stays
// open. This is the whole point of multi-book — close on the schedule
// that matches each book's reporting cadence, not a global one.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import { canClosePeriods, PermissionDeniedError } from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { checkRequiredTasksComplete } from "@/lib/close-tasks/rollup";
import { sanitizeActionError } from "@/lib/actions/action-error";

export interface ClosePeriodInput {
  entityCode: string;
  bookCode: string;
  /** Period.code (e.g. "2026-05" for monthly calendars). */
  periodCode: string;
}

export interface ClosePeriodState {
  ok: boolean;
  message?: string;
  wasAlreadyClosed?: boolean;
  closedAt?: string;
  closedBy?: string;
  /** Diagnostic — how many JEs are in this period (entity, book scope). */
  journalEntryCount?: number;
  /**
   * BlackLine arc Phase 2 PR 6: when the close-gate refuses the close
   * because requiredForClose tasks aren't terminal, the blocker names
   * land here so the UI can render "Cannot close: 3 tasks still open
   * (Reconcile cash, Reconcile AR, Run depreciation)".
   */
  taskBlockers?: { id: string; name: string; status: string }[];
}

export async function closePeriodAction(
  input: ClosePeriodInput
): Promise<ClosePeriodState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "period.close",
      canClosePeriods
    );

    if (!input.entityCode || !input.bookCode || !input.periodCode) {
      return { ok: false, message: "entityCode, bookCode, and periodCode are all required" };
    }

    // Phase 4b: legalEntity.code is unique per [tenantId, code]. Pinned
    // to the CURRENT tenant — admin is a per-tenant role now, so an
    // ADMIN of tenant A must never resolve (and close) tenant B's
    // entity by guessing its code.
    const entity = await prisma.legalEntity.findFirst({
      where: { code: input.entityCode, tenantId: tenant.id },
      // tenantId pulled so the PeriodClose row is tenant-tagged.
      select: { id: true, code: true, tenantId: true },
    });
    if (!entity) return { ok: false, message: `Unknown entity: ${input.entityCode}` };

    const book = await prisma.book.findUnique({
      where: { code: input.bookCode },
      select: { id: true, code: true },
    });
    if (!book) return { ok: false, message: `Unknown book: ${input.bookCode}` };

    // Scope period lookup to the entity's calendar(s) — multiple entities
    // can have periods with the same code (e.g. "2026-05") on their own
    // calendars; without this scoping the action would close the wrong one.
    const period = await prisma.period.findFirst({
      where: {
        code: input.periodCode,
        calendar: { entityId: entity.id },
      },
      select: { id: true, code: true },
    });
    if (!period) {
      return {
        ok: false,
        message: `Unknown period: ${input.periodCode} for entity ${input.entityCode}`,
      };
    }

    // Idempotency: if already closed, return the existing close info.
    const existing = await prisma.periodClose.findUnique({
      where: {
        entityId_bookId_periodId: {
          entityId: entity.id,
          bookId: book.id,
          periodId: period.id,
        },
      },
      select: { closedAt: true, closedBy: true },
    });
    if (existing) {
      return {
        ok: true,
        message: `Period ${input.periodCode} already closed on ${input.entityCode} / ${input.bookCode}.`,
        wasAlreadyClosed: true,
        closedAt: existing.closedAt.toISOString(),
        closedBy: existing.closedBy ?? undefined,
      };
    }

    const jeCount = await prisma.journalEntry.count({
      where: { entityId: entity.id, bookId: book.id, periodId: period.id },
    });

    // BlackLine arc Phase 2 PR 6 — close-task gate. Every
    // requiredForClose=true CloseTask for (tenant, period) must be in
    // a terminal state (DONE or WAIVED) before the period can close.
    // Tasks are PERIOD-scoped (no entity/book), so the same gate
    // applies to every (entity, book) close for that period — the
    // org-wide "close GL" and "send packet to leadership" tasks block
    // the close regardless of which entity/book combination is being
    // closed. The recon-completion gate from Phase 1 PR 8 layers per-
    // (entity, book) on top of this when a controller wires it in.
    const taskBlockers = await checkRequiredTasksComplete(prisma, {
      tenantId: entity.tenantId,
      periodId: period.id,
    });
    if (taskBlockers.length > 0) {
      // Audit-log the refusal — close-attempts are SOC 2 CC5/CC6
      // evidence; we want the attempt visible in the audit trail
      // even when it's blocked at the gate.
      await auditPrivilegedAction({
        actor: admin,
        action: "close-period.refused",
        resource: "Period",
        resourceId: `${input.entityCode}/${input.bookCode}/${input.periodCode}`,
        tenantId: entity.tenantId,
        metadata: {
          reason: "close-task-blockers",
          blockerCount: taskBlockers.length,
          blockerTaskIds: taskBlockers.map((b) => b.id),
        },
      });
      return {
        ok: false,
        message: `Cannot close: ${taskBlockers.length} required task${taskBlockers.length === 1 ? "" : "s"} still open (${taskBlockers
          .slice(0, 3)
          .map((b) => b.name)
          .join(", ")}${taskBlockers.length > 3 ? ", ..." : ""})`,
        taskBlockers: taskBlockers.map((b) => ({
          id: b.id,
          name: b.name,
          status: b.status,
        })),
      };
    }

    const created = await prisma.periodClose.create({
      data: {
        tenantId: entity.tenantId,
        entityId: entity.id,
        bookId: book.id,
        periodId: period.id,
        closedBy: admin.email,
      },
      select: { closedAt: true, closedBy: true },
    });

    // SOC 2 CC5/CC6: every period close is a privileged action.
    // Captured in audit_log so quarterly access reviews can prove the
    // human-in-the-loop chain (who closed which period when).
    await auditPrivilegedAction({
      actor: admin,
      action: "close-period",
      resource: "Period",
      resourceId: `${input.entityCode}/${input.bookCode}/${input.periodCode}`,
      tenantId: entity.tenantId,
      metadata: { journalEntryCount: jeCount },
    });

    revalidatePath("/periods");
    revalidatePath("/reports/month-end");

    return {
      ok: true,
      message: `Period ${input.periodCode} closed on ${input.entityCode} / ${input.bookCode} (${jeCount} JE${jeCount === 1 ? "" : "s"} frozen).`,
      wasAlreadyClosed: false,
      closedAt: created.closedAt.toISOString(),
      closedBy: created.closedBy ?? undefined,
      journalEntryCount: jeCount,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      // requirePermitted wrote the ACCESS_DENIED row — same rule as the
      // PermissionDenied branch below. This used to log its own, which
      // is now a duplicate of the central one.
      return { ok: false, message: "You must be signed in." };
    }
    if (e instanceof PermissionDeniedError) {
      // requirePermitted already wrote the ACCESS_DENIED audit row —
      // don't double-log the same refusal here.
      return { ok: false, message: "Period close requires admin permission." };
    }
    return { ok: false, message: sanitizeActionError(e, "Unknown error") };
  }
}

export interface ReopenPeriodInput {
  entityCode: string;
  bookCode: string;
  periodCode: string;
  /**
   * Why the period is being reopened. REQUIRED — a reopen resurrects posting
   * on books that may already have been reported to stakeholders, so the
   * reason is recorded as an immutable fact (PeriodReopenLog + audit metadata).
   */
  reason: string;
}

export interface ReopenPeriodState {
  ok: boolean;
  message?: string;
  wasAlreadyOpen?: boolean;
}

export async function reopenPeriodAction(
  input: ReopenPeriodInput
): Promise<ReopenPeriodState> {
  try {
    const { user: admin, tenant } = await requirePermitted(
      "period.reopen",
      canClosePeriods
    );

    if (!input.entityCode || !input.bookCode || !input.periodCode) {
      return { ok: false, message: "entityCode, bookCode, and periodCode are all required" };
    }

    // A reopen must always carry a stated reason — this is the whole point of
    // the reopen-with-reason control. Gate before any lookup so an empty reason
    // never reaches the delete.
    const reason = input.reason?.trim();
    if (!reason) {
      return { ok: false, message: "A reason is required to reopen a closed period." };
    }

    // Phase 4b: see closePeriodAction above; tenant-pinned findFirst.
    const entity = await prisma.legalEntity.findFirst({
      where: { code: input.entityCode, tenantId: tenant.id },
      select: { id: true, tenantId: true },
    });
    if (!entity) return { ok: false, message: `Unknown entity: ${input.entityCode}` };

    const book = await prisma.book.findUnique({
      where: { code: input.bookCode },
      select: { id: true },
    });
    if (!book) return { ok: false, message: `Unknown book: ${input.bookCode}` };

    const period = await prisma.period.findFirst({
      where: {
        code: input.periodCode,
        calendar: { entityId: entity.id },
      },
      select: { id: true },
    });
    if (!period) {
      return {
        ok: false,
        message: `Unknown period: ${input.periodCode} for entity ${input.entityCode}`,
      };
    }

    const existing = await prisma.periodClose.findUnique({
      where: {
        entityId_bookId_periodId: {
          entityId: entity.id,
          bookId: book.id,
          periodId: period.id,
        },
      },
      select: { id: true },
    });

    if (!existing) {
      return {
        ok: true,
        message: `Period ${input.periodCode} was already open on ${input.entityCode} / ${input.bookCode}.`,
        wasAlreadyOpen: true,
      };
    }

    // Remove the close-lock AND record the reopen as an immutable fact in one
    // transaction — the period is never reopened without a durable, reasoned
    // history row. Codes + reopenedBy are denormalized so the log survives a
    // later period/entity deletion (same rationale as audit_log.actorEmail).
    await prisma.$transaction([
      prisma.periodClose.delete({ where: { id: existing.id } }),
      prisma.periodReopenLog.create({
        data: {
          tenantId: entity.tenantId,
          entityId: entity.id,
          bookId: book.id,
          entityCode: input.entityCode,
          bookCode: input.bookCode,
          periodCode: input.periodCode,
          reason,
          reopenedBy: admin.email,
        },
      }),
    ]);

    // SOC 2 CC5/CC6: reopen is a SIGNIFICANT privileged action (it
    // re-opens books that may have been used for stakeholder reporting).
    // Capture even more aggressively than close — including the reason.
    await auditPrivilegedAction({
      actor: admin,
      action: "reopen-period",
      resource: "Period",
      resourceId: `${input.entityCode}/${input.bookCode}/${input.periodCode}`,
      tenantId: entity.tenantId,
      metadata: { reason },
    });

    revalidatePath("/periods");
    revalidatePath("/reports/month-end");

    return {
      ok: true,
      message: `Period ${input.periodCode} reopened on ${input.entityCode} / ${input.bookCode}.`,
      wasAlreadyOpen: false,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      // See closePeriodAction — the central row covers this now.
      return { ok: false, message: "You must be signed in." };
    }
    if (e instanceof PermissionDeniedError) {
      // requirePermitted already wrote the ACCESS_DENIED audit row.
      return { ok: false, message: "Period reopen requires admin permission." };
    }
    return { ok: false, message: sanitizeActionError(e, "Unknown error") };
  }
}
