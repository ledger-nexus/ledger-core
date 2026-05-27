// Minimal Stripe HTTP client. Stripe's REST API is stable + well-
// documented; the official SDK adds ~1MB and pulls in node-fetch
// polyfills that conflict with Next.js's runtime. We only need four
// endpoints (create customer, create checkout session, create billing
// portal session, retrieve subscription) — direct fetch is cleaner.
//
// Webhook signature verification is the one piece that benefits from
// well-tested code; ./verify-webhook.ts implements Stripe's documented
// HMAC-SHA256 scheme.

const STRIPE_API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 10_000;

function apiKey(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) {
    throw new Error(
      "STRIPE_SECRET_KEY env var is not set. Billing endpoints are disabled until it's configured."
    );
  }
  return k;
}

// Stripe accepts application/x-www-form-urlencoded with bracket
// notation for nested fields. We build that here from a flat object.
// Values that are arrays use [0], [1], etc.
function toFormBody(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, idx) => {
        parts.push(`${encodeURIComponent(`${k}[${idx}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        if (nv == null) continue;
        parts.push(`${encodeURIComponent(`${k}[${nk}]`)}=${encodeURIComponent(String(nv))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join("&");
}

async function stripePost<T>(path: string, body: Record<string, unknown>): Promise<T> {
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
      const msg = (json as { error?: { message?: string } })?.error?.message ?? res.statusText;
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
      const msg = (json as { error?: { message?: string } })?.error?.message ?? res.statusText;
      throw new Error(`Stripe GET ${path} failed: ${msg}`);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public surface ─────────────────────────────────────────────────────

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
  current_period_end: number; // unix timestamp seconds
  items: {
    data: Array<{ price: { id: string; lookup_key?: string | null } }>;
  };
  metadata: Record<string, string>;
}

export async function getSubscription(id: string): Promise<StripeSubscription> {
  return stripeGet<StripeSubscription>(`/subscriptions/${id}`);
}
