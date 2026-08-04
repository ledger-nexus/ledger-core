// POST /api/billing/webhook
//
// The only writer of the Tenant subscription columns. Stripe calls this
// unauthenticated, so the HMAC signature is the entire access control —
// see src/lib/billing/verify-webhook.ts. Nothing below the verify call
// may run on an unverified body.
//
// Events handled:
//
//   customer.subscription.created  → fill the subscription columns
//   customer.subscription.updated  → refresh status / period end / plan
//   customer.subscription.deleted  → clear them (cancellation)
//   checkout.session.completed     → fetch the subscription and fill,
//                                    so the columns are right by the
//                                    time the browser lands back on
//                                    /admin/billing?status=success
//
// Anything else is acknowledged without action so Stripe's "send all
// events" listener does not build a retry backlog.
//
// Tenant resolution comes from subscription metadata.tenantId, stamped
// at checkout-session creation. An event without it is skipped rather
// than guessed at — writing entitlement to a tenant we inferred would
// be worse than dropping the event, which Stripe will resend.
//
// Idempotency: every handler is a plain UPDATE to a fixed set of values
// derived from the event, so a redelivery writes the same row twice and
// changes nothing.
//
// Logging: no raw payload, ever. Stripe event bodies carry customer
// emails and card metadata. Only the event type, event id, and our own
// derived plan key are logged.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  verifyAndParseWebhook,
  WebhookVerificationError,
} from "@/lib/billing/verify-webhook";
import { findPlan, findPlanByPriceId } from "@/lib/billing/plans";
import { getSubscription } from "@/lib/billing/stripe-client";
import { logAuditEvent } from "@/lib/audit/log";
import { redactPii } from "@/lib/soc2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only the fields we read. Stripe sends far more.
interface StripeEvent {
  id: string;
  type: string;
  data: { object: StripeSubscriptionObject | StripeCheckoutSessionObject };
}

interface StripeSubscriptionObject {
  id: string;
  status: string;
  current_period_end: number;
  customer: string;
  metadata?: Record<string, string>;
  items?: {
    data: Array<{ price: { id: string; lookup_key?: string | null } }>;
  };
}

interface StripeCheckoutSessionObject {
  id: string;
  customer: string | null;
  subscription: string | null;
  metadata?: Record<string, string>;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed. With no secret we cannot verify anything, and an
    // endpoint that writes entitlement from unverified input is worse
    // than one that is off.
    return NextResponse.json(
      {
        ok: false,
        error:
          "STRIPE_WEBHOOK_SECRET env var is not set; webhook endpoint disabled.",
      },
      { status: 503 }
    );
  }

  // Raw body BEFORE any parsing — the MAC covers the verbatim bytes.
  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature");

  let event: StripeEvent;
  try {
    event = verifyAndParseWebhook<StripeEvent>(rawBody, sigHeader, secret);
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      // One generic message for every failure mode. Telling a caller
      // *which* check failed (bad timestamp vs bad MAC) hands them a
      // free oracle for probing the endpoint.
      return NextResponse.json(
        { ok: false, error: "Signature verification failed" },
        { status: 400 }
      );
    }
    throw e;
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await applySubscriptionState(
          event.data.object as StripeSubscriptionObject,
          event.id
        );
        break;

      case "customer.subscription.deleted":
        await clearSubscription(
          event.data.object as StripeSubscriptionObject,
          event.id
        );
        break;

      case "checkout.session.completed": {
        const session = event.data.object as StripeCheckoutSessionObject;
        if (session.subscription) {
          const sub = await getSubscription(session.subscription);
          await applySubscriptionState(
            {
              id: sub.id,
              status: sub.status,
              current_period_end: sub.current_period_end,
              customer: sub.customer,
              metadata: sub.metadata,
              items: sub.items,
            },
            event.id
          );
        }
        break;
      }

      default:
        // Acknowledge so Stripe stops retrying. Logged so a new event
        // type we should be handling is visible rather than silent.
        //
        // event.type is off the wire, so it never goes INTO the template
        // string — it rides as a separate, sanitized argument. Anything
        // interpolated into a log line can carry newlines and forge
        // additional log entries.
        console.log("[stripe-webhook] unhandled event type:", safeLabel(event.type));
    }
  } catch (e) {
    // Never 500 back to Stripe: it retries with backoff for days, and
    // a single poison event would keep re-firing. Log and ack.
    console.error(
      "[stripe-webhook] handler error",
      safeLabel(event.type),
      redactPii(e instanceof Error ? e.message : String(e))
    );
  }

  return NextResponse.json({ ok: true, received: event.id });
}

/**
 * Clamp an off-the-wire string to something safe to put in a log line:
 * Stripe's own identifier alphabet, length-capped, with a marker when it
 * isn't. Stops CRLF and control characters from forging log entries, and
 * stops an oversized field from flooding the log.
 */
function safeLabel(value: unknown): string {
  if (typeof value !== "string") return "<non-string>";
  const trimmed = value.slice(0, 64);
  return /^[A-Za-z0-9_.:-]*$/.test(trimmed) ? trimmed : "<unprintable>";
}

/**
 * Resolve which plan a subscription is on.
 *
 * lookup_key first (we set it to match our catalog key when creating
 * the Stripe Price), price id second. A subscription on a price we
 * don't recognize resolves to null → the tenant reads as free tier,
 * which is the safe direction to be wrong in.
 */
function resolvePlanKey(sub: StripeSubscriptionObject): string | null {
  const price = sub.items?.data?.[0]?.price;
  if (!price) return null;
  const byLookup = findPlan(price.lookup_key ?? null);
  if (byLookup) return byLookup.key;
  return findPlanByPriceId(price.id)?.key ?? null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pull the tenant pointer out of subscription metadata, or null.
 *
 * Metadata is free-form on Stripe's side — anyone with dashboard access
 * to the connected account can type anything into it. Requiring a UUID
 * means a malformed pointer is a clean skip rather than a Prisma P2023
 * thrown deep in the handler and swallowed by the outer catch.
 */
function resolveTenantId(sub: StripeSubscriptionObject): string | null {
  const raw = sub.metadata?.tenantId;
  if (!raw || !UUID_RE.test(raw)) return null;
  return raw;
}

async function applySubscriptionState(
  sub: StripeSubscriptionObject,
  eventId: string
): Promise<void> {
  const tenantId = resolveTenantId(sub);
  if (!tenantId) {
    console.warn(
      "[stripe-webhook] subscription has no tenantId metadata; skipping:",
      safeLabel(sub.id)
    );
    return;
  }

  const planKey = resolvePlanKey(sub);

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      billingPlan: planKey,
    },
  });

  // Entitlement changed for a workspace with no human actor in scope —
  // CONFIG_CHANGE with a null actor is the honest shape. Metadata holds
  // plan key and status only: no email, no amount.
  await logAuditEvent({
    eventType: "CONFIG_CHANGE",
    action: "billing.subscription_updated",
    tenantId,
    resource: "Tenant",
    resourceId: tenantId,
    metadata: {
      source: "stripe-webhook",
      stripeEventId: eventId,
      subscriptionId: sub.id,
      status: sub.status,
      plan: planKey,
    },
  });
}

async function clearSubscription(
  sub: StripeSubscriptionObject,
  eventId: string
): Promise<void> {
  const tenantId = resolveTenantId(sub);
  if (!tenantId) {
    console.warn(
      "[stripe-webhook] subscription has no tenantId metadata; skipping cancellation:",
      safeLabel(sub.id)
    );
    return;
  }
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeSubscriptionId: null,
      subscriptionStatus: "canceled",
      currentPeriodEnd: null,
      billingPlan: null,
    },
  });

  await logAuditEvent({
    eventType: "CONFIG_CHANGE",
    action: "billing.subscription_canceled",
    tenantId,
    resource: "Tenant",
    resourceId: tenantId,
    metadata: {
      source: "stripe-webhook",
      stripeEventId: eventId,
      subscriptionId: sub.id,
    },
  });
}
