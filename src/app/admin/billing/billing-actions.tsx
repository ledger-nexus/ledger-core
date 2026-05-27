"use client";

// Client-side buttons that POST to /api/billing/{checkout,portal} and
// redirect the browser to the returned Stripe URL. Pending state via
// useTransition; errors surface inline.

import { useState, useTransition } from "react";

export function CheckoutButton({ plan }: { plan: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plan }),
        });
        const body = (await res.json()) as { ok: boolean; url?: string; error?: string };
        if (!body.ok || !body.url) {
          setError(body.error ?? "Failed to start checkout");
          return;
        }
        window.location.href = body.url;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      }
    });
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={pending}
        className="h-9 inline-flex w-full items-center justify-center rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-50"
      >
        {pending ? "Starting..." : "Subscribe"}
      </button>
      {error && (
        <div className="mt-2 text-[11px] text-negative">{error}</div>
      )}
    </div>
  );
}

export function PortalButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/billing/portal", { method: "POST" });
        const body = (await res.json()) as { ok: boolean; url?: string; error?: string };
        if (!body.ok || !body.url) {
          setError(body.error ?? "Failed to open portal");
          return;
        }
        window.location.href = body.url;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      }
    });
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={pending}
        className="h-9 inline-flex items-center rounded-md border border-ink-300 bg-white px-4 text-sm font-medium text-ink-900 hover:bg-ink-50 disabled:opacity-50"
      >
        {pending ? "Opening..." : "Manage subscription"}
      </button>
      {error && (
        <div className="mt-2 text-[11px] text-negative">{error}</div>
      )}
    </div>
  );
}
