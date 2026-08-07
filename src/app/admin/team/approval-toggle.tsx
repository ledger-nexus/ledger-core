"use client";

// Toggle for tenant.requireJeApproval + optional jeApprovalMinAmount
// threshold. Rendered on /admin/team. Client component because the
// switch needs a transition, the threshold input needs local form
// state, and the success/failure messages are inline.

import { useState, useTransition } from "react";
import {
  toggleRequireJeApprovalAction,
  setJeApprovalThresholdAction,
} from "@/app/actions/toggle-je-approval";

export function ApprovalToggle({
  initialEnabled,
  initialThreshold,
}: {
  initialEnabled: boolean;
  /** Stored as a 4-decimal string or null. */
  initialThreshold: string | null;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Threshold input holds whatever the operator types. Empty / 0 = clear.
  // Display the stored value rounded to 2 decimals for readability.
  const initialDisplay =
    initialThreshold && Number(initialThreshold) > 0
      ? Number(initialThreshold).toFixed(2)
      : "";
  const [threshold, setThreshold] = useState(initialDisplay);
  const [thresholdSaving, startThresholdTransition] = useTransition();

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

  function handleThresholdSave() {
    setError(null);
    setMessage(null);
    startThresholdTransition(async () => {
      const r = await setJeApprovalThresholdAction(threshold);
      if (r.ok) {
        setMessage(r.message ?? null);
      } else {
        setError(r.message ?? "Failed");
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

      {/* Threshold: only meaningful when the flag is on, but always
          editable so the operator can configure it before enabling. */}
      <div className="ml-6 mt-3 border-l-2 border-ink-100 pl-3">
        <label
          htmlFor="je-approval-threshold"
          className="text-xs font-medium text-ink-700"
        >
          Threshold (optional)
        </label>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-xs text-ink-500">$</span>
          <input
            id="je-approval-threshold"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            disabled={thresholdSaving}
            placeholder="e.g. 1000.00"
            className="w-32 rounded-md border border-ink-300 px-2 py-1 text-xs focus:border-ink-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleThresholdSave}
            disabled={thresholdSaving}
            className="h-7 inline-flex items-center rounded-md border border-ink-300 bg-white px-2.5 text-[11px] font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
          >
            {thresholdSaving ? "Saving..." : "Save threshold"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-ink-500">
          Only entries with a total <span className="font-medium">at or above</span>{" "}
          this amount require approval. Leave blank (or 0) to require approval
          for every MEMBER entry.
        </p>
      </div>

      {message && (
        <div className="ml-6 mt-2 text-[11px] text-positive">{message}</div>
      )}
      {error && (
        <div className="ml-6 mt-2 text-[11px] text-negative">{error}</div>
      )}
    </div>
  );
}
