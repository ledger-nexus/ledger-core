// Minimal Stripe HTTP client.
//
// We need four calls — create customer, create checkout session, create
// portal session, retrieve subscription — and Stripe's REST surface for
// those is stable and well documented. The official SDK is ~1MB and
// brings fetch polyfills that fight with the Next.js runtime, so direct
// fetch is the smaller and clearer dependency here.
//
// The one place hand-rolling would be a mistake is webhook signature
// verification, and that is not hand-rolled loosely: ./verify-webhook.ts
// implements Stripe's documented HMAC-SHA256 scheme with node:crypto's
// timingSafeEqual.
//
// Every function here throws if STRIPE_SECRET_KEY is unset. That is the
// intended behavior: without the key there is nothing to talk to, and
// the callers (route handlers) turn the throw into a 500 with the reason
// rather than pretending a checkout started.

const STRIPE_API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 10_000;

function apiKey(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) {
    throw new Error(
      "STRIPE_SECRET_KEY env var is not set. Billing endpoints are disabled until it is configured."
    );
  }
  return k;
}

// Stripe takes application/x-www-form-urlencoded with bracket notation
// for nested fields. Arrays become key[0], key[1]; plain objects become
// key[childKey].
function toFormBody(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, idx) => {
        parts.push(
          `${encodeURIComponent(`${k}[${idx}]`)}=${encodeURIComponent(String(item))}`
        );
      });
    } else if (typeof v === "object") {
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        if (nv == null) continue;
        parts.push(
          `${encodeURIComponent(`${k}[${nk}]`)}=${encodeURIComponent(String(nv))}`
        );
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join("&");
}

async function stripePost<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${STRIPE_API}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey()}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: toFormBody(body),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok) {
      const msg =
        (json as { error?: { message?: string } })?.error?.message ??
        res.statusText;
      throw new Error(`Stripe ${path} failed: ${msg}`);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

async function stripeGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${STRIPE_API}${path}`, {
      headers: { authorization: `Bearer ${apiKey()}` },
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok) {
      const msg =
        (json as { error?: { message?: string } })?.error?.message ??
        res.statusText;
      throw new Error(`Stripe GET ${path} failed: ${msg}`);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public surface ───────────────────────────────────────────────────

export interface StripeCustomer {
  id: string;
  email: string | null;
  metadata: Record<string, string>;
}

export async function createCustomer(input: {
  email: string;
  name: string;
  tenantId: string;
}): Promise<StripeCustomer> {
  return stripePost<StripeCustomer>("/customers", {
    email: input.email,
    name: input.name,
    // The webhook resolves which workspace an event belongs to from
    // this metadata, so it has to be set at creation.
    "metadata[tenantId]": input.tenantId,
  });
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

export async function createCheckoutSession(input: {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  tenantId: string;
}): Promise<StripeCheckoutSession> {
  return stripePost<StripeCheckoutSession>("/checkout/sessions", {
    mode: "subscription",
    customer: input.customerId,
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": 1,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    "metadata[tenantId]": input.tenantId,
    // Stamped on the SUBSCRIPTION too, not just the session: every
    // later customer.subscription.* webhook carries subscription
    // metadata, and that is the only tenant pointer those events have.
    "subscription_data[metadata][tenantId]": input.tenantId,
  });
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export async function createPortalSession(input: {
  customerId: string;
  returnUrl: string;
}): Promise<StripePortalSession> {
  return stripePost<StripePortalSession>("/billing_portal/sessions", {
    customer: input.customerId,
    return_url: input.returnUrl,
  });
}

export interface StripeSubscription {
  id: string;
  status: string;
  /** Unix timestamp, seconds. */
  current_period_end: number;
  customer: string;
  items: {
    data: Array<{ price: { id: string; lookup_key?: string | null } }>;
  };
  metadata: Record<string, string>;
}

export async function getSubscription(id: string): Promise<StripeSubscription> {
  return stripeGet<StripeSubscription>(`/subscriptions/${id}`);
}
