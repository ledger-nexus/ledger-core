"use server";

// Recording — and withdrawing — an operator's decision that one GL line
// and one statement line are the same transaction.
//
// Auto-matching handles exact amounts close in time. What is left is
// judgement: a cheque split across two deposits, a fee posted net, a
// transposition someone recognises. The system cannot derive those, and
// a reconciliation that cannot record them forces the operator to sign
// off on a difference they have actually explained.
//
// SOC 2 baseline:
//   CC6.1 — tenant comes from the session; the reconciliation, the GL
//           line and the statement line are ALL re-verified inside that
//           tenant before anything is written, because all three ids
//           arrive from the client.
//   CC6.3 — gated on the same permission that prepares reconciliations;
//           refusals write an ACCESS_DENIED row.
//   CC6.8 — Zod on the envelope.
//   CC7.2 — every link and unlink writes a privileged-action audit row.
//           `decidedById` on the row itself is NOT NULL, so the ledger
//           carries the name even if the audit log is queried
//           separately.
//
// Amounts are deliberately NOT required to agree. Insisting they match
// would refuse precisely the cases this exists for; the reconciliation
// keeps reporting whatever difference remains, and an unequal pair
// simply nets what it nets.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import { canClosePeriods, PermissionDeniedError } from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { withTenantContext } from "@/lib/tenant-context";
import { sanitizeActionError } from "@/lib/actions/action-error";

const LinkInput = z.object({
  reconciliationId: z.string().uuid(),
  journalLineId: z.string().uuid(),
  bankTransactionId: z.string().uuid(),
  note: z.string().max(300).optional(),
});

const UnlinkInput = z.object({
  reconciliationId: z.string().uuid(),
  journalLineId: z.string().uuid(),
});

export type ManualMatchResult = { ok: true } | { ok: false; message: string };

export async function linkReconMatchAction(
  input: z.infer<typeof LinkInput>
): Promise<ManualMatchResult> {
  const parsed = LinkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.errors[0]?.message ?? "Invalid input." };
  }
  try {
    const { user, tenant } = await requirePermitted(
      "reconciliation.prepare",
      canClosePeriods
    );
    const data = parsed.data;

    const outcome = await withTenantContext(prisma, tenant.id, async (tx) => {
      // All three ids came from the client. Each is re-checked inside
      // the tenant, and the two lines are checked against THIS
      // reconciliation's account and entity — otherwise a caller could
      // pair rows belonging to a different account and "explain" a
      // difference with someone else's money.
      const recon = await tx.reconciliation.findFirst({
        where: { id: data.reconciliationId, tenantId: tenant.id },
        select: { id: true, accountId: true, entityId: true, bookId: true, status: true },
      });
      if (!recon) return { kind: "notFound" as const, what: "Reconciliation" };
      if (recon.status === "RECONCILED" || recon.status === "WAIVED") {
        return { kind: "closed" as const };
      }

      const line = await tx.journalLine.findFirst({
        where: {
          id: data.journalLineId,
          tenantId: tenant.id,
          accountId: recon.accountId,
          entry: { entityId: recon.entityId, bookId: recon.bookId },
        },
        select: { id: true },
      });
      if (!line) return { kind: "notFound" as const, what: "Journal line" };

      const stmt = await tx.bankTransaction.findFirst({
        where: {
          id: data.bankTransactionId,
          tenantId: tenant.id,
          bankAccountId: recon.accountId,
          entityId: recon.entityId,
          bookId: recon.bookId,
        },
        select: { id: true },
      });
      if (!stmt) return { kind: "notFound" as const, what: "Statement line" };

      try {
        await tx.reconciliationManualMatch.create({
          data: {
            tenantId: tenant.id,
            reconciliationId: recon.id,
            journalLineId: line.id,
            bankTransactionId: stmt.id,
            decidedById: user.id,
            note: data.note?.trim() || null,
          },
        });
      } catch {
        // The uniques: either side already claimed in this recon.
        return { kind: "alreadyMatched" as const };
      }
      return { kind: "ok" as const };
    });

    if (outcome.kind === "notFound") {
      return { ok: false, message: `${outcome.what} not found in this workspace.` };
    }
    if (outcome.kind === "closed") {
      return {
        ok: false,
        message: "This reconciliation is signed off — reopen it to change matches.",
      };
    }
    if (outcome.kind === "alreadyMatched") {
      return {
        ok: false,
        message: "One of those lines is already matched in this reconciliation.",
      };
    }

    await auditPrivilegedAction({
      actor: { id: user.id, email: user.email },
      action: "reconciliation.match-link",
      resource: "Reconciliation",
      resourceId: data.reconciliationId,
      tenantId: tenant.id,
      // Ids only — no amounts. The pair is identifiable without
      // putting money in the audit metadata.
      metadata: {
        journalLineId: data.journalLineId,
        bankTransactionId: data.bankTransactionId,
        hasNote: Boolean(data.note?.trim()),
      },
    });

    revalidatePath(`/close/reconciliations/${data.reconciliationId}`);
    return { ok: true };
  } catch (e) {
    return handleAuthError(e);
  }
}

export async function unlinkReconMatchAction(
  input: z.infer<typeof UnlinkInput>
): Promise<ManualMatchResult> {
  const parsed = UnlinkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.errors[0]?.message ?? "Invalid input." };
  }
  try {
    const { user, tenant } = await requirePermitted(
      "reconciliation.prepare",
      canClosePeriods
    );
    const data = parsed.data;

    // deleteMany with the tenant in the predicate: a forged
    // reconciliation id from another workspace deletes nothing rather
    // than reporting what exists.
    const deleted = await withTenantContext(prisma, tenant.id, async (tx) =>
      tx.reconciliationManualMatch.deleteMany({
        where: {
          tenantId: tenant.id,
          reconciliationId: data.reconciliationId,
          journalLineId: data.journalLineId,
        },
      })
    );
    if (deleted.count === 0) {
      return { ok: false, message: "That match no longer exists." };
    }

    await auditPrivilegedAction({
      actor: { id: user.id, email: user.email },
      action: "reconciliation.match-unlink",
      resource: "Reconciliation",
      resourceId: data.reconciliationId,
      tenantId: tenant.id,
      metadata: { journalLineId: data.journalLineId },
    });

    revalidatePath(`/close/reconciliations/${data.reconciliationId}`);
    return { ok: true };
  } catch (e) {
    return handleAuthError(e);
  }
}

function handleAuthError(e: unknown): ManualMatchResult {
  if (e instanceof NotAuthenticatedError) {
    return { ok: false, message: "You must be signed in." };
  }
  if (e instanceof PermissionDeniedError) {
    // requirePermitted already wrote the ACCESS_DENIED row.
    return { ok: false, message: "Matching requires reconciliation permission." };
  }
  return { ok: false, message: sanitizeActionError(e, "Unknown error") };
}
