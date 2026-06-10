"use client";

// BlackLine arc — Phase 3 PR 3: admin waive button.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { waiveFluxLine } from "@/app/actions/flux";

interface Props {
  lineId: string;
  accountName: string;
}

export default function WaiveButton({ lineId, accountName }: Props) {
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
      const r = await waiveFluxLine({ lineId, reason: reason.trim() });
      if (!r.ok) {
        setError(r.error);
      }
    });
  }

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setConfirming(true);
          setError(null);
        }}
      >
        Waive
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder={`Why is ${accountName} not material here?`}
        autoFocus
        disabled={pending}
        className="block w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-xs text-ink-900 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
      />
      <div className="flex items-center gap-1">
        <Button type="submit" size="sm" disabled={pending || !reason.trim()}>
          {pending ? "..." : "Confirm"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
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
