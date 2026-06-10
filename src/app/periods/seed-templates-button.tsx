"use client";

// BlackLine arc — Phase 2 PR 6: first-run seed button.
//
// Renders on the Periods page when the tenant has zero CloseTaskTemplate
// rows. One click upserts the canonical 50 (admin-gated, audit-logged
// at the Server Action layer). Subsequent clicks are idempotent.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { seedCloseTaskTemplatesAction } from "@/app/actions/seed-close-task-templates";

export default function SeedTemplatesButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleClick() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const r = await seedCloseTaskTemplatesAction();
      if (!r.ok) {
        setError(r.error);
      } else {
        setResult(`Seeded ${r.upserted} templates`);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={handleClick} disabled={pending}>
        {pending ? "Seeding..." : "Seed 50 templates"}
      </Button>
      {result && <span className="text-xs text-emerald-700">{result}</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
