"use server";

// Bank-feed Server Actions. These are deliberately THIN: each one
// authenticates, resolves the actor's tenant-verified scope (never a
// client-supplied tenant/entity), validates its input with Zod, invokes the
// matching domain command in @/lib/banking/commands, revalidates the page,
// and returns the command's result. All domain logic — scoped loads, atomic
// FOR_REVIEW claims, posting through postJournalEntry, the unique-index
// backstop, audit rows — lives in the commands, decoupled from FormData.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { requireCurrentScope, NoScopeError } from "@/lib/scope";
import {
  importBankCsvCommand,
  categorizeBankTransactionCommand,
  excludeBankTransactionCommand,
  matchBankTransactionCommand,
} from "@/lib/banking/commands";

export type ActionState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; message: string }
  | { ok: false; error: string };

/** Map auth/scope failures (and any unexpected throw) to an ActionState. */
function toActionError(e: unknown, fallback: string): ActionState {
  if (e instanceof NotAuthenticatedError) return { ok: false, error: "You must be signed in." };
  if (e instanceof NoScopeError) return { ok: false, error: "Pick an entity + book first." };
  return { ok: false, error: e instanceof Error ? e.message : fallback };
}

// ── Import ───────────────────────────────────────────────────────────────

const importSchema = z.object({
  bankAccountCode: z.string().min(1, "Pick the account this file is for."),
  csv: z.string().min(1, "The file is empty."),
});

export async function importBankCsvAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();
    const file = formData.get("csvFile");
    const csv =
      file instanceof File ? await file.text() : String(formData.get("csv") ?? "");
    const parsed = importSchema.safeParse({
      bankAccountCode: String(formData.get("bankAccountCode") ?? ""),
      csv,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
    }
    const result = await importBankCsvCommand(
      prisma,
      scope,
      { id: user.id, email: user.email },
      parsed.data
    );
    if (result.ok) revalidatePath("/banking");
    return result;
  } catch (e) {
    return toActionError(e, "Import failed.");
  }
}

// ── Categorize (posts the JE) ────────────────────────────────────────────

const categorizeSchema = z.object({
  id: z.string().uuid(),
  categoryAccountCode: z.string().min(1, "Pick a category."),
});

export async function categorizeBankTransactionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();
    const parsed = categorizeSchema.safeParse({
      id: String(formData.get("id") ?? ""),
      categoryAccountCode: String(formData.get("categoryAccountCode") ?? ""),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
    }
    const result = await categorizeBankTransactionCommand(
      prisma,
      scope,
      { id: user.id, email: user.email },
      parsed.data
    );
    if (result.ok) revalidatePath("/banking");
    return result;
  } catch (e) {
    return toActionError(e, "Categorize failed.");
  }
}

// ── Exclude ──────────────────────────────────────────────────────────────

const excludeSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().max(200).optional(),
});

export async function excludeBankTransactionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();
    const parsed = excludeSchema.safeParse({
      id: String(formData.get("id") ?? ""),
      reason: String(formData.get("reason") ?? "") || undefined,
    });
    if (!parsed.success) return { ok: false, error: "Invalid input." };
    const result = await excludeBankTransactionCommand(
      prisma,
      scope,
      { id: user.id, email: user.email },
      parsed.data
    );
    if (result.ok) revalidatePath("/banking");
    return result;
  } catch (e) {
    return toActionError(e, "Exclude failed.");
  }
}

// ── Match to an existing entry (no posting) ─────────────────────────────

const matchSchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
});

export async function matchBankTransactionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();
    const parsed = matchSchema.safeParse({
      id: String(formData.get("id") ?? ""),
      entryId: String(formData.get("entryId") ?? ""),
    });
    if (!parsed.success) return { ok: false, error: "Invalid input." };
    const result = await matchBankTransactionCommand(
      prisma,
      scope,
      { id: user.id, email: user.email },
      parsed.data
    );
    if (result.ok) revalidatePath("/banking");
    return result;
  } catch (e) {
    return toActionError(e, "Match failed.");
  }
}
