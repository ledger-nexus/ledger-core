"use client";

// Client island for the "Post revaluation" action. Calls the
// human-gated Server Action; on success the page revalidates and shows
// the posted entry number. The action is idempotent, so a double-click
// can't double-post.

import { useState, useTransition } from "react";
import { postFxRevaluationAction } from "@/app/actions/fx-revaluation";
import { Button } from "@/components/ui/button";

export default function PostRevaluationButton({
  periodCode,
}: {
  periodCode: string;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null
  );

  function doPost() {
    setMessage(null);
    startTransition(async () => {
      const r = await postFxRevaluationAction({ periodCode });
      if (!r.ok) {
        setMessage({ kind: "err", text: r.error });
        return;
      }
      if (r.noop) {
        setMessage({ kind: "ok", text: "Nothing to revalue — no entry posted." });
      } else if (r.wasDuplicate) {
        setMessage({
          kind: "ok",
          text: `Already posted (${r.adjustmentEntryNumber}). No duplicate created.`,
        });
      } else {
        setMessage({
          kind: "ok",
          text: `Posted ${r.adjustmentEntryNumber} + reversal ${r.reversalEntryNumber}.`,
        });
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button type="button" onClick={doPost} disabled={pending}>
        {pending ? "Posting…" : "Post revaluation"}
      </Button>
      <p className="text-[11px] text-ink-500">
        Posts the adjustment (source <span className="font-mono">AI_APPROVED</span>)
        + an auto-reversal dated the first day of next period. Idempotent.
      </p>
      {message && (
        <div
          className={
            message.kind === "ok"
              ? "text-xs text-positive"
              : "text-xs text-negative"
          }
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
