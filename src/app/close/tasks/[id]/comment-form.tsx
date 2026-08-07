"use client";

// BlackLine arc — Phase 2 PR 4: close-task comment form.
//
// Append-only thread. Submits via addCloseTaskComment, which writes a
// CloseTaskComment row + a PRIVILEGED_ACTION audit row + revalidates
// the path. The page re-renders with the new comment at the bottom of
// the thread.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { addCloseTaskComment } from "@/app/actions/close-tasks";

interface Props {
  taskId: string;
}

export default function CommentForm({ taskId }: Props) {
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) {
      setError("Comment cannot be empty");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await addCloseTaskComment({
        taskId,
        body: body.trim(),
      });
      if (!r.ok) {
        setError(r.error);
      } else {
        setBody("");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Add a comment..."
        disabled={pending}
        maxLength={4000}
        className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !body.trim()}>
          {pending ? "Posting..." : "Post comment"}
        </Button>
        <span className="text-xs text-ink-500">
          {body.length}/4000
        </span>
        {error && <span className="text-xs text-negative">{error}</span>}
      </div>
    </form>
  );
}
