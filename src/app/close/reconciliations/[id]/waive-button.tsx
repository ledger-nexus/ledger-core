"use client";

// BlackLine arc — Phase 1 PR 4: admin waive button.
//
// Calls `waiveRecon`. Server Action enforces admin-only via
// requireTenantAdmin (OWNER + ADMIN roles); non-admins shouldn't see
// this button render at all because the page-level `isTenantAdmin`
// gate hides it. The defense-in-depth Server Action check covers
// admins who lost role mid-session.
//
// Reason is mandatory — it's the SOC 1 / SOX 404 evidence for why a
// balance-sheet account was excused from reconciliation this period.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { waiveRecon } from "@/app/actions/reconciliations";

interface Props {
  reconId: string;
  accountCode: string;
}

export default function WaiveButton({ reconId, accountCode }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Reason is required");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await waiveRecon({ reconId, reason: reason.trim() });
      if (!r.ok) {
        setError(r.error);
      }
    });
  }

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        onClick={() => {
          setConfirming(true);
          setError(null);
        }}
      >
        Waive this reconciliation
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="text-sm text-ink-700">
        Waiving <span className="font-mono">{accountCode}</span> marks it
        as not requiring reconciliation for this period. The status
        becomes WAIVED (terminal). Reason persists to the audit log.
      </div>
      <div>
        <label
          htmlFor="waive-reason"
          className="block text-sm font-medium text-ink-900"
        >
          Reason <span className="text-red-600">*</span>
        </label>
        <textarea
          id="waive-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Account has zero activity for the period; recon not applicable..."
          className="mt-1 block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          disabled={pending}
          maxLength={2000}
          autoFocus
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "..." : "Confirm waive"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setConfirming(false);
            setReason("");
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </form>
  );
}
