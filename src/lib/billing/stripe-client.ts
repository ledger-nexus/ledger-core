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

// ─── Billing Meter Events ──────────────────────────────────────────────────
//
// For usage-based metering. The flow:
//
//   1. Operator creates a Meter in Stripe (dashboard or API) with
//      event_name = STRIPE_AI_METER_EVENT_NAME env (e.g. "ai_token_cents")
//      and aggregation_formula = "sum".
//
//   2. Operator creates a Price tied to that meter (e.g. "$0.01 per
//      unit" for pass-through, or higher for markup) and adds it as
//      a subscription item to each tenant's subscription.
//
//   3. This module's daily cron POSTs one meter event per tenant per
//      day with the dollar-cents of Anthropic spend for that tenant
//      on that day. Stripe sums events during the billing period and
//      includes the total on the invoice.
//
// See https://docs.stripe.com/billing/subscriptions/usage-based for
// the full Stripe-side setup.

export interface StripeMeterEventInput {
  /** Meter event_name configured in the Stripe Meter (e.g. "ai_token_cents"). */
  eventName: string;
  /** Stripe Customer id (cus_...) the usage belongs to. */
  customerId: string;
  /** Unit value to add to the meter — usually integer for "cents", "tokens", etc. */
  value: number;
  /**
   * Unix timestamp (seconds). When omitted, Stripe uses request-receipt
   * time. We pass an explicit time so we can re-report yesterday's
   * usage even when the cron runs at 1am the next day.
   */
  timestamp?: number;
  /** Optional client-side identifier for idempotency on Stripe's side. */
  identifier?: string;
}

export interface StripeMeterEventResult {
  identifier: string;
  event_name: string;
  payload: {
    stripe_customer_id: string;
    value: string;
  };
  created: number;
}

export async function createMeterEvent(
  input: StripeMeterEventInput
): Promise<StripeMeterEventResult> {
  // Stripe expects "payload[stripe_customer_id]" + "payload[value]".
  // The form encoder handles bracket notation for nested objects.
  return stripePost<StripeMeterEventResult>("/billing/meter_events", {
    event_name: input.eventName,
    payload: {
      stripe_customer_id: input.customerId,
      // value must be a number-as-string for the Stripe wire format.
      value: String(input.value),
    },
    ...(input.timestamp != null ? { timestamp: input.timestamp } : {}),
    ...(input.identifier ? { identifier: input.identifier } : {}),
  });
}
