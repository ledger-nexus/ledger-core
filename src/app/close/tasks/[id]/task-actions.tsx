"use client";

// BlackLine arc — Phase 2 PR 4: close-task action island.
//
// Wires PR 2's 7 status actions to the detail page. State machine:
//
//   NOT_STARTED  → [Start] [Block] [Reassign] [Waive (admin)]
//   IN_PROGRESS  → [Complete] [Block] [Reassign] [Waive (admin)]
//   BLOCKED      → [Unblock] [Reassign] [Waive (admin)]
//
// Complete + Block + Waive switch into a sub-form:
//   Complete   → evidence URL + note (both optional)
//   Block      → mandatory reason
//   Waive      → mandatory reason
//
// Reassign in v1 is "click to claim" — a button that calls
// reassignTask with the current user's id and ownerType=USER. This
// covers the most common case ("I'll take this") without requiring
// the user-picker autocomplete the design doc punts on. A full
// user-picker arrives in a later PR if customer demand surfaces.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  startTask,
  completeTask,
  blockTask,
  unblockTask,
  reassignTask,
  waiveTask,
} from "@/app/actions/close-tasks";
import type { CloseTaskStatus } from "@prisma/client";

interface Props {
  taskId: string;
  status: CloseTaskStatus;
  canStart: boolean;
  ownerId: string | null;
  currentUserId: string;
  admin: boolean;
}

type Mode = "idle" | "complete" | "block" | "waive";

export default function TaskActions({
  taskId,
  status,
  canStart,
  ownerId,
  currentUserId,
  admin,
}: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMode("idle");
    setEvidenceUrl("");
    setEvidenceNote("");
    setReason("");
    setError(null);
  }

  function handleStart() {
    setError(null);
    startTransition(async () => {
      const r = await startTask({ taskId });
      if (!r.ok) {
        // Re-surface BLOCKED_BY_DEPENDENCY in clear words even though
        // the page already shows the "Waiting on:" hint — covers the
        // race where the user clicked Start before a predecessor
        // re-blocked.
        setError(r.error);
      }
    });
  }

  function handleUnblock() {
    setError(null);
    startTransition(async () => {
      const r = await unblockTask({ taskId });
      if (!r.ok) setError(r.error);
    });
  }

  function handleReassignToMe() {
    setError(null);
    startTransition(async () => {
      const r = await reassignTask({
        taskId,
        ownerId: currentUserId,
        ownerType: "USER",
      });
      if (!r.ok) setError(r.error);
    });
  }

  function handleCompleteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await completeTask({
        taskId,
        evidenceUrl: evidenceUrl.trim() || undefined,
        evidenceNote: evidenceNote.trim() || undefined,
      });
      if (!r.ok) {
        setError(r.error);
      } else {
        reset();
      }
    });
  }

  function handleBlockSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Reason is required");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await blockTask({ taskId, reason: reason.trim() });
      if (!r.ok) {
        setError(r.error);
      } else {
        reset();
      }
    });
  }

  function handleWaiveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Reason is required");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await waiveTask({ taskId, reason: reason.trim() });
      if (!r.ok) {
        if (r.code === "NOT_ADMIN") {
          setError("Only a tenant admin can waive a task");
        } else {
          setError(r.error);
        }
      } else {
        reset();
      }
    });
  }

  // ─── Sub-forms ──────────────────────────────────────────────────
  if (mode === "complete") {
    return (
      <form onSubmit={handleCompleteSubmit} className="flex flex-col gap-3">
        <div>
          <Label htmlFor="evidence-url">Evidence URL (optional)</Label>
          <Input
            id="evidence-url"
            type="url"
            value={evidenceUrl}
            onChange={(e) => setEvidenceUrl(e.target.value)}
            placeholder="https://workpapers.example.com/may-payroll-accrual.pdf"
            disabled={pending}
          />
        </div>
        <div>
          <Label htmlFor="evidence-note">Evidence note (optional)</Label>
          <textarea
            id="evidence-note"
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
            rows={3}
            placeholder="Accrued $12,450 based on May timesheet rollup — see workpaper for detail"
            disabled={pending}
            maxLength={2000}
            className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Completing..." : "Mark complete"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={reset}
            disabled={pending}
          >
            Cancel
          </Button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </form>
    );
  }

  if (mode === "block" || mode === "waive") {
    const isBlock = mode === "block";
    return (
      <form
        onSubmit={isBlock ? handleBlockSubmit : handleWaiveSubmit}
        className="flex flex-col gap-3"
      >
        <div>
          <Label htmlFor="action-reason">
            {isBlock ? "Block reason" : "Waiver reason"}{" "}
            <span className="text-red-600">*</span>
          </Label>
          <textarea
            id="action-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder={
              isBlock
                ? "Waiting on signed bank confirmation from the lender"
                : "N/A for this entity — operations paused for April"
            }
            disabled={pending}
            maxLength={2000}
            autoFocus
            className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
          <div className="mt-1 text-xs text-ink-400">
            {reason.length}/2000 · persists to the audit log
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "..." : isBlock ? "Block task" : "Confirm waive"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={reset}
            disabled={pending}
          >
            Cancel
          </Button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </form>
    );
  }

  // ─── Idle: render the affordance buttons ─────────────────────────
  // Each button's enabled state mirrors PR 2's state machine. Disabled
  // buttons don't hide — non-clickable cues are clearer than missing
  // affordances ("why can't I do X" beats "where did X go").
  const showStart =
    status === "NOT_STARTED" || status === "BLOCKED";
  const showUnblock = status === "BLOCKED";
  const showComplete = status === "IN_PROGRESS";
  const showBlock =
    status === "NOT_STARTED" || status === "IN_PROGRESS";
  const showWaive = admin && status !== "DONE" && status !== "WAIVED";
  const isOwner = ownerId === currentUserId;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showStart && (
        <Button
          onClick={handleStart}
          disabled={pending || (status === "NOT_STARTED" && !canStart)}
          title={
            status === "NOT_STARTED" && !canStart
              ? "Waiting on predecessor tasks"
              : undefined
          }
        >
          {pending ? "..." : status === "BLOCKED" ? "Resume" : "Start"}
        </Button>
      )}
      {showUnblock && (
        <Button onClick={handleUnblock} disabled={pending}>
          {pending ? "..." : "Unblock"}
        </Button>
      )}
      {showComplete && (
        <Button
          onClick={() => {
            setMode("complete");
            setError(null);
          }}
          disabled={pending}
        >
          Mark complete
        </Button>
      )}
      {showBlock && (
        <Button
          variant="ghost"
          onClick={() => {
            setMode("block");
            setError(null);
          }}
          disabled={pending}
        >
          Block
        </Button>
      )}
      {!isOwner && (
        <Button
          variant="ghost"
          onClick={handleReassignToMe}
          disabled={pending}
        >
          {pending ? "..." : "Claim (assign to me)"}
        </Button>
      )}
      {showWaive && (
        <Button
          variant="ghost"
          onClick={() => {
            setMode("waive");
            setError(null);
          }}
          disabled={pending}
        >
          Waive
        </Button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
