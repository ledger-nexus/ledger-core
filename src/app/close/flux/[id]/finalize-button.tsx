"use client";

// BlackLine arc — Phase 3 PR 3: statement finalize button.
//
// Server Action refuses when any line is NEEDS_COMMENT and returns
// the pendingLines list; on refusal we surface the first 3 gap
// account names so the operator knows where to go.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { finalizeFluxStatement } from "@/app/actions/flux";

interface Props {
  statementId: string;
  disabled: boolean;
  pendingHint?: string;
}

export default function FinalizeButton({
  statementId,
  disabled,
  pendingHint,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pendingNames, setPendingNames] = useState<string[]>([]);

  function handleClick() {
    setError(null);
    setPendingNames([]);
    startTransition(async () => {
      const r = await finalizeFluxStatement({ statementId });
      if (!r.ok) {
        setError(r.error);
        if (r.code === "FINALIZE_GATE_BLOCKED" && r.pendingLines) {
          setPendingNames(
            r.pendingLines.slice(0, 3).map((l) => l.accountName)
          );
        }
      }
    });
  }

  return (
    <div className="flex items-start gap-3">
      <Button
        onClick={handleClick}
        disabled={pending || disabled}
        title={pendingHint}
      >
        {pending ? "Finalizing..." : "Finalize statement"}
      </Button>
      {pendingHint && disabled && (
        <span className="text-xs text-ink-500">{pendingHint}</span>
      )}
      {error && (
        <div className="text-xs text-red-600">
          <div>{error}</div>
          {pendingNames.length > 0 && (
            <div className="mt-1">
              Gaps: {pendingNames.join(", ")}
              {pendingNames.length === 3 ? " ..." : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
