"use server";

// Reverse-JE Server Action.
//
// What it does: given an existing POSTED journal entry, post a NEW
// balanced JE with all lines sign-flipped (Dr → Cr, Cr → Dr), link the
// new entry to the source via reversalOfId, and flip the source's
// status from POSTED → REVERSED.
//
// Real CPA workflow: accruals booked on Dec 31 are reversed on Jan 1 of
// the next period. Manually re-keying flipped lines is error-prone and
// slow; this is one click.
//
// Substrate guarantees we lean on:
//   - postJournalEntry refuses unbalanced entries (it already does)
//   - postJournalEntry refuses writes against a closed period (it
//     already does — the reversal will fail loudly if Jan is closed)
//   - reversalOfId is the schema link recovery tools / audit reports
//     follow back to the original
//
// Idempotency: by design, the same source can be reversed once. The
// status flip ensures repeated calls hit the "already reversed" branch.
// A user who wants to UN-reverse can post a manual entry flipping the
// reversal — there's no "delete reversal" path because deleting GL
// entries is never the right answer.

import { revalidatePath } from "next/cache";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import {
  auditPrivilegedAction,
  auditAccessDenied,
} from "@/lib/audit/log";
import { prisma } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-context";

export interface ReverseJournalEntryInput {
  /** Source JE id. The reversal targets THIS entry. */
  id: string;
  /**
   * Document date for the reversal. ISO YYYY-MM-DD. Defaults to today.
   * In real-world accrual reversal, this is typically the first day of
   * the NEXT period — the UI defaults the picker to today but the user
   * can override.
   */
  reversalDate?: string;
}

export interface ReverseJournalEntryState {
  ok: boolean;
  message?: string;
  /** New reversal entry id (for redirect). */
  reversalId?: string;
  /** New reversal entry number (for the success toast). */
  reversalEntryNumber?: string;
}

export async function reverseJournalEntryAction(
  input: ReverseJournalEntryInput
): Promise<ReverseJournalEntryState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    await auditAccessDenied({
      attemptedAction: "reverse-journal-entry",
      reason: "Not authenticated",
      resource: "JournalEntry",
      resourceId: input.id,
    });
    return { ok: false, message: "You must be signed in." };
  }

  let tenant;
  try {
    tenant = await requireCurrentTenant();
  } catch {
    return { ok: false, message: "No active tenant." };
  }

  const reversalDate = input.reversalDate
    ? new Date(input.reversalDate)
    : new Date();
  if (isNaN(reversalDate.getTime())) {
    return { ok: false, message: "reversalDate must be a valid date (YYYY-MM-DD)." };
  }

  // RLS Phase 2b: wrap the full action — source lookup + reversal post +
  // status flip + reversalOfId link — in withTenantContext. The SET LOCAL
  // app.current_tenant_id GUC is scoped to the wrapping $transaction, so
  // every read/write here will reach RLS policies once Phase 3 flips FORCE
  // on. Read-then-write atomicity also tightens: the source's status is
  // re-read inside the same tx as the writes, so the
  // POSTED-→-REVERSED-→-POSTED race is impossible.
  //
  // Tenant-scoped lookup retained as defense in depth.
  type ReverseOutcome =
    | { kind: "notFound" }
    | { kind: "alreadyReversed"; entryNumber: string }
    | { kind: "wrongStatus"; entryNumber: string; status: string }
    | { kind: "ok"; reversalId: string; reversalEntryNumber: string; sourceEntryNumber: string; lineCount: number };

  let outcome: ReverseOutcome;
  try {
    outcome = await withTenantContext(prisma, tenant.id, async (tx) => {
      const source = await tx.journalEntry.findFirst({
        where: { id: input.id, tenantId: tenant.id },
        include: {
          entity: { select: { code: true } },
          book: { select: { code: true } },
          currency: { select: { code: true } },
          lines: {
            include: {
              account: { select: { code: true } },
              party: { select: { code: true } },
              item: { select: { code: true } },
            },
            orderBy: { lineNo: "asc" },
          },
        },
      });
      if (!source) {
        return { kind: "notFound" as const };
      }

      // Status discipline — inside the tx so the read is consistent with the writes.
      if (source.status === "REVERSED") {
        return { kind: "alreadyReversed" as const, entryNumber: source.entryNumber };
      }
      if (source.status !== "POSTED") {
        return {
          kind: "wrongStatus" as const,
          entryNumber: source.entryNumber,
          status: source.status,
        };
      }

      // Sign-flip every line. We swap debit ↔ credit. partyCode and itemCode
      // come along verbatim — a reversal preserves the dimensional context
      // of the original entry.
      const flippedLines = source.lines.map((l) => ({
        accountCode: l.account.code,
        debit: l.credit.toString(),
        credit: l.debit.toString(),
        description: l.description ?? undefined,
        partyCode: l.party?.code,
        itemCode: l.item?.code,
      }));

      const reversal = await postJournalEntry(tx, {
        tenantId: tenant.id,
        entityCode: source.entity.code,
        bookCode: source.book.code,
        documentDate: reversalDate,
        postingDate: reversalDate,
        memo: `Reversal of ${source.entryNumber}: ${source.memo}`,
        currencyCode: source.currencyId,
        // Reversal entries are SYSTEM (the engine wrote them, not a
        // human directly). The audit trail records WHO triggered it.
        source: "SYSTEM",
        createdBy: user.email,
        ownerUserId: user.id,
        sourceSystem: "SUBSTRATE",
        sourceRecordType: "JournalEntry.reversal",
        sourceRecordId: source.id,
        lines: flippedLines,
      });

      await tx.journalEntry.update({
        where: { id: source.id },
        data: { status: "REVERSED" },
      });

      // Link the new entry back to the source. postJournalEntry doesn't
      // currently accept reversalOfId in its input — we patch it here
      // after the post (same transaction, so the linkage is atomic with
      // the create + status flip).
      await tx.journalEntry.update({
        where: { id: reversal.id },
        data: { reversalOfId: source.id },
      });

      return {
        kind: "ok" as const,
        reversalId: reversal.id,
        reversalEntryNumber: reversal.entryNumber,
        sourceEntryNumber: source.entryNumber,
        lineCount: source.lines.length,
      };
    });
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in." };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error during reversal.",
    };
  }

  if (outcome.kind === "notFound") {
    return { ok: false, message: "Journal entry not found in this tenant." };
  }
  if (outcome.kind === "alreadyReversed") {
    return {
      ok: false,
      message: `${outcome.entryNumber} is already reversed. Reverse only happens once per entry.`,
    };
  }
  if (outcome.kind === "wrongStatus") {
    return {
      ok: false,
      message: `Only POSTED entries can be reversed (this one is ${outcome.status}).`,
    };
  }

  await auditPrivilegedAction({
    actor: user,
    action: "reverse-journal-entry",
    resource: "JournalEntry",
    resourceId: input.id,
    tenantId: tenant.id,
    metadata: {
      sourceEntryNumber: outcome.sourceEntryNumber,
      reversalEntryNumber: outcome.reversalEntryNumber,
      reversalDate: reversalDate.toISOString().slice(0, 10),
      lineCount: outcome.lineCount,
    },
  });

  revalidatePath("/journal-entries");
  revalidatePath(`/journal-entries/${input.id}`);
  revalidatePath(`/journal-entries/${outcome.reversalId}`);
  return {
    ok: true,
    reversalId: outcome.reversalId,
    reversalEntryNumber: outcome.reversalEntryNumber,
    message: `Reversed ${outcome.sourceEntryNumber} → ${outcome.reversalEntryNumber} on ${reversalDate.toISOString().slice(0, 10)}.`,
  };
}
