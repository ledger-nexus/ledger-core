"use server";

// Reclassify / correcting-entry Server Action.
//
// What it does: given an existing POSTED journal entry, post a NEW balanced
// 2-line correcting entry that moves `amount` from `fromAccountCode` to
// `toAccountCode`, link the new entry to the source via correctionOfId, and
// leave the source POSTED.
//
// This is a *correction*, not a *reversal*. A reversal negates an entry (source
// → REVERSED). A reclassification says "that amount belongs in a different
// account" — the original economic event still happened, so the source stays
// POSTED and the correcting entry is an additional adjusting entry. Real CPA
// workflow: an expense hit the wrong GL account; you move it without erasing the
// history of the original booking.
//
// Direction is DERIVED from the source's net position on the from-account, not
// supplied by the caller — so the debit/credit sides are always accounting-
// correct and we can't be told to reclass the wrong way. If the source net-
// DEBITED the from-account (expense/asset), we credit it out and debit the
// to-account; if it net-CREDITED (revenue/liability), the mirror. Deriving from
// the source also proves the from-account was actually part of that entry, and
// bounds the reclass to the amount the source booked there.
//
// v1 limitation: the bound is per-correction against the SOURCE entry's own net,
// not cumulative across prior corrections — so repeated calls could over-reclass
// the same amount. That path is intentional and auditable (every correction is a
// POSTED entry visible in the correctionOf lineage + the privileged-action log);
// cumulative enforcement is a follow-up, not part of this slice.
//
// Substrate guarantees we lean on (same as reverse-journal-entry):
//   - postJournalEntry refuses unbalanced entries (both lines are `amount`)
//   - postJournalEntry refuses writes against a closed period (the reclass
//     will fail loudly if the target period is closed)
//   - postJournalEntry validates the to-account exists, is active, in book scope
//   - correctionOfId is the schema link the audit trail / balance-change lineage
//     view follows back to the original

import { revalidatePath } from "next/cache";
import { Decimal } from "@/lib/utils/decimal";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { auditPrivilegedAction, auditAccessDenied } from "@/lib/audit/log";
import { prisma } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-context";

export interface ReclassifyJournalEntryInput {
  /** Source JE id. The reclassification references THIS entry. */
  id: string;
  /** GL account code the amount is currently booked to (must be in the source). */
  fromAccountCode: string;
  /** GL account code the amount should move to. */
  toAccountCode: string;
  /** Amount to move. Positive; must not exceed the source's net on `from`. */
  amount: string;
  /**
   * Document date for the correcting entry. ISO YYYY-MM-DD. Defaults to today.
   * Must land in an OPEN period — postJournalEntry rejects a closed one.
   */
  reclassDate?: string;
  /** Optional memo override; a descriptive default is used when omitted. */
  memo?: string;
}

export interface ReclassifyJournalEntryState {
  ok: boolean;
  message?: string;
  /** New correcting entry id (for redirect). */
  reclassId?: string;
  /** New correcting entry number (for the success toast). */
  reclassEntryNumber?: string;
}

export async function reclassifyJournalEntryAction(
  input: ReclassifyJournalEntryInput
): Promise<ReclassifyJournalEntryState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    await auditAccessDenied({
      attemptedAction: "reclassify-journal-entry",
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

  const fromAccountCode = input.fromAccountCode?.trim();
  const toAccountCode = input.toAccountCode?.trim();
  if (!fromAccountCode || !toAccountCode) {
    return { ok: false, message: "Both from- and to-account codes are required." };
  }
  if (fromAccountCode === toAccountCode) {
    return { ok: false, message: "From- and to-accounts must differ." };
  }

  // Parse the amount as Decimal — never a JS number for money.
  let amount: Decimal;
  try {
    amount = new Decimal(input.amount);
  } catch {
    return { ok: false, message: "Amount must be a valid number." };
  }
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    return { ok: false, message: "Amount must be positive." };
  }

  const reclassDate = input.reclassDate ? new Date(input.reclassDate) : new Date();
  if (isNaN(reclassDate.getTime())) {
    return { ok: false, message: "reclassDate must be a valid date (YYYY-MM-DD)." };
  }

  // Everything — source lookup + net computation + correcting post + the
  // correctionOfId link — runs inside withTenantContext so the SET LOCAL
  // app.current_tenant_id GUC reaches every read/write (RLS Phase 2b), and so
  // the source read is consistent with the writes in one transaction. The
  // tenant-scoped lookup is also defense in depth against a forged id.
  type ReclassOutcome =
    | { kind: "notFound" }
    | { kind: "wrongStatus"; entryNumber: string; status: string }
    | { kind: "fromNotInSource"; entryNumber: string }
    | { kind: "amountExceeds"; entryNumber: string; available: string }
    | {
        kind: "ok";
        reclassId: string;
        reclassEntryNumber: string;
        sourceEntryNumber: string;
      };

  let outcome: ReclassOutcome;
  try {
    outcome = await withTenantContext(prisma, tenant.id, async (tx) => {
      const source = await tx.journalEntry.findFirst({
        where: { id: input.id, tenantId: tenant.id },
        include: {
          entity: { select: { code: true } },
          book: { select: { code: true } },
          currency: { select: { code: true } },
          lines: {
            include: { account: { select: { code: true } } },
            orderBy: { lineNo: "asc" },
          },
        },
      });
      if (!source) {
        return { kind: "notFound" as const };
      }

      // Only a POSTED entry can be reclassified — a REVERSED/VOID/DRAFT entry
      // has no live balance to move, and reclassifying one would be nonsense.
      if (source.status !== "POSTED") {
        return {
          kind: "wrongStatus" as const,
          entryNumber: source.entryNumber,
          status: source.status,
        };
      }

      // Net position the source booked to the from-account. Positive = net
      // debit (expense/asset side); negative = net credit (revenue/liability).
      let fromNet = new Decimal(0);
      for (const l of source.lines) {
        if (l.account.code === fromAccountCode) {
          fromNet = fromNet
            .plus(new Decimal(l.debit.toString()))
            .minus(new Decimal(l.credit.toString()));
        }
      }
      if (fromNet.isZero()) {
        return { kind: "fromNotInSource" as const, entryNumber: source.entryNumber };
      }
      const available = fromNet.abs();
      if (amount.greaterThan(available)) {
        return {
          kind: "amountExceeds" as const,
          entryNumber: source.entryNumber,
          available: available.toFixed(2),
        };
      }

      // Move the amount out of `from` and into `to` on the correct side. If the
      // source net-debited `from`, credit it out / debit `to`; the mirror when
      // it net-credited. The result nets `from` down by `amount` and lands the
      // same `amount` in `to` — balanced by construction.
      const fromWasDebit = fromNet.isPositive();
      const amt = amount.toString();
      const lines = fromWasDebit
        ? [
            { accountCode: fromAccountCode, credit: amt, description: `Reclass out of ${fromAccountCode}` },
            { accountCode: toAccountCode, debit: amt, description: `Reclass into ${toAccountCode}` },
          ]
        : [
            { accountCode: fromAccountCode, debit: amt, description: `Reclass out of ${fromAccountCode}` },
            { accountCode: toAccountCode, credit: amt, description: `Reclass into ${toAccountCode}` },
          ];

      const reclass = await postJournalEntry(tx, {
        tenantId: tenant.id,
        entityCode: source.entity.code,
        bookCode: source.book.code,
        documentDate: reclassDate,
        postingDate: reclassDate,
        memo:
          input.memo?.trim() ||
          `Reclass of ${source.entryNumber}: ${fromAccountCode} → ${toAccountCode}`,
        currencyCode: source.currencyId,
        // Engine-composed lines (the human chose from/to/amount; the substrate
        // built the debits and credits). SYSTEM matches reverse-journal-entry;
        // the audit row records WHO triggered it.
        source: "SYSTEM",
        createdBy: user.email,
        ownerUserId: user.id,
        sourceSystem: "SUBSTRATE",
        sourceRecordType: "JournalEntry.reclass",
        sourceRecordId: source.id,
        lines,
      });

      // Link the correcting entry back to the source. Like reverse, the input
      // to postJournalEntry doesn't carry correctionOfId, so we patch it here —
      // same transaction, so the linkage is atomic with the create. The source
      // status is deliberately UNCHANGED (a correction supplements, not negates).
      await tx.journalEntry.update({
        where: { id: reclass.id },
        data: { correctionOfId: source.id },
      });

      return {
        kind: "ok" as const,
        reclassId: reclass.id,
        reclassEntryNumber: reclass.entryNumber,
        sourceEntryNumber: source.entryNumber,
      };
    });
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in." };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error during reclassification.",
    };
  }

  if (outcome.kind === "notFound") {
    return { ok: false, message: "Journal entry not found in this tenant." };
  }
  if (outcome.kind === "wrongStatus") {
    return {
      ok: false,
      message: `Only POSTED entries can be reclassified (this one is ${outcome.status}).`,
    };
  }
  if (outcome.kind === "fromNotInSource") {
    return {
      ok: false,
      message: `${outcome.entryNumber} has no balance on ${fromAccountCode} to reclassify.`,
    };
  }
  if (outcome.kind === "amountExceeds") {
    return {
      ok: false,
      message: `Amount exceeds the ${outcome.available} booked to ${fromAccountCode} in ${outcome.entryNumber}.`,
    };
  }

  await auditPrivilegedAction({
    actor: user,
    action: "reclassify-journal-entry",
    resource: "JournalEntry",
    resourceId: input.id,
    tenantId: tenant.id,
    metadata: {
      sourceEntryNumber: outcome.sourceEntryNumber,
      reclassEntryNumber: outcome.reclassEntryNumber,
      fromAccountCode,
      toAccountCode,
      amount: amount.toFixed(2),
      reclassDate: reclassDate.toISOString().slice(0, 10),
    },
  });

  revalidatePath("/journal-entries");
  revalidatePath(`/journal-entries/${input.id}`);
  revalidatePath(`/journal-entries/${outcome.reclassId}`);
  return {
    ok: true,
    reclassId: outcome.reclassId,
    reclassEntryNumber: outcome.reclassEntryNumber,
    message: `Reclassified ${amount.toFixed(2)} from ${fromAccountCode} to ${toAccountCode} → ${outcome.reclassEntryNumber}.`,
  };
}
