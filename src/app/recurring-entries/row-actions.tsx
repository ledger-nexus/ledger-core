"use client";

// Per-row actions on the recurring-entries list. Run (only enabled when
// there are due periods), pause/resume, delete.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  runRecurringEntriesAction,
  setRecurringActiveAction,
  deleteRecurringEntryAction,
} from "@/app/actions/recurring-entries";

interface Props {
  id: string;
  code: string;
  isActive: boolean;
  dueCount: number;
  today: string;
}

export default function RecurringRowActions({
  id,
  code,
  isActive,
  dueCount,
  today,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleRun() {
    setError(null);
    startTransition(async () => {
      const r = await runRecurringEntriesAction({ throughDate: today, templateId: id });
      if (!r.ok) setError(r.message ?? "Run failed");
      else router.refresh();
    });
  }

  function handleToggle() {
    setError(null);
    startTransition(async () => {
      const r = await setRecurringActiveAction({ id, isActive: !isActive });
      if (!r.ok) setError(r.message ?? "Toggle failed");
      else router.refresh();
    });
  }

  function handleDelete() {
    const ok = window.confirm(
      `Delete recurring template ${code}?\n\nThis removes the template only. Journal entries already produced by it stay in place — they're real history.`
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const r = await deleteRecurringEntryAction({ id });
      if (!r.ok) setError(r.message ?? "Delete failed");
      else router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending || !isActive || dueCount === 0}
        onClick={handleRun}
        title={
          !isActive
            ? "Template is paused"
            : dueCount === 0
              ? "No periods due"
              : `Run ${dueCount} due period${dueCount === 1 ? "" : "s"}`
        }
      >
        Run
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={handleToggle}>
        {isActive ? "Pause" : "Resume"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={handleDelete}
        className="text-negative"
      >
        Delete
      </Button>
      {error && <span className="text-xs text-negative ml-2">{error}</span>}
    </div>
  );
}
