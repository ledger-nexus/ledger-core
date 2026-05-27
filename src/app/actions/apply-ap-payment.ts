"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { applyApPayment } from "@/lib/accounting/sub-ledgers/ap";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";

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

    // Tenant-scoped lookup — a forged id from another tenant returns null
    // → "not found" (no cross-tenant write).
    const item = await prisma.apOpenItem.findFirst({
      where: { id: openItemId, tenantId: tenant.id },
      include: {
        entity: { select: { code: true } },
        book: { select: { code: true } },
        party: { select: { code: true } },
      },
    });
    if (!item) {
      return { ok: false, error: "AP open item not found in this tenant." };
    }

    const entry = await postJournalEntry(prisma, {
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

    await applyApPayment(prisma, {
      openItemId,
      appliedByEntryId: entry.id,
      appliedAmount: amount,
      appliedDate: paymentDate,
    });

    revalidatePath("/ap");
    revalidatePath("/", "layout");
    return { ok: true, entryNumber: entry.entryNumber };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, error: "You must be signed in to apply a vendor payment." };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error applying vendor payment",
    };
  }
}
