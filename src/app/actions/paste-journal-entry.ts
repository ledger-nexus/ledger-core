"use server";

// Server Action behind the /journal-entries/paste flow. Two endpoints:
//
//   - previewPastedEntryAction({ pastedText }) — pure parse, returns a
//     preview the user can review before committing. No DB write.
//
//   - postPastedEntryAction({ pastedText, entityCode, bookCode,
//     documentDate, memo }) — re-parses (fresh validation) and posts the
//     JE via postJournalEntry. Same boundary every manual JE uses.
//
// Separating preview from post lets the UI show the parsed lines + the
// balance check before the user commits — a real CPA habit (eyeball the
// rows before pressing OK).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { parsePastedLines, type ParsedLine } from "@/lib/accounting/paste-parser";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";

// ─── Preview ───────────────────────────────────────────────────────────────

export interface PreviewPastedEntryInput {
  pastedText: string;
}

export interface PreviewPastedEntryState {
  ok: boolean;
  message?: string;
  /** Display-safe line array — Decimals become strings for client transport. */
  lines?: Array<{
    rowNumber: number;
    accountCode: string;
    debit: string;
    credit: string;
    description?: string;
    partyCode?: string;
    itemCode?: string;
  }>;
  debitTotal?: string;
  creditTotal?: string;
  difference?: string;
  isBalanced?: boolean;
  warnings?: string[];
  errors?: string[];
  hadHeader?: boolean;
}

export async function previewPastedEntryAction(
  input: PreviewPastedEntryInput
): Promise<PreviewPastedEntryState> {
  // No auth gate on preview itself — it's a pure parse with no DB hit.
  // The POST action gates auth + tenant.
  const r = parsePastedLines(input.pastedText ?? "");
  return {
    ok: r.errors.length === 0 && r.isBalanced,
    lines: r.lines.map((l) => ({
      rowNumber: l.rowNumber,
      accountCode: l.accountCode,
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
      description: l.description,
      partyCode: l.partyCode,
      itemCode: l.itemCode,
    })),
    debitTotal: r.debitTotal.toFixed(2),
    creditTotal: r.creditTotal.toFixed(2),
    difference: r.difference.toFixed(2),
    isBalanced: r.isBalanced,
    warnings: r.warnings,
    errors: r.errors,
    hadHeader: r.hadHeader,
  };
}

// ─── Post ──────────────────────────────────────────────────────────────────

export interface PostPastedEntryInput {
  pastedText: string;
  entityCode: string;
  bookCode: string;
  /** ISO "YYYY-MM-DD". */
  documentDate: string;
  memo: string;
}

export interface PostPastedEntryState {
  ok: boolean;
  message?: string;
  entryId?: string;
  entryNumber?: string;
}

export async function postPastedEntryAction(
  input: PostPastedEntryInput
): Promise<PostPastedEntryState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return { ok: false, message: "You must be signed in." };
  }
  let tenant;
  try {
    tenant = await requireCurrentTenant();
  } catch {
    return { ok: false, message: "No active tenant." };
  }

  // Validate form fields.
  const memo = input.memo?.trim() ?? "";
  if (memo.length < 1 || memo.length > 500) {
    return { ok: false, message: "Memo must be 1–500 chars." };
  }
  if (!input.entityCode || !input.bookCode) {
    return { ok: false, message: "entityCode and bookCode are required." };
  }
  if (!input.documentDate) {
    return { ok: false, message: "documentDate is required." };
  }
  const docDate = new Date(input.documentDate);
  if (isNaN(docDate.getTime())) {
    return { ok: false, message: "documentDate must be a valid date (YYYY-MM-DD)." };
  }

  // Re-parse on the server (don't trust whatever preview the client
  // rendered — server is the source of truth).
  const parsed = parsePastedLines(input.pastedText ?? "");
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      message: `Cannot post: ${parsed.errors[0]}${parsed.errors.length > 1 ? ` (+${parsed.errors.length - 1} more)` : ""}`,
    };
  }
  if (!parsed.isBalanced) {
    return {
      ok: false,
      message: `Cannot post: unbalanced (debits ${parsed.debitTotal.toFixed(2)} ≠ credits ${parsed.creditTotal.toFixed(2)}).`,
    };
  }

  // Post via the substrate. tenantId passed so postJournalEntry's
  // Phase-4b-aware lookup scopes correctly.
  try {
    const result = await postJournalEntry(prisma, {
      tenantId: tenant.id,
      entityCode: input.entityCode,
      bookCode: input.bookCode,
      documentDate: docDate,
      memo,
      source: "MANUAL",
      createdBy: user.email,
      ownerUserId: user.id,
      lines: parsed.lines.map((l: ParsedLine) => ({
        accountCode: l.accountCode,
        debit: l.debit.greaterThan(0) ? l.debit.toFixed(4) : undefined,
        credit: l.credit.greaterThan(0) ? l.credit.toFixed(4) : undefined,
        description: l.description,
        partyCode: l.partyCode,
        itemCode: l.itemCode,
      })),
    });
    revalidatePath("/journal-entries");
    return {
      ok: true,
      entryId: result.id,
      entryNumber: result.entryNumber,
      message: `Posted ${result.entryNumber} with ${parsed.lines.length} lines.`,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error during posting",
    };
  }
}
