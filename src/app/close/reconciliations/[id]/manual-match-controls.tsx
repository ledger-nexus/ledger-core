"use client";

// Pairing two lines the automatic matcher could not pair, and undoing
// it. Deliberately plain: two selects and a note. The interesting part
// of a manual match is the decision and who made it, not the gesture.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  linkReconMatchAction,
  unlinkReconMatchAction,
} from "@/app/actions/recon-manual-match";

interface Option {
  id: string;
  label: string;
}

export function ManualMatchForm({
  reconciliationId,
  glOptions,
  supportOptions,
}: {
  reconciliationId: string;
  glOptions: Option[];
  supportOptions: Option[];
}) {
  const [journalLineId, setJournalLineId] = useState("");
  const [bankTransactionId, setBankTransactionId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (glOptions.length === 0 || supportOptions.length === 0) return null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await linkReconMatchAction({
        reconciliationId,
        journalLineId,
        bankTransactionId,
        note: note.trim() || undefined,
      });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setJournalLineId("");
      setBankTransactionId("");
      setNote("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-2 border-t border-ink-100 pt-4">
      <div className="text-xs uppercase tracking-wide text-ink-500">
        Match two lines by hand
      </div>
      <p className="text-xs text-ink-400">
        For what the automatic pass cannot pair — a cheque split across
        deposits, a fee posted net. Amounts do not have to agree; whatever
        is left over stays in the difference.
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="mmGl">In the books</Label>
          <Select
            id="mmGl"
            value={journalLineId}
            onChange={(e) => setJournalLineId(e.target.value)}
            disabled={pending}
          >
            <option value="">— select —</option>
            {glOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="mmStmt">On the statement</Label>
          <Select
            id="mmStmt"
            value={bankTransactionId}
            onChange={(e) => setBankTransactionId(e.target.value)}
            disabled={pending}
          >
            <option value="">— select —</option>
            {supportOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="mmNote">Why (optional)</Label>
        <Input
          id="mmNote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Cheque 1042 cleared as part of the 12 May deposit"
          maxLength={300}
          disabled={pending}
        />
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={pending || !journalLineId || !bankTransactionId}
        >
          {pending ? "Matching…" : "Match these"}
        </Button>
      </div>
    </form>
  );
}

export function UnlinkMatchButton({
  reconciliationId,
  journalLineId,
}: {
  reconciliationId: string;
  journalLineId: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await unlinkReconMatchAction({ reconciliationId, journalLineId });
          router.refresh();
        })
      }
    >
      {pending ? "Removing…" : "Unmatch"}
    </Button>
  );
}
