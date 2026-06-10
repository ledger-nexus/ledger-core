"use client";

// Per-row actions for the channels table: Test, Edit (inline panel),
// Toggle enable, Delete. Edit opens an inline panel below the row;
// the URL is never pre-filled (entry is optional — empty keeps the
// existing encrypted value).

import { useState, useTransition } from "react";
import {
  testChannel,
  deleteChannel,
  setEnabled,
  updateChannel,
} from "@/app/actions/notification-channels";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Severity = "high" | "medium" | "low";

export default function ChannelRowActions({
  channelId,
  enabled,
  name,
  severityFilter,
}: {
  channelId: string;
  enabled: boolean;
  name: string;
  severityFilter: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState(name);
  const [editUrl, setEditUrl] = useState("");
  const [editSeverities, setEditSeverities] = useState<Severity[]>(
    severityFilter as Severity[]
  );

  function doTest() {
    setMessage(null);
    startTransition(async () => {
      const r = await testChannel({ channelId });
      if (r.ok) setMessage({ kind: "ok", text: "Test sent." });
      else setMessage({ kind: "err", text: r.error });
    });
  }

  function doToggle() {
    setMessage(null);
    startTransition(async () => {
      const r = await setEnabled({ channelId, enabled: !enabled });
      if (!r.ok) setMessage({ kind: "err", text: r.error });
    });
  }

  function doDelete() {
    setMessage(null);
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete channel "${name}"? This also removes its dispatch history.`)
    ) {
      return;
    }
    startTransition(async () => {
      const r = await deleteChannel({ channelId });
      if (!r.ok) setMessage({ kind: "err", text: r.error });
    });
  }

  function doEditSave() {
    setMessage(null);
    startTransition(async () => {
      const r = await updateChannel({
        channelId,
        name: editName.trim() !== name ? editName.trim() : undefined,
        webhookUrl: editUrl.trim().length > 0 ? editUrl.trim() : undefined,
        severityFilter:
          JSON.stringify([...editSeverities].sort()) !==
          JSON.stringify([...severityFilter].sort())
            ? editSeverities
            : undefined,
      });
      if (!r.ok) {
        setMessage({ kind: "err", text: r.error });
        return;
      }
      setEditOpen(false);
      setEditUrl("");
    });
  }

  function toggleEditSeverity(s: Severity) {
    setEditSeverities((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        <button
          type="button"
          onClick={doTest}
          disabled={pending}
          className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          Test
        </button>
        <button
          type="button"
          onClick={() => setEditOpen((v) => !v)}
          disabled={pending}
          className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          {editOpen ? "Cancel" : "Edit"}
        </button>
        <button
          type="button"
          onClick={doToggle}
          disabled={pending}
          className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          {enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={doDelete}
          disabled={pending}
          className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      {message && (
        <div
          className={
            message.kind === "ok"
              ? "text-[10px] text-emerald-700"
              : "text-[10px] text-red-700"
          }
        >
          {message.text}
        </div>
      )}

      {editOpen && (
        <div className="mt-2 flex w-[460px] flex-col gap-2 rounded-md border border-ink-200 bg-ink-50/40 p-3 text-left">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-ink-500">
              Name
            </label>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={120}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-ink-500">
              New webhook URL (optional — leave blank to keep existing)
            </label>
            <Input
              type="password"
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/T.../B.../..."
              maxLength={500}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-ink-500">
              Severity filter
            </label>
            <div className="flex gap-1.5">
              {(["high", "medium", "low"] as Severity[]).map((s) => {
                const active = editSeverities.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleEditSeverity(s)}
                    disabled={pending}
                    className={
                      active
                        ? "rounded-full bg-ink-900 px-2.5 py-0.5 text-[11px] font-medium text-white"
                        : "rounded-full border border-ink-200 px-2.5 py-0.5 text-[11px] text-ink-700 hover:bg-ink-50"
                    }
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={doEditSave} disabled={pending} type="button">
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
