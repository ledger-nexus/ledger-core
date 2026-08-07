"use client";

// BlackLine arc — Phase 3 PR 3: flux statement generate form.
//
// Calls generateFluxStatement, then router.push to the new detail
// page on success. Idempotent: existing (entity, book, from, to)
// tuple updates in place rather than duplicating.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { generateFluxStatement } from "@/app/actions/flux";

interface Props {
  entities: { code: string; name: string }[];
  books: { code: string; name: string }[];
  periods: { code: string; endsOn: string }[];
}

export default function GenerateForm({ entities, books, periods }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const defaultEntity = entities[0]?.code ?? "";
  const defaultBook = books.find((b) => b.code === "US_GAAP")?.code ?? books[0]?.code ?? "";
  const defaultTo = periods[0]?.code ?? "";
  const defaultFrom = periods[1]?.code ?? "";

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      entityCode: String(fd.get("entityCode") ?? ""),
      bookCode: String(fd.get("bookCode") ?? ""),
      fromPeriodCode: String(fd.get("fromPeriodCode") ?? ""),
      toPeriodCode: String(fd.get("toPeriodCode") ?? ""),
      absoluteThreshold: String(fd.get("absoluteThreshold") ?? "0"),
      percentThreshold: String(fd.get("percentThreshold") ?? "0"),
    };

    if (payload.fromPeriodCode === payload.toPeriodCode) {
      setError("From and To periods must differ");
      return;
    }

    startTransition(async () => {
      const r = await generateFluxStatement(payload);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(`/close/flux/${r.statementId}`);
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
    >
      <div>
        <Label htmlFor="entity">Entity</Label>
        <select
          id="entity"
          name="entityCode"
          defaultValue={defaultEntity}
          disabled={pending}
          className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900"
        >
          {entities.map((e) => (
            <option key={e.code} value={e.code}>
              {e.code} — {e.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="book">Book</Label>
        <select
          id="book"
          name="bookCode"
          defaultValue={defaultBook}
          disabled={pending}
          className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900"
        >
          {books.map((b) => (
            <option key={b.code} value={b.code}>
              {b.code}
            </option>
          ))}
        </select>
      </div>
      <div></div>
      <div>
        <Label htmlFor="fromPeriod">From period (prior)</Label>
        <select
          id="fromPeriod"
          name="fromPeriodCode"
          defaultValue={defaultFrom}
          disabled={pending}
          className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm font-mono"
        >
          {periods.map((p) => (
            <option key={p.code} value={p.code}>
              {p.code} ({p.endsOn})
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="toPeriod">To period (current)</Label>
        <select
          id="toPeriod"
          name="toPeriodCode"
          defaultValue={defaultTo}
          disabled={pending}
          className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm font-mono"
        >
          {periods.map((p) => (
            <option key={p.code} value={p.code}>
              {p.code} ({p.endsOn})
            </option>
          ))}
        </select>
      </div>
      <div></div>
      <div>
        <Label htmlFor="absoluteThreshold">Absolute threshold ($)</Label>
        <Input
          id="absoluteThreshold"
          name="absoluteThreshold"
          type="text"
          inputMode="decimal"
          defaultValue="5000"
          disabled={pending}
        />
      </div>
      <div>
        <Label htmlFor="percentThreshold">Percent threshold (%)</Label>
        <Input
          id="percentThreshold"
          name="percentThreshold"
          type="text"
          inputMode="decimal"
          defaultValue="10"
          disabled={pending}
        />
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <Button type="submit" disabled={pending}>
          {pending ? "Generating..." : "Generate"}
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </form>
  );
}
