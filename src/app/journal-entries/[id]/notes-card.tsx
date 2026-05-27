"use client";

// Inline notes panel on the JE detail page. Shows existing notes + a
// textarea for adding a new one. Each note has resolve/unresolve and
// (for author or admin) delete controls.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  createJournalEntryNoteAction,
  resolveJournalEntryNoteAction,
  unresolveJournalEntryNoteAction,
  deleteJournalEntryNoteAction,
} from "@/app/actions/journal-entry-notes";

interface NoteForUI {
  id: string;
  body: string;
  authorEmail: string | null;
  authorUserId: string | null;
  resolvedAt: string | null; // ISO
  resolvedBy: string | null;
  createdAt: string; // ISO
}

interface Props {
  entryId: string;
  notes: NoteForUI[];
  /** Current user's id — to decide whether they can delete their own note. */
  currentUserId: string | null;
  /** Current user is admin — admins can delete any note. */
  currentUserIsAdmin: boolean;
}

export default function NotesCard({
  entryId,
  notes,
  currentUserId,
  currentUserIsAdmin,
}: Props) {
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleAdd() {
    setError(null);
    if (!body.trim()) return;
    startTransition(async () => {
      const r = await createJournalEntryNoteAction({ entryId, body });
      if (!r.ok) setError(r.message ?? "Add failed.");
      else {
        setBody("");
        router.refresh();
      }
    });
  }

  function handleToggleResolve(note: NoteForUI) {
    setError(null);
    startTransition(async () => {
      const r = note.resolvedAt
        ? await unresolveJournalEntryNoteAction({ noteId: note.id })
        : await resolveJournalEntryNoteAction({ noteId: note.id });
      if (!r.ok) setError(r.message ?? "Update failed.");
      else router.refresh();
    });
  }

  function handleDelete(note: NoteForUI) {
    setError(null);
    const ok = window.confirm("Delete this note? This cannot be undone.");
    if (!ok) return;
    startTransition(async () => {
      const r = await deleteJournalEntryNoteAction({ noteId: note.id });
      if (!r.ok) setError(r.message ?? "Delete failed.");
      else router.refresh();
    });
  }

  const unresolved = notes.filter((n) => !n.resolvedAt).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Notes
          {notes.length > 0 && (
            <Badge tone={unresolved > 0 ? "warning" : "neutral"}>
              {unresolved > 0 ? `${unresolved} open` : `${notes.length} resolved`}
            </Badge>
          )}
        </CardTitle>
        <span className="text-xs text-ink-500">
          Inline review comments. Don&apos;t change the entry; just flag follow-ups.
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {notes.length === 0 ? (
          <p className="text-sm text-ink-500">No notes yet.</p>
        ) : (
          <ul className="space-y-3">
            {notes.map((n) => {
              const resolved = !!n.resolvedAt;
              const canDelete =
                currentUserIsAdmin ||
                (currentUserId !== null && n.authorUserId === currentUserId);
              return (
                <li
                  key={n.id}
                  className={`rounded-md border p-3 ${
                    resolved
                      ? "border-ink-200 bg-ink-50 text-ink-500"
                      : "border-amber-200 bg-amber-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="text-xs text-ink-500 flex items-center gap-2">
                        <span className="font-medium text-ink-700">
                          {n.authorEmail ?? "unknown"}
                        </span>
                        <span>{formatDateTime(n.createdAt)}</span>
                        {resolved && (
                          <Badge tone="positive">
                            resolved by {n.resolvedBy ?? "—"} ·{" "}
                            {formatDateTime(n.resolvedAt!)}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm">{n.body}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => handleToggleResolve(n)}
                      >
                        {resolved ? "Reopen" : "Resolve"}
                      </Button>
                      {canDelete && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => handleDelete(n)}
                          className="text-negative"
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-col gap-2 border-t border-ink-200 pt-3">
          <label htmlFor="new-note" className="text-xs font-medium text-ink-700">
            Add a note
          </label>
          <textarea
            id="new-note"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Verify this accrual — looks doubled to me."
            className="w-full min-h-[80px] rounded-md border border-ink-200 bg-white p-2.5 text-sm focus:border-ink-300 focus:outline-none focus:ring-1 focus:ring-ink-300"
            maxLength={2000}
          />
          {error && <span className="text-xs text-negative">{error}</span>}
          <div className="flex items-center justify-between text-xs text-ink-500">
            <span>{body.length} / 2000</span>
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={pending || !body.trim()}
            >
              {pending ? "Adding…" : "Add note"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDateTime(iso: string): string {
  // Cheap relative-ish formatter. "May 26, 2026 · 3:47pm".
  const d = new Date(iso);
  const datePart = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart} · ${timePart}`;
}
