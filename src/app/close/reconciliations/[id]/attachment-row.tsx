"use client";

// BlackLine arc — Phase 1 PR 5: one attachment row with delete.
//
// Renders the filename / metadata + a Download link and a Delete
// button. Delete is enabled for the uploader OR a tenant admin
// (server-side authorization is the source of truth; we render the
// button conditionally so non-deletable rows don't tease).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils/format";
import { deleteAttachment } from "@/app/actions/recon-attachments";

interface Props {
  reconId: string;
  attachment: {
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    uploadedAt: Date;
    uploader: { displayName: string | null } | null;
  };
  canDelete: boolean;
}

export default function AttachmentRow({
  reconId,
  attachment,
  canDelete,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleDelete() {
    const ok = window.confirm(
      `Delete attachment "${attachment.filename}"? This cannot be undone.`
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const r = await deleteAttachment({
        reconId,
        attachmentId: attachment.id,
      });
      if (!r.ok) {
        setError(r.error);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <li className="flex items-center justify-between rounded-md border border-ink-100 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-xs text-ink-900 truncate">
          {attachment.filename}
        </div>
        <div className="text-xs text-ink-500">
          {attachment.contentType} ·{" "}
          {(attachment.sizeBytes / 1024).toFixed(1)} KB · uploaded by{" "}
          {attachment.uploader?.displayName ?? "—"} on{" "}
          {formatDate(attachment.uploadedAt)}
        </div>
        {error && (
          <div className="mt-1 text-xs text-red-600">{error}</div>
        )}
      </div>
      <div className="flex items-center gap-2 pl-3">
        <a
          href={`/api/close/reconciliations/${reconId}/attachments/${attachment.id}/download`}
          className="text-xs text-accent-600 hover:underline"
        >
          Download
        </a>
        {canDelete && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={pending}
          >
            {pending ? "..." : "Delete"}
          </Button>
        )}
      </div>
    </li>
  );
}
