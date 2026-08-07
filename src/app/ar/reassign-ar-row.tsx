"use client";

// Inline reassignment control on the AR list. Shows the current owner
// (user or queue) and an "Edit" button that expands a dropdown of all
// available users + queues. Selecting one fires reassignArItemAction.

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { reassignArItemAction } from "@/app/actions/reassign-ar-item";

export interface UserOption {
  id: string;
  displayName: string;
}
export interface QueueOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  openItemId: string;
  ownerLabel: string | null;
  ownerType: "USER" | "QUEUE" | null;
  lockedAt: Date | null;
  users: UserOption[];
  queues: QueueOption[];
}

export function ReassignArRow({
  openItemId,
  ownerLabel,
  ownerType,
  lockedAt,
  users,
  queues,
}: Props) {
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
      const result = await reassignArItemAction({
        openItemId,
        newOwnerType: type,
        newOwnerId: id,
      });
      if (!result.ok) {
        setError(result.message ?? "Reassign failed");
      } else {
        setOpen(false);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-1.5">
        {ownerLabel ? (
          <>
            <Badge tone={ownerType === "QUEUE" ? "info" : "neutral"}>
              {ownerType === "QUEUE" ? "queue" : "user"}
            </Badge>
            <span className="text-ink-700">{ownerLabel}</span>
          </>
        ) : (
          <span className="text-ink-500">unassigned</span>
        )}
        {lockedAt ? (
          <span className="text-[11px] text-amber-700" title="Manual reassignment — rules skip this record">
            🔒
          </span>
        ) : null}
      </div>
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
          className="self-start text-[11px] text-accent-600 hover:underline"
        >
          reassign
        </button>
      )}
      {error ? <span className="text-xs text-negative">{error}</span> : null}
    </div>
  );
}
