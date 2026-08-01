"use client";

// The two buttons that leave the app for Stripe.
//
// Both POST to their route, read back a URL, and hand the browser over.
// Neither one touches Stripe directly — the secret key never reaches a
// client bundle, and the session URL is minted server-side against the
// caller's own tenant, so there is nothing here a user could point at
// someone else's workspace.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

interface StripeUrlResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

function useStripeRedirect(endpoint: string, body?: unknown) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function go() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          ...(body !== undefined
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        });
        const json = (await res.json()) as StripeUrlResponse;
        if (!json.ok || !json.url) {
          setError(json.error ?? "Stripe did not return a URL.");
          return;
        }
        window.location.href = json.url;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      }
    });
  }

  return { pending, error, go };
}

export function CheckoutButton({ plan }: { plan: string }) {
  const { pending, error, go } = useStripeRedirect("/api/billing/checkout", {
    plan,
  });
  return (
    <div>
      <Button onClick={go} disabled={pending} className="w-full">
        {pending ? "Starting…" : "Subscribe"}
      </Button>
      {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

export function PortalButton() {
  const { pending, error, go } = useStripeRedirect("/api/billing/portal");
  return (
    <div>
      <Button variant="outline" onClick={go} disabled={pending}>
        {pending ? "Opening…" : "Manage subscription"}
      </Button>
      {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
