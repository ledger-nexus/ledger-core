"use client";

// Instantiate-calendar affordance — the UI entry point to the close-task
// calendar.
//
// `instantiateCalendarForPeriod` shipped tested but unreachable: nothing
// in the app called it, so a tenant's seeded templates could never become
// a period's checklist through the product. This island is that caller.
// It renders on the Close dashboard's task card and on the /close/tasks
// empty state.
//
// The action is idempotent (skips any templateKey already instantiated
// for the period) and writes one aggregate audit row per invocation, so
// a double-click costs a no-op round trip, not duplicate tasks.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { instantiateCalendarForPeriod } from "@/app/actions/close-tasks";

interface Props {
  periodId: string;
  /** Period code — shown in the success line so the operator sees WHICH
   *  period got the checklist. */
  periodCode: string;
  /** Active template count, for the button label ("Open 50 tasks..."). */
  templateCount: number;
  size?: "default" | "sm";
}

export default function InstantiateCalendarButton({
  periodId,
  periodCode,
  templateCount,
  size = "default",
}: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleClick() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const r = await instantiateCalendarForPeriod({ periodId });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setResult(
          r.created > 0
            ? `Opened ${r.created} task${r.created === 1 ? "" : "s"} for ${periodCode}`
            : `${periodCode} already has its checklist — nothing to add`
        );
        router.refresh();
      } catch {
        // requireCurrentUser / requireCurrentTenant throw rather than
        // returning a result union; surface them as a normal error line
        // instead of an unhandled rejection.
        setError("Could not open the checklist — sign in and pick a workspace.");
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button onClick={handleClick} disabled={pending} size={size}>
        {pending
          ? "Opening checklist..."
          : `Open checklist for ${periodCode} (${templateCount} task${templateCount === 1 ? "" : "s"})`}
      </Button>
      {result && <span className="text-xs text-positive">{result}</span>}
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
