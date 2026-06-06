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
// Permission: both actions require requireAdmin. Period close is one of
// the highest-impact admin operations in an accounting system — it
// freezes the books for a (book, period) tuple — so the explicit gate
// is non-negotiable. Reopen is similarly gated because it can resurrect
// posting on a period that's already been reported on to stakeholders.
//
// Per-book independence: GAAP April can be closed while Tax April stays
// open. This is the whole point of multi-book — close on the schedule
// that matches each book's reporting cadence, not a global one.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  requireAdmin,
  NotAuthenticatedError,
  NotAuthorizedError,
} from "@/lib/auth/current-user";
import {
  auditPrivilegedAction,
  auditAccessDenied,
} from "@/lib/audit/log";
import { withTenantContext } from "@/lib/db/tenant-context";

// RLS Phase 2b migration note:
//   This action's first DB hit (entity lookup by code) intentionally
//   runs OUTSIDE withTenantContext — the entity's tenantId IS the
//   discriminator we need to set the GUC, so we can't have it set
//   before we read the entity.
//
//   Pre-existing security gap (unrelated to RLS): the entity lookup
//   is NOT tenant-scoped. A tenant-A admin invoking this with an
//   entityCode that exists in tenant-B's data would close tenant-B's
//   period. Phase 3 FORCE will mitigate this naturally (RLS rejects
//   the cross-tenant read), but the proper fix is to add
//   requireCurrentTenant() and scope the entity lookup. Tracked as
//   a known gap rather than entangled with the RLS migration.

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
}

export async function closePeriodAction(
  input: ClosePeriodInput
): Promise<ClosePeriodState> {
  try {
    const admin = await requireAdmin();

    if (!input.entityCode || !input.bookCode || !input.periodCode) {
      return { ok: false, message: "entityCode, bookCode, and periodCode are all required" };
    }

    // Phase 4b: legalEntity.code is unique per [tenantId, code]. Use
    // findFirst — admin auth check already ensures the caller has a
    // tenant, but we accept the entity belonging to any tenant the
    // admin has access to (rare cross-tenant admin scenarios).
    const entity = await prisma.legalEntity.findFirst({
      where: { code: input.entityCode },
      // tenantId pulled so the PeriodClose row is tenant-tagged.
      select: { id: true, code: true, tenantId: true },
    });
    if (!entity) return { ok: false, message: `Unknown entity: ${input.entityCode}` };

    // RLS Phase 2b: wrap the resolver chain + idempotency check + write
    // in one withTenantContext using the entity's tenantId. Book is a
    // shared-global per the RLS design (no tenantId column), so its lookup
    // is fine inside the GUC-scoped tx.
    type CloseOutcome =
      | { kind: "unknownBook" }
      | { kind: "unknownPeriod" }
      | { kind: "alreadyClosed"; closedAt: Date; closedBy: string | null }
      | { kind: "ok"; closedAt: Date; closedBy: string | null; bookCode: string; periodCode: string; jeCount: number };

    const outcome = await withTenantContext(entity.tenantId, async (tx): Promise<CloseOutcome> => {
      const book = await tx.book.findUnique({
        where: { code: input.bookCode },
        select: { id: true, code: true },
      });
      if (!book) return { kind: "unknownBook" };

      // Scope period lookup to the entity's calendar(s) — multiple entities
      // can have periods with the same code (e.g. "2026-05") on their own
      // calendars; without this scoping the action would close the wrong one.
      const period = await tx.period.findFirst({
        where: {
          code: input.periodCode,
          calendar: { entityId: entity.id },
        },
        select: { id: true, code: true },
      });
      if (!period) return { kind: "unknownPeriod" };

      // Idempotency: if already closed, return the existing close info.
      const existing = await tx.periodClose.findUnique({
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
          kind: "alreadyClosed",
          closedAt: existing.closedAt,
          closedBy: existing.closedBy,
        };
      }

      const jeCount = await tx.journalEntry.count({
        where: { entityId: entity.id, bookId: book.id, periodId: period.id },
      });

      const created = await tx.periodClose.create({
        data: {
          tenantId: entity.tenantId,
          entityId: entity.id,
          bookId: book.id,
          periodId: period.id,
          closedBy: admin.email,
        },
        select: { closedAt: true, closedBy: true },
      });

      return {
        kind: "ok",
        closedAt: created.closedAt,
        closedBy: created.closedBy,
        bookCode: book.code,
        periodCode: period.code,
        jeCount,
      };
    });

    if (outcome.kind === "unknownBook") {
      return { ok: false, message: `Unknown book: ${input.bookCode}` };
    }
    if (outcome.kind === "unknownPeriod") {
      return {
        ok: false,
        message: `Unknown period: ${input.periodCode} for entity ${input.entityCode}`,
      };
    }
    if (outcome.kind === "alreadyClosed") {
      return {
        ok: true,
        message: `Period ${input.periodCode} already closed on ${input.entityCode} / ${input.bookCode}.`,
        wasAlreadyClosed: true,
        closedAt: outcome.closedAt.toISOString(),
        closedBy: outcome.closedBy ?? undefined,
      };
    }

    const { closedAt, closedBy, jeCount } = outcome;

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
      closedAt: closedAt.toISOString(),
      closedBy: closedBy ?? undefined,
      journalEntryCount: jeCount,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      await auditAccessDenied({
        attemptedAction: "close-period",
        reason: "Not authenticated",
        resource: "Period",
        resourceId: `${input.entityCode}/${input.bookCode}/${input.periodCode}`,
      });
      return { ok: false, message: "You must be signed in." };
    }
    if (e instanceof NotAuthorizedError) {
      await auditAccessDenied({
        attemptedAction: "close-period",
        reason: "Not admin",
        resource: "Period",
        resourceId: `${input.entityCode}/${input.bookCode}/${input.periodCode}`,
      });
      return { ok: false, message: "Period close requires admin permission." };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface ReopenPeriodInput {
  entityCode: string;
  bookCode: string;
  periodCode: string;
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
    const admin = await requireAdmin();

    if (!input.entityCode || !input.bookCode || !input.periodCode) {
      return { ok: false, message: "entityCode, bookCode, and periodCode are all required" };
    }

    // Phase 4b: see closePeriodAction above; findFirst by code.
    const entity = await prisma.legalEntity.findFirst({
      where: { code: input.entityCode },
      select: { id: true, tenantId: true },
    });
    if (!entity) return { ok: false, message: `Unknown entity: ${input.entityCode}` };

    // RLS Phase 2b: mirror of close action — resolver chain + delete in
    // one withTenantContext using the entity's tenantId.
    type ReopenOutcome =
      | { kind: "unknownBook" }
      | { kind: "unknownPeriod" }
      | { kind: "alreadyOpen" }
      | { kind: "ok" };

    const outcome = await withTenantContext(entity.tenantId, async (tx): Promise<ReopenOutcome> => {
      const book = await tx.book.findUnique({
        where: { code: input.bookCode },
        select: { id: true },
      });
      if (!book) return { kind: "unknownBook" };

      const period = await tx.period.findFirst({
        where: {
          code: input.periodCode,
          calendar: { entityId: entity.id },
        },
        select: { id: true },
      });
      if (!period) return { kind: "unknownPeriod" };

      const existing = await tx.periodClose.findUnique({
        where: {
          entityId_bookId_periodId: {
            entityId: entity.id,
            bookId: book.id,
            periodId: period.id,
          },
        },
        select: { id: true },
      });
      if (!existing) return { kind: "alreadyOpen" };

      await tx.periodClose.delete({ where: { id: existing.id } });
      return { kind: "ok" };
    });

    if (outcome.kind === "unknownBook") {
      return { ok: false, message: `Unknown book: ${input.bookCode}` };
    }
    if (outcome.kind === "unknownPeriod") {
      return {
        ok: false,
        message: `Unknown period: ${input.periodCode} for entity ${input.entityCode}`,
      };
    }
    if (outcome.kind === "alreadyOpen") {
      return {
        ok: true,
        message: `Period ${input.periodCode} was already open on ${input.entityCode} / ${input.bookCode}.`,
        wasAlreadyOpen: true,
      };
    }

    // SOC 2 CC5/CC6: reopen is a SIGNIFICANT privileged action (it
    // re-opens books that may have been used for stakeholder reporting).
    // Capture even more aggressively than close.
    await auditPrivilegedAction({
      actor: admin,
      action: "reopen-period",
      resource: "Period",
      resourceId: `${input.entityCode}/${input.bookCode}/${input.periodCode}`,
      tenantId: entity.tenantId,
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
      await auditAccessDenied({
        attemptedAction: "reopen-period",
        reason: "Not authenticated",
        resource: "Period",
        resourceId: `${input.entityCode}/${input.bookCode}/${input.periodCode}`,
      });
      return { ok: false, message: "You must be signed in." };
    }
    if (e instanceof NotAuthorizedError) {
      await auditAccessDenied({
        attemptedAction: "reopen-period",
        reason: "Not admin",
        resource: "Period",
        resourceId: `${input.entityCode}/${input.bookCode}/${input.periodCode}`,
      });
      return { ok: false, message: "Period reopen requires admin permission." };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
