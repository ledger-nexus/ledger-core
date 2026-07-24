"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import {
  canPostJournalEntries,
  PermissionDeniedError,
} from "@/lib/auth/policy";
import { requireCurrentScope, NoScopeError } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-context";

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
//
// SECURITY (pen-test fix): this action used to be unauthenticated and
// did not enforce tenant scope on the JE write. Anyone with a forged
// scope cookie could post to any tenant's books. Now: requires a signed-
// in user, resolves their tenant-verified scope, threads tenantId into
// postJournalEntry, and stamps createdBy + ownerUserId from the actor.
export async function createJournalEntryAction(
  _prev: CreateJournalEntryState,
  formData: FormData
): Promise<CreateJournalEntryState> {
  let entryId: string;

  try {
    // MEMBER floor today (every membership can post) — the gate is the
    // seam where the read-only VIEWER role and maker-checker submission
    // land without touching this action's body again.
    const { user } = await requirePermitted(
      "journalEntry.post",
      canPostJournalEntries
    );
    const scope = await requireCurrentScope();

    const documentDateStr = String(formData.get("documentDate") ?? "");
    const memo = String(formData.get("memo") ?? "").trim();
    const linesJson = String(formData.get("linesJson") ?? "[]");

    // `source` is lineage, not input. This action exists to serve one
    // caller — the manual entry form — so an entry it posts is MANUAL by
    // definition, and we stamp that here rather than believe the client.
    //
    // It previously read the value from formData through a bare type
    // assertion (`String(...) as "MANUAL" | "SYSTEM" | ...`). Assertions
    // are erased at runtime, so this neither validated nor constrained
    // anything: the form offered SYSTEM and AI_APPROVED outright, and a
    // hand-rolled POST could pass SEED or IMPORT just as easily. Any of
    // them would land in the ledger as that entry's permanent story of
    // where it came from.
    //
    // That matters because AI_APPROVED is a claim about a control: it
    // asserts an AI proposed the entry and a human approved it (the
    // reference path is the FX revaluation gate). SYSTEM and IMPORT
    // likewise assert machine origin. A person typing debits and credits
    // into a form could stamp any of those on their own work, and the
    // audit trail would repeat it back to a reviewer as fact.
    const source = "MANUAL" as const;

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

    // RLS Phase 2b: wrap the JE post in withTenantContext so the
    // SET LOCAL app.current_tenant_id GUC reaches postJournalEntry's
    // writes. postJournalEntry already accepts both PrismaClient and
    // TransactionClient (ledger-core v1.11 contract — see CLAUDE.md),
    // so no helper widening is required. This is the simplest possible
    // RLS migration: ONE prisma call → wrap + swap.
    const result = await withTenantContext(prisma, scope.tenantId, async (tx) =>
      postJournalEntry(tx, {
        tenantId: scope.tenantId,
        entityCode: scope.entityCode,
        bookCode: scope.bookCode,
        documentDate: new Date(documentDateStr),
        memo,
        source,
        createdBy: user.email,
        ownerUserId: user.id,
        lines: lines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.side === "DEBIT" ? l.amount : undefined,
          credit: l.side === "CREDIT" ? l.amount : undefined,
          partyCode: l.partyCode || undefined,
          description: l.description || undefined,
        })),
      })
    );
    entryId = result.id;
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, error: "You must be signed in to post a journal entry." };
    }
    if (e instanceof PermissionDeniedError) {
      return { ok: false, error: "Your role can't post journal entries in this tenant." };
    }
    if (e instanceof NoScopeError) {
      return { ok: false, error: "No active scope — pick an entity + book first." };
    }
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
