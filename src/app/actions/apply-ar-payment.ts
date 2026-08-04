"use server";

import { revalidatePath } from "next/cache";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { applyArPaymentInTx } from "@/lib/accounting/sub-ledgers/ar";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { requireCurrentTenant, NoTenantSelectedError } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-context";

export type ApplyArPaymentState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; entryNumber: string }
  | { ok: false; error: string };

// Server Action backing the per-row "Apply payment" form on /ar.
// Posts the cash receipt JE (Dr Cash, Cr AR) and then applies it to the
// open AR item. Wrapped in a try/catch so over-application or other
// validation errors surface inline.
//
// RLS Phase 2b (Class T migration — mirror of apply-ap-payment): the
// full action — AR open-item lookup + postJournalEntry + applyArPaymentInTx
// — runs inside withTenantContext. The SET LOCAL app.current_tenant_id
// GUC is scoped to the wrapping $transaction, so every read/write here
// will reach RLS policies once Phase 3 flips FORCE on. We call the INNER
// helper applyArPaymentInTx (not the outer applyArPayment) so the GUC
// propagates instead of being lost across a nested $transaction.
// See docs/architecture/rls-phase-2b-migration-guide.md → Class T.
export async function applyArPaymentAction(
  _prev: ApplyArPaymentState,
  formData: FormData
): Promise<ApplyArPaymentState> {
  try {
    const currentUser = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    const openItemId = String(formData.get("openItemId") ?? "");
    const cashAccountCode = String(formData.get("cashAccountCode") ?? "1000");
    const amount = String(formData.get("amount") ?? "0");
    const paymentDateStr = String(formData.get("paymentDate") ?? "");

    if (!openItemId) return { ok: false, error: "Missing open item id" };
    if (!paymentDateStr) return { ok: false, error: "Payment date is required" };
    const paymentDate = new Date(paymentDateStr);
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return { ok: false, error: "Amount must be positive" };
    }

    const result = await withTenantContext(prisma, tenant.id, async (tx) => {
      // SECURITY (pen-test fix): tenant-scope the lookup so a forged id
      // from another tenant returns null → "not found" (no cross-tenant
      // payment application). Belt + suspenders: this explicit tenantId
      // predicate keeps working even before RLS FORCE lands in Phase 3.
      const item = await tx.arOpenItem.findFirst({
        where: { id: openItemId, tenantId: tenant.id },
        include: {
          entity: { select: { code: true } },
          book: { select: { code: true } },
          party: { select: { code: true } },
        },
      });
      if (!item) {
        return { kind: "notFound" as const };
      }

      const entry = await postJournalEntry(tx, {
        tenantId: tenant.id,
        entityCode: item.entity.code,
        bookCode: item.book.code,
        currencyCode: item.currencyId,
        documentDate: paymentDate,
        memo: `Payment from ${item.party.code}${item.referenceNumber ? ` (${item.referenceNumber})` : ""}`,
        source: "MANUAL",
        sourceRecordType: "Payment",
        sourceRecordId: `MANUAL-PMT-${item.id.slice(0, 8)}`,
        createdBy: currentUser.email,
        ownerUserId: currentUser.id,
        lines: [
          { accountCode: cashAccountCode, debit: amount, description: "Cash receipt" },
          {
            accountCode: item.controlAccountCode,
            credit: amount,
            partyCode: item.party.code,
            description: `Apply payment — ${item.referenceNumber ?? item.id}`,
          },
        ],
      });

      await applyArPaymentInTx(tx, {
        openItemId,
        appliedByEntryId: entry.id,
        appliedAmount: amount,
        appliedDate: paymentDate,
      });

      return { kind: "ok" as const, entryNumber: entry.entryNumber };
    });

    if (result.kind === "notFound") {
      return { ok: false, error: "AR open item not found in this tenant." };
    }

    revalidatePath("/ar");
    revalidatePath("/", "layout");
    return { ok: true, entryNumber: result.entryNumber };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, error: e.message };
    }
    if (e instanceof NoTenantSelectedError) {
      return { ok: false, error: e.message };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error applying payment",
    };
  }
}
