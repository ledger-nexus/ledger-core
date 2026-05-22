"use client";

// Inline deactivation form. Renders an "expand" button by default; on
// click, fetches a preflight count + shows a target picker so the admin
// can reassign owned records before flipping isActive=false.
//
// This is the in-miniature version of the role-change preflight UX from
// docs/ownership-and-rules.md. The same shape will scale up when
// role/permission removal needs the same workflow.

import { useState, useTransition } from "react";
import { deactivateUserAction } from "@/app/actions/user-lifecycle";

export interface QueueOption {
  id: string;
  name: string;
}
export interface UserOption {
  id: string;
  displayName: string;
}

interface Props {
  userId: string;
  userName: string;
  /**
   * Counts of records currently owned by this user. Computed at page
   * load via previewOrphansForUserChange; the deactivate flow's value
   * depends on the admin seeing these numbers before acting.
   */
  ownedCounts: { JournalEntry: number; ArOpenItem: number };
  queues: QueueOption[];
  users: UserOption[];
}

export function DeactivateForm({
  userId,
  userName,
  ownedCounts,
  queues,
  users,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>("__skip__");

  const totalOwned = ownedCounts.JournalEntry + ownedCounts.ArOpenItem;

  function onSubmit() {
    setError(null);
    const reassignTo =
      target === "__skip__"
        ? undefined
        : (() => {
            const [type, id] = target.split(":");
            if (type !== "USER" && type !== "QUEUE") return undefined;
            return { type: type as "USER" | "QUEUE", id };
          })();

    startTransition(async () => {
      const result = await deactivateUserAction({
        userId,
        reassignTo,
        reason: `deactivated via /admin/users`,
      });
      if (!result.ok) {
        setError(result.message ?? "Deactivation failed");
      } else {
        setOpen(false);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-100"
      >
        Deactivate
      </button>
    );
  }

  return (
    <div className="flex w-72 flex-col gap-2 rounded-md border border-red-200 bg-red-50/40 p-2">
      <div className="text-[11px] font-medium text-ink-900">
        Deactivate {userName}?
      </div>
      <div className="text-[11px] text-ink-700">
        {totalOwned === 0 ? (
          <span>
            Owns 0 records — deactivation is safe, no orphans will be created.
          </span>
        ) : (
          <span>
            Currently owns {totalOwned} record{totalOwned === 1 ? "" : "s"} (
            {ownedCounts.JournalEntry} JE / {ownedCounts.ArOpenItem} AR). Choose
            what to do with them:
          </span>
        )}
      </div>
      {totalOwned > 0 ? (
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={pending}
          className="h-7 rounded border border-ink-200 bg-white px-1 text-[11px]"
        >
          <option value="__skip__">
            Skip — let records become orphans (admin triages later)
          </option>
          <optgroup label="Reassign all to queue">
            {queues.map((q) => (
              <option key={q.id} value={`QUEUE:${q.id}`}>
                {q.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Reassign all to user">
            {users.map((u) => (
              <option key={u.id} value={`USER:${u.id}`}>
                {u.displayName}
              </option>
            ))}
          </optgroup>
        </select>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending}
          className="rounded bg-red-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-800 disabled:opacity-50"
        >
          {pending ? "Deactivating…" : "Confirm deactivation"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={pending}
          className="rounded border border-ink-200 bg-white px-2 py-1 text-[11px] text-ink-700 hover:bg-ink-50"
        >
          Cancel
        </button>
      </div>
      {error ? <div className="text-[11px] text-negative">{error}</div> : null}
    </div>
  );
}

interface ReactivateProps {
  userId: string;
  userName: string;
}

export function ReactivateButton({ userId, userName }: ReactivateProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const { reactivateUserAction } = await import(
        "@/app/actions/user-lifecycle"
      );
      const result = await reactivateUserAction(userId);
      if (!result.ok) setError(result.message ?? "Reactivation failed");
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        title={`Reactivate ${userName}`}
        className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
      >
        {pending ? "Reactivating…" : "Reactivate"}
      </button>
      {error ? <span className="text-[10px] text-negative">{error}</span> : null}
    </div>
  );
}
