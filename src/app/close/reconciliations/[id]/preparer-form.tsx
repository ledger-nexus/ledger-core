"use client";

// BlackLine arc — Phase 1 PR 4: preparer sign-off form.
//
// Drives `markPrepared`. The status outcome depends on the cascade
// pinned at recon-open time (requiresReview) + the live tie-out:
//
//   within tolerance + requiresReview=true  → PREPARED
//   within tolerance + requiresReview=false → RECONCILED (single sig)
//   outside tolerance                       → EXCEPTION
//
// The UI doesn't try to predict the outcome — that's the Server
// Action's job and re-rendering the page after revalidatePath gives the
// authoritative answer. We just submit and show errors inline.

import { useState, useTransition } from "react";
import { Decimal } from "decimal.js";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { markPrepared } from "@/app/actions/reconciliations";

interface Props {
  reconId: string;
  glBalance: string;
  defaultSupporting: string;
  defaultNotes: string;
  // Sub-ledger auto-pull suggestion. Null when the account has no
  // sub-ledger linkage (cash, prepaid, accrued, etc. — operator types
  // the number manually). Non-null when the system can pre-compute the
  // tie-out from AR/AP open items or the fixed-asset register.
  suggestion: { amount: string; label: string } | null;
}

export default function PreparerForm({
  reconId,
  glBalance,
  defaultSupporting,
  defaultNotes,
  suggestion,
}: Props) {
  const [supporting, setSupporting] = useState(defaultSupporting);
  const [notes, setNotes] = useState(defaultNotes);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Track whether the current value came from the suggestion (vs typed
  // by hand) so we can annotate the audit trail in the notes. The
  // auditor cares: a rubber-stamped sub-ledger number is different
  // evidence than an operator-typed bank-statement number.
  const [usedSuggestion, setUsedSuggestion] = useState(false);

  // Live preview: if the user types a number, show the diff client-side
  // so they can see whether they're about to hit EXCEPTION or not. This
  // is purely cosmetic — the Server Action is authoritative.
  let preview: string | null = null;
  if (supporting.trim()) {
    try {
      const s = new Decimal(supporting);
      const g = new Decimal(glBalance);
      const d = g.minus(s);
      preview = `Diff: $${d.toFixed(2)}`;
    } catch {
      preview = null;
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!supporting.trim()) {
      setError("Supporting balance is required");
      return;
    }
    // If the operator used the suggestion verbatim, annotate the notes
    // so the audit trail captures provenance — "pulled from AR sub-
    // ledger" is materially different evidence than "typed from bank
    // statement". If they OVERRODE the suggestion (typed something
    // else after clicking "Use this"), don't annotate; their notes
    // should explain the override.
    let notesToSend = notes.trim();
    if (
      usedSuggestion &&
      suggestion &&
      supporting.trim() === suggestion.amount
    ) {
      const prefix = `[Source: ${suggestion.label}] `;
      // Avoid double-prefixing on a re-prep that already has the tag.
      if (!notesToSend.startsWith(prefix)) {
        notesToSend = notesToSend
          ? `${prefix}${notesToSend}`
          : prefix.trim();
      }
    }
    startTransition(async () => {
      const r = await markPrepared({
        reconId,
        glBalance,
        supportingBalance: supporting.trim(),
        notes: notesToSend ? notesToSend : undefined,
      });
      if (!r.ok) setError(r.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="gl">GL balance (read-only)</Label>
          <Input
            id="gl"
            type="text"
            value={glBalance}
            readOnly
            className="bg-ink-50 text-ink-500"
          />
        </div>
        <div>
          <Label htmlFor="supporting">
            Supporting balance <span className="text-red-600">*</span>
          </Label>
          <Input
            id="supporting"
            type="text"
            inputMode="decimal"
            value={supporting}
            onChange={(e) => {
              setSupporting(e.target.value);
              // Typing breaks the "this number came from the
              // suggestion" provenance — clear the flag so the audit
              // tag won't get appended on submit.
              setUsedSuggestion(false);
            }}
            placeholder="e.g. 12345.67"
            disabled={pending}
          />
          {suggestion && (
            <div className="mt-1 flex items-center gap-2 text-xs">
              <span className="text-ink-500">
                {suggestion.label}: ${suggestion.amount}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSupporting(suggestion.amount);
                  setUsedSuggestion(true);
                  setError(null);
                }}
                disabled={pending}
                className="text-accent-600 hover:underline disabled:opacity-50"
              >
                Use this
              </button>
              {usedSuggestion && supporting === suggestion.amount && (
                <span className="text-ink-400">
                  · audit tag will be added to notes
                </span>
              )}
            </div>
          )}
          {preview && (
            <div className="mt-1 text-xs text-ink-500">{preview}</div>
          )}
        </div>
      </div>
      <div>
        <Label htmlFor="notes">Preparer notes</Label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Bank statement reconciles to GL except for one outstanding check #1234 cleared 7/2..."
          className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          disabled={pending}
          maxLength={4000}
        />
        <div className="mt-1 text-xs text-ink-400">
          {notes.length}/4000 characters · the auditor reads these
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Signing..." : "Sign as preparer"}
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </form>
  );
}
