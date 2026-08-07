"use client";

// Per-row reassign control on the admin orphan dashboard. Generic over
// recordType (JournalEntry | ArOpenItem) — both use the same Server
// Action (adminReassignAction).
//
// UI: the row's owner cell stays compact by default; clicking "reassign"
// expands an inline dropdown of all available users + queues. Selecting
// one fires the action and collapses on success.

import { useState, useTransition } from "react";
import { adminReassignAction } from "@/app/actions/admin-reassign";

export interface UserOption {
  id: string;
  displayName: string;
}
export interface QueueOption {
  id: string;
  name: string;
}

interface Props {
  recordType: "JournalEntry" | "ArOpenItem" | "ApOpenItem";
  recordId: string;
  users: UserOption[];
  queues: QueueOption[];
}

export function OrphanReassignRow({ recordType, recordId, users, queues }: Props) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onPick(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    if (!value || value === "__placeholder__") return;
    const [type, id] = value.split(":");
    if (type !== "USER" && type !== "QUEUE") return;
    setError(null);
    startTransition(async () => {
      const result = await adminReassignAction({
        recordType,
        recordId,
        newOwnerType: type,
        newOwnerId: id,
        reason: "admin:orphan repair",
      });
      if (!result.ok) {
        setError(result.message ?? "Reassign failed");
      } else {
        setOpen(false);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      {open ? (
        <select
          onChange={onPick}
          disabled={pending}
          defaultValue="__placeholder__"
          className="h-7 rounded border border-ink-200 bg-white px-1 text-[11px]"
        >
          <option value="__placeholder__" disabled>
            {pending ? "Reassigning…" : "Pick new owner…"}
          </option>
          <optgroup label="Queues">
            {queues.map((q) => (
              <option key={q.id} value={`QUEUE:${q.id}`}>
                {q.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Users">
            {users.map((u) => (
              <option key={u.id} value={`USER:${u.id}`}>
                {u.displayName}
              </option>
            ))}
          </optgroup>
        </select>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="self-start rounded border border-ink-200 px-2 py-0.5 text-[11px] text-ink-700 hover:bg-ink-100"
        >
          reassign
        </button>
      )}
      {error ? <span className="text-xs text-negative">{error}</span> : null}
    </div>
  );
}
