"use server";

// Server Actions for JE notes. Four endpoints, all tenant-scoped, all
// require an active user but NOT admin (notes are a team-collab feature;
// any member can leave one).
//
//   - createJournalEntryNoteAction:    add a note to a JE
//   - resolveJournalEntryNoteAction:   mark resolved (anyone in tenant)
//   - unresolveJournalEntryNoteAction: undo resolve (anyone in tenant)
//   - deleteJournalEntryNoteAction:    hard delete (author OR admin only)
//
// Audit: every action writes a PRIVILEGED_ACTION row. Notes are NOT
// ledger writes (no JE lines change), but a CPA leaving "verify this
// accrual" on the wrong entry could mislead a reviewer — so the audit
// trail captures who said what when.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  isAdmin,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import {
  auditPrivilegedAction,
  auditAccessDenied,
} from "@/lib/audit/log";

// ─── Create ────────────────────────────────────────────────────────────────

export interface CreateNoteInput {
  entryId: string;
  body: string;
}

export interface CreateNoteState {
  ok: boolean;
  message?: string;
  noteId?: string;
}

export async function createJournalEntryNoteAction(
  input: CreateNoteInput
): Promise<CreateNoteState> {
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

  const body = input.body?.trim() ?? "";
  if (body.length < 1 || body.length > 2000) {
    return { ok: false, message: "Note body must be 1–2000 chars." };
  }

  // Tenant-scoped: a forged entryId from another tenant returns "not found".
  const entry = await prisma.journalEntry.findFirst({
    where: { id: input.entryId, tenantId: tenant.id },
    select: { id: true, entryNumber: true },
  });
  if (!entry) {
    return { ok: false, message: "Journal entry not found in this tenant." };
  }

  const note = await prisma.journalEntryNote.create({
    data: {
      tenantId: tenant.id,
      entryId: entry.id,
      authorUserId: user.id,
      // Snapshot author email so the note's authorship survives even
      // if the User row gets deactivated / email changes.
      authorEmail: user.email,
      body,
    },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: user,
    action: "create-journal-entry-note",
    resource: "JournalEntryNote",
    resourceId: note.id,
    tenantId: tenant.id,
    metadata: {
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      bodyLength: body.length,
    },
  });

  revalidatePath(`/journal-entries/${entry.id}`);
  revalidatePath("/journal-entries");
  return { ok: true, noteId: note.id, message: "Note added." };
}

// ─── Resolve / Unresolve ───────────────────────────────────────────────────

export interface ToggleResolveInput {
  noteId: string;
}

export interface ToggleResolveState {
  ok: boolean;
  message?: string;
}

export async function resolveJournalEntryNoteAction(
  input: ToggleResolveInput
): Promise<ToggleResolveState> {
  return await toggleResolve(input.noteId, true);
}

export async function unresolveJournalEntryNoteAction(
  input: ToggleResolveInput
): Promise<ToggleResolveState> {
  return await toggleResolve(input.noteId, false);
}

async function toggleResolve(
  noteId: string,
  resolve: boolean
): Promise<ToggleResolveState> {
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

  // Tenant-scope the update via a compound where (updateMany with id +
  // tenantId match). Returns 0 if cross-tenant.
  const updated = await prisma.journalEntryNote.updateMany({
    where: { id: noteId, tenantId: tenant.id },
    data: resolve
      ? { resolvedAt: new Date(), resolvedBy: user.email }
      : { resolvedAt: null, resolvedBy: null },
  });
  if (updated.count === 0) {
    return { ok: false, message: "Note not found in this tenant." };
  }

  // Look up the note so we can revalidate the right entry's page.
  const note = await prisma.journalEntryNote.findUnique({
    where: { id: noteId },
    select: { entryId: true },
  });

  await auditPrivilegedAction({
    actor: user,
    action: resolve ? "resolve-journal-entry-note" : "unresolve-journal-entry-note",
    resource: "JournalEntryNote",
    resourceId: noteId,
    tenantId: tenant.id,
  });

  if (note) revalidatePath(`/journal-entries/${note.entryId}`);
  revalidatePath("/journal-entries");
  return { ok: true, message: resolve ? "Note resolved." : "Note reopened." };
}

// ─── Delete ────────────────────────────────────────────────────────────────

export interface DeleteNoteInput {
  noteId: string;
}

export interface DeleteNoteState {
  ok: boolean;
  message?: string;
}

export async function deleteJournalEntryNoteAction(
  input: DeleteNoteInput
): Promise<DeleteNoteState> {
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

  const note = await prisma.journalEntryNote.findFirst({
    where: { id: input.noteId, tenantId: tenant.id },
    select: { id: true, entryId: true, authorUserId: true, authorEmail: true },
  });
  if (!note) {
    return { ok: false, message: "Note not found in this tenant." };
  }

  // Permission: author OR admin can delete. Others can't (audit-trail
  // discipline — a passing CPA shouldn't be able to silently delete
  // someone else's review comment).
  const isAuthor = note.authorUserId === user.id;
  if (!isAuthor && !isAdmin(user)) {
    await auditAccessDenied({
      attemptedAction: "delete-journal-entry-note",
      reason: "Not author and not admin",
      resource: "JournalEntryNote",
      resourceId: note.id,
    });
    return {
      ok: false,
      message: "Only the note author (or an admin) can delete a note.",
    };
  }

  await prisma.journalEntryNote.delete({ where: { id: note.id } });

  await auditPrivilegedAction({
    actor: user,
    action: "delete-journal-entry-note",
    resource: "JournalEntryNote",
    resourceId: note.id,
    tenantId: tenant.id,
    metadata: { entryId: note.entryId, authorEmail: note.authorEmail },
  });

  revalidatePath(`/journal-entries/${note.entryId}`);
  revalidatePath("/journal-entries");
  return { ok: true, message: "Note deleted." };
}
