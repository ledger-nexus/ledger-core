"use client";

// "Run through today" button fires every due cadence step on every
// active template in one go. Returns aggregate counts; errors land
// inline so the admin sees which periods failed.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { runRecurringEntriesAction } from "@/app/actions/recurring-entries";

interface Props {
  today: string;
  disabled?: boolean;
}

export default function RunAllButton({ today, disabled }: Props) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  function handleRun() {
    setMsg(null);
    setIsError(false);
    startTransition(async () => {
      const r = await runRecurringEntriesAction({ throughDate: today });
      if (!r.ok) {
        setMsg(r.message ?? "Run failed");
        setIsError(true);
      } else {
        setMsg(r.message ?? `Posted ${r.entriesPosted} entries.`);
        setIsError((r.errors?.length ?? 0) > 0);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      {msg && (
        <span className={`text-xs ${isError ? "text-negative" : "text-positive"}`}>{msg}</span>
      )}
      <Button onClick={handleRun} disabled={pending || disabled} variant="outline">
        {pending ? "Running…" : "Run through today"}
      </Button>
    </div>
  );
}
