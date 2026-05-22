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

    const entity = await prisma.legalEntity.findUnique({
      where: { code: input.entityCode },
      select: { id: true, code: true },
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

    const created = await prisma.periodClose.create({
      data: {
        entityId: entity.id,
        bookId: book.id,
        periodId: period.id,
        closedBy: admin.email,
      },
      select: { closedAt: true, closedBy: true },
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
      return { ok: false, message: "You must be signed in." };
    }
    if (e instanceof NotAuthorizedError) {
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
    await requireAdmin();

    if (!input.entityCode || !input.bookCode || !input.periodCode) {
      return { ok: false, message: "entityCode, bookCode, and periodCode are all required" };
    }

    const entity = await prisma.legalEntity.findUnique({
      where: { code: input.entityCode },
      select: { id: true },
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

    await prisma.periodClose.delete({ where: { id: existing.id } });

    revalidatePath("/periods");
    revalidatePath("/reports/month-end");

    return {
      ok: true,
      message: `Period ${input.periodCode} reopened on ${input.entityCode} / ${input.bookCode}.`,
      wasAlreadyOpen: false,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in." };
    }
    if (e instanceof NotAuthorizedError) {
      return { ok: false, message: "Period reopen requires admin permission." };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
