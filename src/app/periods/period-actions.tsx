"use client";

// Client Component for the close / reopen button on each period row.
// Calls the closePeriodAction / reopenPeriodAction Server Actions; on
// success the Server Action revalidates /periods so the row re-renders
// with the new status.
//
// The confirmation is a basic window.confirm() — accountants want a
// clear "are you sure" before freezing/reopening a period. Phase 2
// could add a modal showing the affected JE count + total dollar
// volume; for v1 the confirm() string includes the count.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  closePeriodAction,
  reopenPeriodAction,
} from "@/app/actions/period-close";

interface PeriodActionsProps {
  entityCode: string;
  bookCode: string;
  periodCode: string;
  isClosed: boolean;
}

export default function PeriodActions({
  entityCode,
  bookCode,
  periodCode,
  isClosed,
}: PeriodActionsProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClose() {
    const ok = window.confirm(
      `Close period ${periodCode} on ${entityCode} / ${bookCode}?\n\nOnce closed, no entries can be posted into this period. An admin can reopen it.`
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const r = await closePeriodAction({ entityCode, bookCode, periodCode });
      if (!r.ok) setError(r.message ?? "Close failed");
    });
  }

  function handleReopen() {
    // A reopen must carry a reason — it's recorded in the audit trail and the
    // reopen history. Collect it up front; empty/cancel aborts.
    const reason = window.prompt(
      `Reopen period ${periodCode} on ${entityCode} / ${bookCode}?\n\nReopening allows new posts (and reversals of existing JEs) against this period. Only do this if stakeholder reports for this period have NOT yet been finalized.\n\nEnter a reason (required — recorded in the audit trail):`
    );
    if (reason === null) return; // cancelled
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("A reason is required to reopen a period.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await reopenPeriodAction({
        entityCode,
        bookCode,
        periodCode,
        reason: trimmed,
      });
      if (!r.ok) setError(r.message ?? "Reopen failed");
    });
  }

  return (
    <div className="flex items-center gap-2">
      {isClosed ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={handleReopen}
          disabled={pending}
        >
          {pending ? "..." : "Reopen"}
        </Button>
      ) : (
        <Button size="sm" onClick={handleClose} disabled={pending}>
          {pending ? "..." : "Close"}
        </Button>
      )}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
