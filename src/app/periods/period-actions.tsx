"use client";

// Client Component for the close / reopen button on each period row.
// Calls the closePeriodAction / reopenPeriodAction Server Actions; on
// success the Server Action revalidates /periods so the row re-renders
// with the new status.
//
// Both confirmations render as in-app modals (src/components/ui/modal.tsx),
// not native dialogs. window.prompt() — which used to collect the reopen
// reason — throws "prompt() is not supported" in sandboxed and embedded
// browser contexts (Chrome blocks it in cross-origin iframes; automation and
// preview panes reject it outright), and the unhandled throw aborted the
// reopen entirely. The reason string is SOC 2 evidence: it lands in
// period_reopen_log and in the reopen audit row, so the field it's typed into
// has to exist everywhere the app runs, validate what it collects, and show
// the operator what reopening actually does.
//
// Refusal semantics are unchanged from the prompt() version: dismissing the
// dialog aborts, an empty or whitespace-only reason is refused without firing
// the action, and the Server Action receives the trimmed string. The action
// re-validates the reason server-side regardless — this is the affordance,
// not the control.

import { useCallback, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
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

type OpenDialog = null | "close" | "reopen";

export default function PeriodActions({
  entityCode,
  bookCode,
  periodCode,
  isClosed,
}: PeriodActionsProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonFieldId = useId();

  const scopeLabel = `${periodCode} on ${entityCode} / ${bookCode}`;

  // Dismissing always discards the draft reason — a half-typed justification
  // must never survive to attach itself to a later reopen.
  const dismiss = useCallback(() => {
    setDialog(null);
    setReason("");
    setReasonError(null);
  }, []);

  function confirmClose() {
    setDialog(null);
    setError(null);
    startTransition(async () => {
      const r = await closePeriodAction({ entityCode, bookCode, periodCode });
      if (!r.ok) setError(r.message ?? "Close failed");
    });
  }

  function confirmReopen() {
    const trimmed = reason.trim();
    if (!trimmed) {
      // Refuse in place: keep the dialog open so the operator can see why,
      // and fire nothing.
      setReasonError("A reason is required to reopen a period.");
      return;
    }
    dismiss();
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
          onClick={() => setDialog("reopen")}
          disabled={pending}
        >
          {pending ? "..." : "Reopen"}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => setDialog("close")}
          disabled={pending}
        >
          {pending ? "..." : "Close"}
        </Button>
      )}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}

      <Modal
        open={dialog === "close"}
        onClose={dismiss}
        title={`Close period ${periodCode}?`}
        description={
          <>
            Closing <span className="font-mono text-ink-900">{scopeLabel}</span>{" "}
            freezes it — no entries can be posted into this period once it is
            closed. An admin can reopen it.
          </>
        }
        footer={
          <>
            <Button size="sm" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button size="sm" onClick={confirmClose}>
              Close period
            </Button>
          </>
        }
      />

      <Modal
        open={dialog === "reopen"}
        onClose={dismiss}
        title={`Reopen period ${periodCode}?`}
        description={
          <>
            Reopening <span className="font-mono text-ink-900">{scopeLabel}</span>{" "}
            allows new posts (and reversals of existing JEs) against this
            period. Only do this if stakeholder reports for this period have{" "}
            <strong className="font-semibold text-ink-900">not</strong> yet been
            finalized.
          </>
        }
        footer={
          <>
            <Button size="sm" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button size="sm" onClick={confirmReopen}>
              Reopen period
            </Button>
          </>
        }
      >
        <Label htmlFor={reasonFieldId}>Reason (required)</Label>
        <Input
          id={reasonFieldId}
          data-autofocus
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (reasonError) setReasonError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              confirmReopen();
            }
          }}
          placeholder="e.g. Auditor found an unrecorded accrual in AP"
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? `${reasonFieldId}-error` : undefined}
        />
        <p className="mt-2 text-xs text-ink-500">
          Recorded in the audit trail and the period reopen history.
        </p>
        {reasonError ? (
          <p
            id={`${reasonFieldId}-error`}
            role="alert"
            className="mt-2 text-xs text-red-600"
          >
            {reasonError}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
