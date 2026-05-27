"use client";

// Reverse-JE button. Lives on the JE detail page next to Duplicate and
// Export-CSV. Confirms with a window.confirm (real CPA habit — they
// want a hard "are you sure" before doing anything that mutates two
// entries at once), then calls the Server Action and navigates to the
// new reversal entry on success.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { reverseJournalEntryAction } from "@/app/actions/reverse-journal-entry";

interface Props {
  /** Source JE id. */
  id: string;
  entryNumber: string;
  /** "POSTED" → enable button; anything else → disabled with hint. */
  status: string;
  /** When the source already has a reversal pointing at it, show "already reversed". */
  reversedByEntryNumber?: string;
}

export default function ReverseButton({
  id,
  entryNumber,
  status,
  reversedByEntryNumber,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (status === "REVERSED" || reversedByEntryNumber) {
    return (
      <Button size="sm" variant="ghost" disabled title="This entry has already been reversed">
        Reversed
      </Button>
    );
  }
  if (status !== "POSTED") {
    return (
      <Button size="sm" variant="ghost" disabled title={`Only POSTED entries can be reversed (this one is ${status})`}>
        Reverse
      </Button>
    );
  }

  function handleReverse() {
    setError(null);
    const today = new Date().toISOString().slice(0, 10);
    const ok = window.confirm(
      `Reverse ${entryNumber}?\n\nThis posts a new sign-flipped JE dated ${today} and marks the original as REVERSED. The reversal goes through postJournalEntry — if its period is closed, the action will fail and the original entry stays untouched.\n\nProceed?`
    );
    if (!ok) return;
    startTransition(async () => {
      const r = await reverseJournalEntryAction({ id, reversalDate: today });
      if (!r.ok) {
        setError(r.message ?? "Reversal failed.");
        return;
      }
      if (r.reversalId) {
        router.push(`/journal-entries/${r.reversalId}`);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="ghost" disabled={pending} onClick={handleReverse}>
        {pending ? "Reversing…" : "Reverse"}
      </Button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
