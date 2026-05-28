"use client";

// Toggle for tenant.requireJeApproval. Rendered on /admin/team.
// Client component because the switch needs a transition + the
// success/failure message.

import { useState, useTransition } from "react";
import { toggleRequireJeApprovalAction } from "@/app/actions/toggle-je-approval";

export function ApprovalToggle({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleToggle(next: boolean) {
    setError(null);
    setMessage(null);
    setEnabled(next); // optimistic
    startTransition(async () => {
      const r = await toggleRequireJeApprovalAction(next);
      if (r.ok) {
        setMessage(r.message ?? null);
      } else {
        setError(r.message ?? "Failed");
        setEnabled(!next); // revert
      }
    });
  }

  return (
    <div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => handleToggle(e.target.checked)}
          disabled={pending}
          className="h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-500"
        />
        <span className="text-sm font-medium text-ink-900">
          Require admin approval for MEMBER-posted journal entries
        </span>
        {pending && (
          <span className="text-[11px] text-ink-500">saving...</span>
        )}
      </label>
      <p className="ml-6 mt-1 text-[11px] text-ink-500">
        When ON, entries posted by MEMBERs go to{" "}
        <code className="font-mono">/journal-entries/pending</code> for an
        ADMIN to approve. ADMINs and OWNERs always post directly.
      </p>
      {message && (
        <div className="ml-6 mt-2 text-[11px] text-emerald-700">{message}</div>
      )}
      {error && (
        <div className="ml-6 mt-2 text-[11px] text-negative">{error}</div>
      )}
    </div>
  );
}
