"use client";

// The /ask box. A question goes to the read-only assistant Server Action and
// the grounded answer comes back — plus a quiet line naming which parts of the
// ledger it read, so the answer is auditable, not a black box.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { askLedgerAction } from "@/app/actions/ask";
import type { AskResult } from "@/lib/assistant/ask";

const EXAMPLES = [
  "What's my cash balance?",
  "How much did I spend this year?",
  "What's my net worth right now?",
];

// Tool names → the plain-English "what it read" phrasing shown to the user.
const CONSULTED_LABEL: Record<string, string> = {
  get_balances: "account balances",
  get_income_statement: "the income statement",
  get_balance_sheet: "the balance sheet",
  list_accounts: "the chart of accounts",
  get_account_activity: "account activity",
  search_journal_entries: "journal entries",
};

export function AskForm() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [asked, setAsked] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || pending) return;
    setAsked(trimmed);
    setResult(null);
    startTransition(async () => {
      setResult(await askLedgerAction(trimmed));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
        className="flex flex-col gap-2"
      >
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter for a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(question);
            }
          }}
          rows={2}
          maxLength={500}
          placeholder="Ask about your books — a balance, what you spent, your net worth…"
          className="w-full resize-none rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-900"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setQuestion(ex);
                  submit(ex);
                }}
                disabled={pending}
                className="rounded-full border border-ink-200 px-2.5 py-1 text-xs text-ink-500 transition-colors hover:border-ink-400 hover:text-ink-700 disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
          </div>
          <Button type="submit" size="sm" disabled={pending || !question.trim()}>
            {pending ? "Reading…" : "Ask"}
          </Button>
        </div>
      </form>

      {(pending || result) && (
        <div className="rounded-md border border-ink-200 bg-white px-4 py-3">
          {asked && (
            <p className="mb-2 text-xs text-ink-400">You asked: “{asked}”</p>
          )}
          {pending ? (
            <p className="text-sm text-ink-500">Reading your ledger…</p>
          ) : result ? (
            <>
              <p
                className={
                  "whitespace-pre-wrap text-sm " +
                  (result.error || !result.configured
                    ? "text-ink-600"
                    : "text-ink-900")
                }
              >
                {result.answer}
              </p>
              {result.consulted.length > 0 && (
                <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
                  <span>Read:</span>
                  {result.consulted.map((c) => (
                    <Badge key={c} tone="neutral">
                      {CONSULTED_LABEL[c] ?? c}
                    </Badge>
                  ))}
                </p>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
