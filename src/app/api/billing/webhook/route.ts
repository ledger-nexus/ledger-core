// POST /api/billing/webhook
//
// Stripe webhook receiver. Verifies the signature, parses the event,
// and updates the corresponding Tenant row.
//
// Events handled today:
//
//   - customer.subscription.created   -> populate subscription columns
//   - customer.subscription.updated   -> refresh status + period_end + plan
//   - customer.subscription.deleted   -> clear subscription columns (cancellation)
//   - checkout.session.completed      -> fallback to fill columns if the
//                                        subscription.* event hasn't arrived
//
// Other event types are silently acknowledged so Stripe's "all events"
// listener doesn't generate retries.
//
// Idempotency: every event from Stripe has an id. We don't currently
// dedupe by event id, but the updates are idempotent (UPDATE the same
// columns to the same values), so a replayed event is a no-op.
//
// The tenantId comes from the subscription's metadata (we set it when
// creating the checkout session). If a webhook arrives without a tenant
// in metadata, log and skip — happens for events from before the
// metadata was added.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  verifyAndParseWebhook,
  WebhookVerificationError,
} from "@/lib/billing/verify-webhook";
import { findPlanByPriceId } from "@/lib/billing/plans";
import { getSubscription } from "@/lib/billing/stripe-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Subset of Stripe.Event we actually read.
interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: StripeSubscriptionObject | StripeCheckoutSessionObject;
  };
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
    return NextResponse.json(
      {
        ok: false,
        error: "STRIPE_WEBHOOK_SECRET env var is not set; webhook endpoint disabled.",
      },
      { status: 503 }
    );
  }

  // CRITICAL: must read the raw body before any JSON parsing — the
  // signature is computed over the verbatim string.
  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature");

  let event: StripeEvent;
  try {
    event = verifyAndParseWebhook<StripeEvent>(rawBody, sigHeader, secret);
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      // Don't echo the verification details — keeps timing-side-channel
      // analysis less useful for attackers.
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
          event.data.object as StripeSubscriptionObject
        );
        break;

      case "customer.subscription.deleted":
        await clearSubscription(event.data.object as StripeSubscriptionObject);
        break;

      case "checkout.session.completed": {
        // After payment, Stripe sends checkout.session.completed before
        // (or alongside) subscription.created. We fetch the subscription
        // here so the Tenant row is up-to-date the moment the user
        // returns to /admin/billing?status=success.
        const session = event.data.object as StripeCheckoutSessionObject;
        if (session.subscription) {
          const sub = await getSubscription(session.subscription);
          await applySubscriptionState({
            id: sub.id,
            status: sub.status,
            current_period_end: sub.current_period_end,
            customer: typeof sub.metadata.customer === "string"
              ? sub.metadata.customer
              : session.customer || "",
            metadata: sub.metadata,
            items: sub.items,
          });
        }
        break;
      }

      default:
        // Acknowledge unknown events so Stripe doesn't retry. We log so
        // the operator can spot if a new event type should be handled.
        console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
    }
  } catch (e) {
    // Don't return 500 to Stripe — it'll retry forever. Log loudly
    // and ack so a poison event doesn't lock the queue.
    console.error("[stripe-webhook] handler error", event.type, e);
  }

  return NextResponse.json({ ok: true, received: event.id });
}

async function applySubscriptionState(sub: StripeSubscriptionObject): Promise<void> {
  // Resolve tenantId from subscription metadata. We set this when
  // creating the checkout session so the webhook can find the right
  // Tenant row without a Stripe API roundtrip.
  const tenantId = sub.metadata?.tenantId;
  if (!tenantId) {
    console.warn(
      `[stripe-webhook] subscription ${sub.id} has no tenantId metadata; skipping`
    );
    return;
  }

  // Derive plan key from the price's lookup_key when present, else
  // map via the local plan catalog.
  const priceId = sub.items?.data?.[0]?.price?.id;
  const lookup = sub.items?.data?.[0]?.price?.lookup_key;
  let planKey = lookup ?? null;
  if (!planKey && priceId) {
    planKey = findPlanByPriceId(priceId)?.key ?? null;
  }

  // Resolve the plan's default AI spend cap. If the tenant has no
  // explicit override (monthlyAiSpendCapUsd IS NULL), seed it from
  // the plan's default so the companion repos enforce a plan-appropriate
  // cap. Explicit operator overrides are sticky — we never clobber
  // a non-null column.
  const plan = planKey ? findPlanByPriceId(priceId ?? "") ?? null : null;
  // Fall back to the catalog lookup-by-key when lookup_key is present
  // but findPlanByPriceId missed it.
  const planFromKey = planKey
    ? (await import("@/lib/billing/plans")).findPlan(planKey)
    : null;
  const planDefaultCap =
    plan?.defaultAiSpendCapUsd ?? planFromKey?.defaultAiSpendCapUsd ?? null;

  const existing = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { monthlyAiSpendCapUsd: true },
  });
  const shouldSeedCap =
    existing?.monthlyAiSpendCapUsd == null && planDefaultCap != null;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      billingPlan: planKey,
      ...(shouldSeedCap ? { monthlyAiSpendCapUsd: planDefaultCap } : {}),
    },
  });
}

async function clearSubscription(sub: StripeSubscriptionObject): Promise<void> {
  const tenantId = sub.metadata?.tenantId;
  if (!tenantId) {
    console.warn(
      `[stripe-webhook] subscription ${sub.id} has no tenantId metadata; skipping cancellation`
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
}
