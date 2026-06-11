"use client";

// BlackLine arc — Phase 1 PR 4: reviewer actions panel.
//
// Three buttons for the PREPARED state:
//   - Approve → approveRecon → RECONCILED. Server Action enforces SoD
//     (reviewer.id ≠ preparer.id). Same-user errors render inline.
//   - Send back → sendBackToPreparer (with mandatory comment) →
//     IN_PROGRESS. Preparer fields cleared so the redo is a fresh
//     sign-off, not an amendment.
//   - Mark exception → markException (with mandatory comment) →
//     EXCEPTION. Used when the diff is real and needs escalation
//     beyond this period.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  approveRecon,
  sendBackToPreparer,
  markException,
} from "@/app/actions/reconciliations";

interface Props {
  reconId: string;
}

type Mode = "idle" | "sendBack" | "exception";

export default function ReviewerActions({ reconId }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [comment, setComment] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleApprove() {
    setError(null);
    startTransition(async () => {
      const r = await approveRecon({ reconId });
      if (!r.ok) {
        // SAME_USER comes from the SoD enforcement. The UI explains
        // explicitly because "approve failed" alone is confusing —
        // the reviewer needs to know why they can't approve.
        if (r.code === "SAME_USER") {
          setError(
            "You prepared this reconciliation. A different user must sign as reviewer."
          );
        } else {
          setError(r.error);
        }
      }
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim()) {
      setError("Comment is required");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r =
        mode === "sendBack"
          ? await sendBackToPreparer({
              reconId,
              comment: comment.trim(),
            })
          : await markException({
              reconId,
              comment: comment.trim(),
            });
      if (!r.ok) {
        setError(r.error);
      } else {
        setMode("idle");
        setComment("");
      }
    });
  }

  if (mode !== "idle") {
    return (
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <label
            htmlFor="reviewer-comment"
            className="block text-sm font-medium text-ink-900"
          >
            {mode === "sendBack"
              ? "Why are you sending this back?"
              : "Why is this an exception?"}{" "}
            <span className="text-red-600">*</span>
          </label>
          <textarea
            id="reviewer-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            placeholder={
              mode === "sendBack"
                ? "Preparer needs to attach the bank statement screenshot..."
                : "Diff is a known timing issue from the September close..."
            }
            className="mt-1 block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
            disabled={pending}
            maxLength={2000}
            autoFocus
          />
          <div className="mt-1 text-xs text-ink-400">
            {comment.length}/2000 characters · persists to the audit log
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending
              ? "..."
              : mode === "sendBack"
                ? "Send back to preparer"
                : "Mark exception"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setMode("idle");
              setComment("");
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

  return (
    <div className="flex items-center gap-2">
      <Button onClick={handleApprove} disabled={pending}>
        {pending ? "..." : "Approve"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setMode("sendBack");
          setError(null);
        }}
        disabled={pending}
      >
        Send back
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setMode("exception");
          setError(null);
        }}
        disabled={pending}
      >
        Mark exception
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
