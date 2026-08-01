"use client";

// Client component for the data-subject-request actions: Export
// (downloads JSON bundle) and Erase (confirms + redacts PII).

import { useState, useTransition } from "react";
import {
  exportUserDataAction,
  eraseUserPiiAction,
} from "@/app/actions/data-subject-request";
import type { DataExportBundle } from "@/lib/privacy/user-data";

export function DataSubjectActions({
  subjectUserId,
  subjectEmail,
  subjectDisplayName,
  isSelf,
  canErase,
  isOwnerRole,
}: {
  subjectUserId: string;
  subjectEmail: string;
  subjectDisplayName: string;
  isSelf: boolean;
  canErase: boolean;
  isOwnerRole: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleExport() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await exportUserDataAction(subjectUserId);
      if (!r.ok || !r.payload) {
        setError(r.message ?? "Export failed");
        return;
      }
      // Trigger download — JSON blob, filename includes user id + date
      // for traceability when multiple requests pile up.
      downloadBundle(r.payload, subjectEmail);
      setMessage(r.message ?? "Exported");
    });
  }

  function handleErase() {
    if (eraseConfirm.toLowerCase() !== subjectEmail.toLowerCase()) {
      setError(
        `Type the user's email exactly to confirm: ${subjectEmail}`
      );
      return;
    }
    if (
      !confirm(
        `Erase PII for ${subjectDisplayName} (${subjectEmail})?\n\n` +
          `This action is IRREVERSIBLE. The user will no longer be able to sign in.\n` +
          `Their journal entries and audit log attribution will be PRESERVED ` +
          `(legal retention exemption), but their email and display name will be ` +
          `replaced with redacted values.`
      )
    )
      return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await eraseUserPiiAction(subjectUserId);
      if (!r.ok) {
        setError(r.message ?? "Erasure failed");
        return;
      }
      setMessage(r.message ?? "Erased");
      setEraseConfirm("");
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={handleExport}
          disabled={pending}
          className="h-7 inline-flex items-center rounded-md border border-ink-300 bg-white px-2.5 text-[11px] font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          {pending ? "Exporting..." : isSelf ? "Export my data" : "Export…"}
        </button>
        {canErase && (
          <details className="inline-block">
            <summary className="h-7 inline-flex items-center rounded-md border border-red-300 bg-white px-2.5 text-[11px] font-medium text-red-700 hover:bg-red-50 cursor-pointer">
              Erase PII…
            </summary>
            <div className="mt-2 flex flex-col gap-1 rounded-md border border-red-200 bg-red-50 p-2">
              <label className="text-[11px] text-red-900">
                Type the user's email to confirm:
              </label>
              <input
                type="text"
                value={eraseConfirm}
                onChange={(e) => setEraseConfirm(e.target.value)}
                placeholder={subjectEmail}
                disabled={pending}
                className="rounded-md border border-red-300 px-2 py-1 text-[11px] font-mono"
              />
              <button
                type="button"
                onClick={handleErase}
                disabled={pending || eraseConfirm.length === 0}
                className="h-7 inline-flex items-center justify-center rounded-md bg-red-600 px-2.5 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {pending ? "Erasing..." : "Confirm erase"}
              </button>
              <p className="text-[10px] text-red-700">
                Irreversible. Audit-logged. Financial records keep the
                user_id pointer; only the User row + email deliveries
                get redacted.
              </p>
            </div>
          </details>
        )}
      </div>

      {message && (
        <div className="text-[11px] text-emerald-700">{message}</div>
      )}
      {error && <div className="text-[11px] text-red-700">{error}</div>}

      {!canErase && !isSelf && !isOwnerRole && (
        <p className="text-[10px] text-ink-500">
          Erasure requires OWNER. You can still export.
        </p>
      )}
    </div>
  );
}

// Trigger a JSON file download in the browser.
function downloadBundle(bundle: DataExportBundle, subjectEmail: string) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const safeEmail = subjectEmail.replace(/[^a-zA-Z0-9._-]/g, "_");
  const date = bundle.exportedAt.slice(0, 10);
  const filename = `data-subject-export-${safeEmail}-${date}.json`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
