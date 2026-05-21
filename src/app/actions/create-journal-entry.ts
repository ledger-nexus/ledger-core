"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getScope } from "@/lib/scope";

export interface NewEntryDraftLine {
  accountCode: string;
  side: "DEBIT" | "CREDIT";
  amount: string;
  partyCode?: string;
  description?: string;
}

export type CreateJournalEntryState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; entryId: string }
  | { ok: false; error: string };

// Server Action backing the /journal-entries/new form. Receives the
// document metadata + a JSON-serialized lines array (the form's hidden
// input). Calls postJournalEntry inside a try/catch so the
// UnbalancedEntryError / InvalidLineError / UnknownAccountError messages
// surface inline.
export async function createJournalEntryAction(
  _prev: CreateJournalEntryState,
  formData: FormData
): Promise<CreateJournalEntryState> {
  let entryId: string;

  try {
    const documentDateStr = String(formData.get("documentDate") ?? "");
    const memo = String(formData.get("memo") ?? "").trim();
    const source = (String(formData.get("source") ?? "MANUAL") as
      | "MANUAL"
      | "SYSTEM"
      | "AI_APPROVED"
      | "SEED"
      | "IMPORT");
    const linesJson = String(formData.get("linesJson") ?? "[]");

    if (!documentDateStr) {
      return { ok: false, error: "Document date is required" };
    }
    if (!memo) {
      return { ok: false, error: "Memo is required" };
    }

    let lines: NewEntryDraftLine[];
    try {
      lines = JSON.parse(linesJson) as NewEntryDraftLine[];
    } catch {
      return { ok: false, error: "Lines payload is malformed" };
    }
    if (!Array.isArray(lines) || lines.length < 2) {
      return { ok: false, error: "Entry must have at least 2 lines" };
    }

    const scope = getScope();
    const result = await postJournalEntry(prisma, {
      entityCode: scope.entityCode,
      bookCode: scope.bookCode,
      documentDate: new Date(documentDateStr),
      memo,
      source,
      lines: lines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.side === "DEBIT" ? l.amount : undefined,
        credit: l.side === "CREDIT" ? l.amount : undefined,
        partyCode: l.partyCode || undefined,
        description: l.description || undefined,
      })),
    });
    entryId = result.id;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error during posting",
    };
  }

  // Outside the try block so the redirect's "internal" throw isn't caught
  // by our catch (Next.js handles it specially in the framework).
  revalidatePath("/journal-entries");
  revalidatePath("/", "layout");
  redirect(`/journal-entries/${entryId}`);
}
