"use client";

// BlackLine arc — Phase 3 PR 3: per-line commentary form.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { addFluxLineCommentary } from "@/app/actions/flux";

interface Props {
  lineId: string;
  initialValue: string;
  placeholder?: string;
}

export default function CommentaryForm({
  lineId,
  initialValue,
  placeholder,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) {
      setError("Commentary cannot be empty");
      return;
    }
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const r = await addFluxLineCommentary({
        lineId,
        commentary: value.trim(),
      });
      if (!r.ok) {
        setError(r.error);
      } else {
        setSuccess(true);
        setValue("");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSuccess(false);
        }}
        rows={2}
        maxLength={4000}
        placeholder={placeholder ?? "Explain this variance..."}
        disabled={pending}
        className="block w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-xs text-ink-900 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || !value.trim()}>
          {pending ? "..." : "Save"}
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
        {success && <span className="text-xs text-emerald-600">Saved</span>}
      </div>
    </form>
  );
}
