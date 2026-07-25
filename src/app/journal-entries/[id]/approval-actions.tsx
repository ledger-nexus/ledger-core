"use client";

// Approve / Reject buttons rendered on PENDING_APPROVAL entries.
// Visible only to ADMIN+ in the current tenant (the parent page gates
// visibility); the Server Actions re-check the policy.
//
// Reject is two-stage: click "Reject" to expand an inline reason
// textarea, then click "Confirm reject" to fire the action. The reason
// is required by the lifecycle module.

import { useState, useTransition } from "react";
import {
  approveJournalEntryAction,
  rejectJournalEntryAction,
} from "@/app/actions/approve-journal-entry";

export function ApprovalActions({
  entryId,
  entryNumber,
}: {
  entryId: string;
  entryNumber: string;
}) {
  const [pending, startTransition] = useTransition();
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function handleApprove() {
    if (!confirm(`Approve ${entryNumber}? The entry will post to the ledger immediately.`)) return;
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const r = await approveJournalEntryAction({ entryId });
      if (r.ok) {
        setSuccess(r.message ?? "Approved");
      } else {
        setError(r.message ?? "Failed");
      }
    });
  }

  function handleReject() {
    if (!rejectReason.trim()) {
      setError("Enter a rejection reason so the submitter knows what to fix.");
      return;
    }
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const r = await rejectJournalEntryAction({
        entryId,
        reason: rejectReason.trim(),
      });
      if (r.ok) {
        setSuccess(r.message ?? "Rejected");
        setRejectMode(false);
        setRejectReason("");
      } else {
        setError(r.message ?? "Failed");
      }
    });
  }

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
      <div className="text-sm font-medium text-amber-900">
        This entry is pending approval
      </div>
      <p className="mt-1 text-xs text-amber-700">
        Review the lines below. Approving posts the entry to the ledger;
        rejecting voids it and notifies the submitter via the rejection
        reason.
      </p>

      {!rejectMode ? (
        <div className="mt-3 flex gap-2">
          <button
            onClick={handleApprove}
            disabled={pending}
            className="h-8 inline-flex items-center rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {pending ? "Approving..." : "Approve & post"}
          </button>
          <button
            onClick={() => {
              setRejectMode(true);
              setError(null);
            }}
            disabled={pending}
            className="h-8 inline-flex items-center rounded-md border border-red-300 bg-white px-3 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Reject…
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs font-medium text-amber-900">
            Rejection reason (required)
          </label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            placeholder="e.g. Account 4000 should be 4100 — please resubmit."
            className="w-full rounded-md border border-amber-300 px-3 py-2 text-xs focus:border-amber-500 focus:outline-none"
            disabled={pending}
          />
          <div className="flex gap-2">
            <button
              onClick={handleReject}
              disabled={pending || !rejectReason.trim()}
              className="h-8 inline-flex items-center rounded-md bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {pending ? "Rejecting..." : "Confirm reject"}
            </button>
            <button
              onClick={() => {
                setRejectMode(false);
                setRejectReason("");
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

      {error && (
        <div className="mt-2 text-xs text-red-700">{error}</div>
      )}
      {success && (
        <div className="mt-2 text-xs text-emerald-700">{success}</div>
      )}
    </div>
  );
}
