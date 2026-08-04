"use client";

// BlackLine arc — Phase 1 PR 5: attachment upload form.
//
// File picker → uploadAttachment Server Action. The action handles
// content-type + size validation server-side; we mirror the size
// guard client-side so the user gets instant feedback on a 50 MB
// misclick before the network round-trip.
//
// Built around <form action={uploadAttachment}> rather than
// useTransition, so the file streams through the FormData hydration
// path that Next.js's Server-Action runtime hardens.

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  uploadAttachment,
  MAX_ATTACHMENT_BYTES,
} from "@/app/actions/recon-attachments";
import { ATTACHMENT_ACCEPT_HINT } from "@/lib/recon/attachment-constants";

interface Props {
  reconId: string;
}

// Browser-side MIME mapping for the <input accept=...> attribute.
// Matches the server-side allowlist in recon-attachments.ts.
const ACCEPT =
  "application/pdf,image/png,image/jpeg,image/jpg,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export default function UploadForm({ reconId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setServerError(null);
    setClientError(null);
    const file = e.target.files?.[0];
    if (!file) {
      setFilename(null);
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setClientError(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; limit is 10 MB`
      );
      setFilename(null);
      return;
    }
    setFilename(file.name);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!inputRef.current?.files?.[0]) {
      setClientError("Choose a file to upload");
      return;
    }
    if (clientError) return;
    setServerError(null);

    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const r = await uploadAttachment(formData);
      if (!r.ok) {
        setServerError(r.error);
      } else {
        // Reset form on success. revalidatePath ran server-side so the
        // attachments list rerenders; nudge the router to flush the
        // server-component cache for this page.
        setFilename(null);
        if (formRef.current) formRef.current.reset();
        router.refresh();
      }
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="reconId" value={reconId} />
      <div>
        <label
          htmlFor="recon-attachment-file"
          className="block text-sm font-medium text-ink-900"
        >
          Add supporting document
        </label>
        <input
          ref={inputRef}
          id="recon-attachment-file"
          type="file"
          name="file"
          accept={ACCEPT}
          onChange={handleFileChange}
          disabled={pending}
          className="mt-1 block w-full text-sm text-ink-700 file:mr-3 file:rounded-md file:border-0 file:bg-ink-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-ink-800 disabled:opacity-50"
        />
        <div className="mt-1 text-xs text-ink-400">
          {ATTACHMENT_ACCEPT_HINT} · stored in Postgres with audit trail
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled={pending || !filename || !!clientError}
        >
          {pending ? "Uploading..." : "Upload"}
        </Button>
        {filename && !clientError && (
          <span className="text-xs text-ink-500">
            Ready: <span className="font-mono">{filename}</span>
          </span>
        )}
        {clientError && (
          <span className="text-xs text-red-600">{clientError}</span>
        )}
        {serverError && (
          <span className="text-xs text-red-600">{serverError}</span>
        )}
      </div>
    </form>
  );
}
