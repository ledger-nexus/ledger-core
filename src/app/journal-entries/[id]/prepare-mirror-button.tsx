"use client";

// Prepare-mirror affordance — counterparty picker + trigger for the
// intercompany pairing action. Rendered inside the Intercompany card on
// the JE detail page when the entry is mirrorable.
//
// The action is idempotent (the lineage unique index allows exactly one
// mirror per source entry), so a double-click surfaces the friendly
// "already prepared" refusal, never a duplicate entry.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { prepareMirrorAction } from "@/app/actions/intercompany";

interface Props {
  sourceEntryId: string;
  /** Sibling entities of the same tenant (the source's own entity is
   *  excluded server-side). */
  counterpartyOptions: { code: string; name: string }[];
  /** Approvers post the mirror directly; everyone else queues it. Drives
   *  the button label so nobody is surprised by what the click does. */
  postsDirectly: boolean;
}

export default function PrepareMirrorButton({
  sourceEntryId,
  counterpartyOptions,
  postsDirectly,
}: Props) {
  const [counterparty, setCounterparty] = useState(
    counterpartyOptions.length === 1 ? counterpartyOptions[0].code : ""
  );
  const [pending, startTransition] = useTransition();
  const [success, setSuccess] = useState<{ id: string; entryNumber: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [existingMirrorId, setExistingMirrorId] = useState<string | null>(null);
  const router = useRouter();

  function handleClick() {
    if (!counterparty) {
      setError("Pick the counterparty entity first.");
      return;
    }
    setError(null);
    setBlockers([]);
    setExistingMirrorId(null);
    startTransition(async () => {
      const r = await prepareMirrorAction({
        sourceEntryId,
        counterpartyEntityCode: counterparty,
      });
      if (!r.ok) {
        setError(r.error);
        setBlockers(r.blockers ?? []);
        setExistingMirrorId(r.existingMirrorId ?? null);
        return;
      }
      setSuccess({ id: r.mirrorEntryId, entryNumber: r.entryNumber, status: r.status });
      router.refresh();
    });
  }

  if (success) {
    return (
      <p className="text-sm text-emerald-700">
        Mirror{" "}
        <Link href={`/journal-entries/${success.id}`} className="font-mono text-link hover:underline">
          {success.entryNumber}
        </Link>{" "}
        {success.status === "POSTED"
          ? "posted in the counterparty entity."
          : "submitted — it needs an approver in the counterparty entity before it has ledger effect."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          value={counterparty}
          onChange={(e) => setCounterparty(e.target.value)}
          className="rounded-md border border-ink-300 bg-white px-2 py-1.5 text-sm text-ink-800"
          aria-label="Counterparty entity"
        >
          {counterpartyOptions.length !== 1 && <option value="">Counterparty entity…</option>}
          {counterpartyOptions.map((o) => (
            <option key={o.code} value={o.code}>
              {o.code} — {o.name}
            </option>
          ))}
        </select>
        <Button onClick={handleClick} disabled={pending} size="sm">
          {pending
            ? "Preparing mirror…"
            : postsDirectly
              ? "Post mirror"
              : "Submit mirror for approval"}
        </Button>
      </div>
      {error && (
        <div className="text-xs text-red-600">
          {error}
          {existingMirrorId && (
            <>
              {" "}
              <Link
                href={`/journal-entries/${existingMirrorId}`}
                className="font-medium text-link hover:underline"
              >
                Open it →
              </Link>
            </>
          )}
        </div>
      )}
      {blockers.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-red-600">
          {blockers.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
