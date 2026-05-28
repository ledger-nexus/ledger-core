"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { canApproveJournalEntries } from "@/lib/auth/policy";
import { requireCurrentScope, NoScopeError } from "@/lib/scope";

export interface NewEntryDraftLine {
  accountCode: string;
  side: "DEBIT" | "CREDIT";
  amount: string;
  partyCode?: string;
  description?: string;
}

export type CreateJournalEntryState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; entryId: string; pendingApproval?: boolean }
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
  let isPending = false;

  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();
    // Maker-checker branching: if the tenant has requireJeApproval=true
    // AND the current user is not ADMIN+, the entry goes to
    // PENDING_APPROVAL instead of POSTED. ADMIN/OWNER bypass the queue
    // (they're the approvers; their own direct postings are trusted).
    const tenant = await getCurrentTenant();
    const tenantConfig = tenant
      ? await prisma.tenant.findUnique({
          where: { id: tenant.id },
          select: { requireJeApproval: true },
        })
      : null;
    const userIsApprover = tenant ? canApproveJournalEntries(tenant.role) : false;
    const requireApproval =
      (tenantConfig?.requireJeApproval ?? false) && !userIsApprover;

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

    const result = await postJournalEntry(prisma, {
      tenantId: scope.tenantId,
      entityCode: scope.entityCode,
      bookCode: scope.bookCode,
      documentDate: new Date(documentDateStr),
      memo,
      source,
      createdBy: user.email,
      ownerUserId: user.id,
      initialStatus: requireApproval ? "PENDING_APPROVAL" : "POSTED",
      submittedByUserId: requireApproval ? user.id : undefined,
      lines: lines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.side === "DEBIT" ? l.amount : undefined,
        credit: l.side === "CREDIT" ? l.amount : undefined,
        partyCode: l.partyCode || undefined,
        description: l.description || undefined,
      })),
    });
    entryId = result.id;
    isPending = requireApproval;
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, error: "You must be signed in to post a journal entry." };
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
  if (isPending) {
    revalidatePath("/journal-entries/pending");
  }
  revalidatePath("/", "layout");
  redirect(`/journal-entries/${entryId}`);
}
