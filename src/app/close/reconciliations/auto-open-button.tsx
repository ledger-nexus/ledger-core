"use client";

// BlackLine arc — Phase 1 PR 6: "Open recons for this period" button.
//
// Sits in the list page's empty state (or as a header action for
// scopes that already have some). Calls openPeriodReconciliations
// with the resolved (entity, book, period) IDs and reports the
// (created, skipped, total) tuple inline.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { openPeriodReconciliations } from "@/app/actions/recon-auto-open";

interface Props {
  entityId: string;
  bookId: string;
  periodId: string;
  periodCode: string;
  // Used purely for the inline confirm-success label so the operator
  // sees what they just did without a full page repaint.
  label?: string;
}

export default function AutoOpenButton({
  entityId,
  bookId,
  periodId,
  periodCode,
  label,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleClick() {
    setResult(null);
    setError(null);
    startTransition(async () => {
      const r = await openPeriodReconciliations({
        entityId,
        bookId,
        periodId,
      });
      if (!r.ok) {
        setError(r.error);
      } else {
        const verb =
          r.created === 0
            ? `already up to date · ${r.total} open`
            : `${r.created} created${r.skipped > 0 ? `, ${r.skipped} already open` : ""} · ${r.total} total`;
        setResult(verb);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button onClick={handleClick} disabled={pending}>
        {pending ? "Opening..." : (label ?? `Open recons for ${periodCode}`)}
      </Button>
      {result && <span className="text-xs text-ink-500">{result}</span>}
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
