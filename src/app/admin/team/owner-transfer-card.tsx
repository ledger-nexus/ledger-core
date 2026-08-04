"use client";

// Ownership transfer UI surface. Three render states:
//
//   1. No transfer pending + I am OWNER → "Transfer ownership..." dropdown
//   2. Transfer pending + I am OWNER (initiator) → status + "Cancel" button
//   3. Transfer pending + I am the TARGET → "Accept" + "Decline" buttons
//
// Members who are neither OWNER nor the pending target see nothing —
// the parent page just doesn't render this card for them. Auth is
// enforced server-side on every action.

import { useState, useTransition } from "react";
import {
  initiateOwnerTransferAction,
  acceptOwnerTransferAction,
  cancelOwnerTransferAction,
} from "@/app/actions/owner-transfer";

interface MemberOption {
  id: string;
  email: string;
  displayName: string;
}

export function OwnerTransferCard({
  mode,
  candidates,
  targetEmail,
  targetDisplayName,
  initiatedAt,
}: {
  mode: "OWNER_NO_PENDING" | "OWNER_PENDING" | "TARGET_PENDING";
  /** Active non-OWNER members; only used in OWNER_NO_PENDING mode. */
  candidates?: MemberOption[];
  /** Target email/name; used in OWNER_PENDING + TARGET_PENDING. */
  targetEmail?: string;
  targetDisplayName?: string;
  initiatedAt?: Date | string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string>(
    candidates?.[0]?.id ?? ""
  );

  function handleInitiate() {
    if (!selectedTargetId) {
      setError("Pick a member to transfer ownership to.");
      return;
    }
    const target = candidates?.find((c) => c.id === selectedTargetId);
    const confirmMessage =
      `Offer ownership of this workspace to ${target?.email ?? "this member"}?\n\n` +
      `They must accept before the swap happens. You'll be demoted to ADMIN once they accept.`;
    if (!confirm(confirmMessage)) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await initiateOwnerTransferAction(selectedTargetId);
      if (r.ok) setMessage(r.message ?? "Offered");
      else setError(r.message ?? "Failed");
    });
  }

  function handleAccept() {
    if (!confirm("Accept ownership? You'll become OWNER; the current OWNER will become ADMIN.")) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await acceptOwnerTransferAction();
      if (r.ok) setMessage(r.message ?? "Accepted");
      else setError(r.message ?? "Failed");
    });
  }

  function handleCancel() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await cancelOwnerTransferAction();
      if (r.ok) setMessage(r.message ?? "Cancelled");
      else setError(r.message ?? "Failed");
    });
  }

  const initiatedAtLabel = initiatedAt
    ? new Date(initiatedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : null;

  if (mode === "OWNER_NO_PENDING") {
    if (!candidates || candidates.length === 0) {
      return (
        <div className="text-xs text-ink-500">
          Invite another member first — ownership can only be transferred to
          an existing active member of this workspace.
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <label htmlFor="owner-transfer-target" className="text-xs font-medium text-ink-700">
          Transfer ownership to
        </label>
        <div className="flex items-center gap-2">
          <select
            id="owner-transfer-target"
            value={selectedTargetId}
            onChange={(e) => setSelectedTargetId(e.target.value)}
            disabled={pending}
            className="h-8 rounded-md border border-ink-300 px-2 text-xs focus:border-ink-500 focus:outline-none"
          >
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} ({c.email})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleInitiate}
            disabled={pending}
            className="h-8 inline-flex items-center rounded-md border border-ink-300 bg-white px-3 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
          >
            {pending ? "Offering..." : "Offer transfer…"}
          </button>
        </div>
        <p className="text-[11px] text-ink-500">
          The recipient must accept the offer before the swap happens. You stay
          OWNER until then, and you can cancel at any time. After acceptance,
          you become ADMIN.
        </p>
        {message && <div className="text-[11px] text-emerald-700">{message}</div>}
        {error && <div className="text-[11px] text-negative">{error}</div>}
      </div>
    );
  }

  if (mode === "OWNER_PENDING") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
        <div className="text-xs font-medium text-amber-900">
          Transfer pending
        </div>
        <p className="text-[11px] text-amber-800">
          You&rsquo;ve offered ownership to{" "}
          <span className="font-medium">{targetDisplayName}</span>{" "}
          (<span className="font-mono">{targetEmail}</span>)
          {initiatedAtLabel && (
            <> on <span className="font-mono">{initiatedAtLabel}</span></>
          )}
          . They must accept from their /admin/team view to complete the
          hand-off. You can cancel before then.
        </p>
        <div>
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="h-7 inline-flex items-center rounded-md border border-amber-300 bg-white px-2.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            {pending ? "Cancelling..." : "Cancel transfer"}
          </button>
        </div>
        {message && <div className="text-[11px] text-emerald-700">{message}</div>}
        {error && <div className="text-[11px] text-negative">{error}</div>}
      </div>
    );
  }

  // TARGET_PENDING
  return (
    <div className="flex flex-col gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <div className="text-xs font-medium text-emerald-900">
        Ownership offered to you
      </div>
      <p className="text-[11px] text-emerald-800">
        The current OWNER has offered to transfer this workspace to you
        {initiatedAtLabel && (
          <> on <span className="font-mono">{initiatedAtLabel}</span></>
        )}
        . If you accept, you become OWNER and the current OWNER becomes ADMIN.
        Decline to leave ownership where it is.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleAccept}
          disabled={pending}
          className="h-7 inline-flex items-center rounded-md bg-emerald-600 px-2.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {pending ? "Accepting..." : "Accept ownership"}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={pending}
          className="h-7 inline-flex items-center rounded-md border border-emerald-300 bg-white px-2.5 text-[11px] font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
        >
          Decline
        </button>
      </div>
      {message && <div className="text-[11px] text-emerald-700">{message}</div>}
      {error && <div className="text-[11px] text-negative">{error}</div>}
    </div>
  );
}
