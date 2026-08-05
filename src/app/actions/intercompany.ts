// Server Action — prepare the intercompany mirror of a posted entry.
//
// SOC 2 baseline:
// - CC6.3: gates on canPostJournalEntries via requirePermitted (the
//   mirror IS a journal-entry post, into a sibling entity of the same
//   tenant); refusals write ACCESS_DENIED audit rows.
// - CC6.1: tenant resolved from the session; the counterparty arrives
//   as an entity CODE and is resolved inside the tenant — a code from
//   another tenant is indistinguishable from a nonexistent one.
// - CC6.8: Zod on the input envelope.
// - CC7.2: an intercompany.prepare-mirror audit row on success (ids and
//   entry numbers, no amounts); postJournalEntry writes the RecordEvent.
//
// Approval parity: the mirror takes the SAME route the actor would get
// typing the entry by hand in the counterparty entity —
// resolveApprovalRoute with the mirror's total. Approvers post
// directly; non-approvers land in /journal-entries/pending.

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Decimal } from "@/lib/utils/decimal";

import { prisma } from "@/lib/db";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import {
  canPostJournalEntries,
  canApproveJournalEntries,
  PermissionDeniedError,
} from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { withTenantContext } from "@/lib/tenant-context";
import { resolveApprovalRoute } from "@/lib/accounting/approval-threshold";
import {
  prepareIntercompanyMirror,
  IntercompanyMirrorError,
} from "@/lib/accounting/intercompany";

const PrepareMirrorInputSchema = z.object({
  sourceEntryId: z.string().uuid(),
  counterpartyEntityCode: z
    .string()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9_-]+$/, "Invalid entity code"),
});

export type PrepareMirrorActionResult =
  | {
      ok: true;
      mirrorEntryId: string;
      entryNumber: string;
      status: "POSTED" | "PENDING_APPROVAL";
    }
  | { ok: false; error: string; blockers?: string[]; existingMirrorId?: string };

export async function prepareMirrorAction(
  input: z.infer<typeof PrepareMirrorInputSchema>
): Promise<PrepareMirrorActionResult> {
  const parsed = PrepareMirrorInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  try {
    const { user, tenant } = await requirePermitted(
      "journalEntry.post",
      canPostJournalEntries
    );

    // Routing input: the mirror's total equals the source's debit total
    // (amounts carry over 1:1, only sides flip).
    const [tenantConfig, sourceTotal] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { requireJeApproval: true, jeApprovalMinAmount: true },
      }),
      prisma.journalLine.aggregate({
        where: { entry: { id: parsed.data.sourceEntryId, tenantId: tenant.id } },
        _sum: { debit: true },
      }),
    ]);
    const route = resolveApprovalRoute({
      requireJeApproval: tenantConfig?.requireJeApproval ?? false,
      jeApprovalMinAmount: tenantConfig?.jeApprovalMinAmount
        ? new Decimal(tenantConfig.jeApprovalMinAmount.toString())
        : null,
      entryTotal: new Decimal(sourceTotal._sum.debit?.toString() ?? "0"),
      actorIsApprover: canApproveJournalEntries(tenant.role),
    });

    const result = await withTenantContext(prisma, tenant.id, (tx) =>
      prepareIntercompanyMirror(tx, {
        tenantId: tenant.id,
        sourceEntryId: parsed.data.sourceEntryId,
        counterpartyEntityCode: parsed.data.counterpartyEntityCode.toUpperCase(),
        route,
        actor: { id: user.id, email: user.email },
      })
    );

    await auditPrivilegedAction({
      actor: { id: user.id, email: user.email },
      action: "intercompany.prepare-mirror",
      resource: "JournalEntry",
      resourceId: result.mirrorEntryId,
      tenantId: tenant.id,
      metadata: {
        sourceEntryId: parsed.data.sourceEntryId,
        counterpartyEntityCode: result.counterpartyEntityCode,
        mirrorEntryNumber: result.entryNumber,
        route,
      },
    });

    revalidatePath(`/journal-entries/${parsed.data.sourceEntryId}`);
    revalidatePath(`/journal-entries/${result.mirrorEntryId}`);
    revalidatePath("/journal-entries");
    if (route === "PENDING_APPROVAL") {
      revalidatePath("/journal-entries/pending");
    }

    return {
      ok: true,
      mirrorEntryId: result.mirrorEntryId,
      entryNumber: result.entryNumber,
      status: result.status,
    };
  } catch (e) {
    if (e instanceof IntercompanyMirrorError) {
      return {
        ok: false,
        error: e.message,
        blockers: e.blockers.length > 0 ? e.blockers : undefined,
        existingMirrorId: e.existingMirrorId,
      };
    }
    if (e instanceof PermissionDeniedError || e instanceof NotAuthenticatedError) {
      return { ok: false, error: e.message };
    }
    throw e;
  }
}
