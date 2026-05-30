"use client";

// Withdraw button rendered on PENDING_APPROVAL entries when the
// current user is the submitter. Mirrors the reject UX (inline
// reason textarea) but the reason is OPTIONAL — a user withdrawing
// their own submission doesn't need to justify it to an approver.
//
// Visible only to the submitter. The parent page gates rendering by
// `entry.submittedById === currentUser.id`; the Server Action
// re-checks via the lifecycle module's NotSubmitterError.

import { useState, useTransition } from "react";
import { withdrawJournalEntryAction } from "@/app/actions/approve-journal-entry";

export function WithdrawAction({
  entryId,
  entryNumber,
}: {
  entryId: string;
  entryNumber: string;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmMode, setConfirmMode] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function handleWithdraw() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const r = await withdrawJournalEntryAction({
        entryId,
        reason: reason.trim() || undefined,
      });
      if (r.ok) {
        setSuccess(r.message ?? "Withdrawn");
        setConfirmMode(false);
        setReason("");
      } else {
        setError(r.message ?? "Failed");
      }
    });
  }

  return (
    <div className="rounded-md border border-ink-200 bg-ink-50 p-4">
      <div className="text-sm font-medium text-ink-900">
        Your submission is awaiting approval
      </div>
      <p className="mt-1 text-xs text-ink-600">
        Withdrawing voids {entryNumber} before any approver acts on it. The
        lines do not post. This action is reversible only by re-creating the
        entry from scratch.
      </p>

      {!confirmMode ? (
        <div className="mt-3">
          <button
            onClick={() => {
              setConfirmMode(true);
              setError(null);
            }}
            disabled={pending}
            className="h-8 inline-flex items-center rounded-md border border-ink-300 bg-white px-3 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
          >
            Withdraw…
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs font-medium text-ink-700">
            Reason (optional, for your own audit trail)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Wrong period — will repost dated Feb 28."
            className="w-full rounded-md border border-ink-300 px-3 py-2 text-xs focus:border-ink-500 focus:outline-none"
            disabled={pending}
          />
          <div className="flex gap-2">
            <button
              onClick={handleWithdraw}
              disabled={pending}
              className="h-8 inline-flex items-center rounded-md bg-ink-900 px-3 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {pending ? "Withdrawing..." : "Confirm withdraw"}
            </button>
            <button
              onClick={() => {
                setConfirmMode(false);
                setReason("");
                setError(null);
              }}
              disabled={pending}
              className="h-8 inline-flex items-center rounded-md border border-ink-300 bg-white px-3 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-2 text-xs text-red-700">{error}</div>}
      {success && <div className="mt-2 text-xs text-emerald-700">{success}</div>}
    </div>
  );
}
