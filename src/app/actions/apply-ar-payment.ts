"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { applyArPayment } from "@/lib/accounting/sub-ledgers/ar";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";

export type ApplyArPaymentState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; entryNumber: string }
  | { ok: false; error: string };

// Server Action backing the per-row "Apply payment" form on /ar.
// Posts the cash receipt JE (Dr Cash, Cr AR) and then applies it to the
// open AR item. Wrapped in a try/catch so over-application or other
// validation errors surface inline.
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

    // SECURITY (pen-test fix): tenant-scope the lookup so a forged id
    // from another tenant returns null → "not found" (no cross-tenant
    // payment application).
    const item = await prisma.arOpenItem.findFirst({
      where: { id: openItemId, tenantId: tenant.id },
      include: {
        entity: { select: { code: true } },
        book: { select: { code: true } },
        party: { select: { code: true } },
      },
    });
    if (!item) {
      return { ok: false, error: "AR open item not found in this tenant." };
    }

    const entry = await postJournalEntry(prisma, {
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

    await applyArPayment(prisma, {
      openItemId,
      appliedByEntryId: entry.id,
      appliedAmount: amount,
      appliedDate: paymentDate,
    });

    revalidatePath("/ar");
    revalidatePath("/", "layout");
    return { ok: true, entryNumber: entry.entryNumber };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, error: e.message };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error applying payment",
    };
  }
}
