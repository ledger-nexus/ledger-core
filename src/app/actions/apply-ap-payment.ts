"use server";

import { revalidatePath } from "next/cache";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { applyApPaymentInTx } from "@/lib/accounting/sub-ledgers/ap";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { requireCurrentTenant, NoTenantSelectedError } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-context";
import { sanitizeActionError } from "@/lib/actions/action-error";

export type ApplyApPaymentState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; entryNumber: string }
  | { ok: false; error: string };

// Mirror of apply-ar-payment for vendor payments: Dr AP, Cr Cash.
//
// SECURITY (pen-test fix): this action used to be unauthenticated AND
// did not tenant-scope the AP open-item lookup. A signed-in user from
// tenant A — or even an anonymous request crafted to hit this endpoint
// — could pay tenant B's AP item by submitting that item's id. Now:
// requires a signed-in user + active tenant, scopes the lookup by
// tenantId, stamps the actor on the JE.
//
// RLS Phase 2b (Class T migration reference): the entire transaction —
// the AP open-item read, postJournalEntry, applyApPaymentInTx — runs
// inside withTenantContext. The SET LOCAL app.current_tenant_id GUC is
// scoped to the wrapping $transaction, so every read/write here will
// reach RLS policies once Phase 3 flips FORCE on. We call the INNER
// helper applyApPaymentInTx (not the outer applyApPayment) so the
// GUC propagates instead of being lost across a nested $transaction.
// See docs/architecture/rls-phase-2b-migration-guide.md → Class T.
export async function applyApPaymentAction(
  _prev: ApplyApPaymentState,
  formData: FormData
): Promise<ApplyApPaymentState> {
  try {
    const user = await requireCurrentUser();
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
      // Tenant-scoped lookup — a forged id from another tenant returns null
      // → "not found" (no cross-tenant write). Belt + suspenders: this
      // explicit tenantId predicate keeps working even before RLS FORCE
      // lands in Phase 3.
      const item = await tx.apOpenItem.findFirst({
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
        memo: `Payment to ${item.party.code}${item.referenceNumber ? ` (${item.referenceNumber})` : ""}`,
        source: "MANUAL",
        sourceRecordType: "VendorPayment",
        sourceRecordId: `MANUAL-VPMT-${item.id.slice(0, 8)}`,
        createdBy: user.email,
        ownerUserId: user.id,
        lines: [
          {
            accountCode: item.controlAccountCode,
            debit: amount,
            partyCode: item.party.code,
            description: `Pay bill — ${item.referenceNumber ?? item.id}`,
          },
          { accountCode: cashAccountCode, credit: amount, description: "Cash payment" },
        ],
      });

      await applyApPaymentInTx(tx, {
        openItemId,
        appliedByEntryId: entry.id,
        appliedAmount: amount,
        appliedDate: paymentDate,
      });

      return { kind: "ok" as const, entryNumber: entry.entryNumber };
    });

    if (result.kind === "notFound") {
      return { ok: false, error: "AP open item not found in this tenant." };
    }

    revalidatePath("/ap");
    revalidatePath("/", "layout");
    return { ok: true, entryNumber: result.entryNumber };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, error: "You must be signed in to apply a vendor payment." };
    }
    if (e instanceof NoTenantSelectedError) {
      return { ok: false, error: e.message };
    }
    return {
      ok: false,
      error: sanitizeActionError(e, "Unknown error applying vendor payment"),
    };
  }
}
