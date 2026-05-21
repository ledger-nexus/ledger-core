"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { applyApPayment } from "@/lib/accounting/sub-ledgers/ap";

export type ApplyApPaymentState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; entryNumber: string }
  | { ok: false; error: string };

// Mirror of apply-ar-payment for vendor payments: Dr AP, Cr Cash.
export async function applyApPaymentAction(
  _prev: ApplyApPaymentState,
  formData: FormData
): Promise<ApplyApPaymentState> {
  try {
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

    const item = await prisma.apOpenItem.findUniqueOrThrow({
      where: { id: openItemId },
      include: {
        entity: { select: { code: true } },
        book: { select: { code: true } },
        party: { select: { code: true } },
      },
    });

    const entry = await postJournalEntry(prisma, {
      entityCode: item.entity.code,
      bookCode: item.book.code,
      currencyCode: item.currencyId,
      documentDate: paymentDate,
      memo: `Payment to ${item.party.code}${item.referenceNumber ? ` (${item.referenceNumber})` : ""}`,
      source: "MANUAL",
      sourceRecordType: "VendorPayment",
      sourceRecordId: `MANUAL-VPMT-${item.id.slice(0, 8)}`,
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
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error applying vendor payment",
    };
  }
}
