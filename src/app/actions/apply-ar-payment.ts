"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { applyArPayment } from "@/lib/accounting/sub-ledgers/ar";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";

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

    const item = await prisma.arOpenItem.findUniqueOrThrow({
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
      memo: `Payment from ${item.party.code}${item.referenceNumber ? ` (${item.referenceNumber})` : ""}`,
      source: "MANUAL",
      sourceRecordType: "Payment",
      sourceRecordId: `MANUAL-PMT-${item.id.slice(0, 8)}`,
      createdBy: currentUser.email,
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
