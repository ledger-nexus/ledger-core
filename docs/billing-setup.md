# Billing setup (Stripe)

Billing ships **dark**. With no Stripe environment variables set — the
state this repo is in today — the app behaves like this:

| Surface | Behavior with no Stripe env |
|---|---|
| `/admin/billing` | Renders. Shows the free tier, real usage counts, and every plan marked "not available". No Subscribe button. |
| `POST /api/billing/checkout` | `503` — `STRIPE_SECRET_KEY` unset. |
| `POST /api/billing/portal` | `503` — same. |
| `POST /api/billing/webhook` | `503` — `STRIPE_WEBHOOK_SECRET` unset. Fails **closed**: an endpoint that writes entitlement must never run on a body it cannot verify. |
| Plan caps | Evaluated, logged, **not enforced** (see `BILLING_ENFORCE_LIMITS` below). |

Every tenant resolves to `FREE_TIER` (3 users, 5 legal entities) until a
signature-verified webhook says otherwise.

---

## 1. Stripe dashboard

1. Create a **Product** per tier you intend to sell.
2. Create one recurring monthly **Price** per product. Set each Price's
   `lookup_key` to the plan key from `src/lib/billing/plans.ts` —
   `starter`, `growth`, `scale`. The webhook resolves the plan from
   `lookup_key` first and falls back to the price id, so setting it
   means a price-id rotation doesn't silently drop everyone to free tier.
3. Enable the **Customer portal** (Settings → Billing → Customer portal)
   and allow plan switching and cancellation.
4. Add a **webhook endpoint** pointed at
   `https://<your-domain>/api/billing/webhook`, subscribed to:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `checkout.session.completed`

   Copy the signing secret (`whsec_…`).

The dollar figures in `plans.ts` are display-only placeholders. Set the
real numbers there in the same change where you create the Prices, so
the page and Stripe agree.

## 2. Environment variables

```
STRIPE_SECRET_KEY=sk_live_...        # or sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_BASE_URL=https://your-domain     # absolute origin, no trailing slash
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_SCALE=price_...
```

A plan whose `STRIPE_PRICE_*` is unset renders as unavailable and cannot
be checked out — that is the mechanism for selling only some tiers.

`APP_BASE_URL` builds the Stripe success/cancel/return URLs. Without it
checkout and portal return `503` rather than sending a customer to a
broken redirect.

> `STRIPE_SECRET_KEY` without `STRIPE_WEBHOOK_SECRET` is the one
> genuinely bad configuration: customers can pay, and nothing ever marks
> them subscribed. Set both or neither.

## 3. Turning caps on

```
BILLING_ENFORCE_LIMITS=true
```

Off by default. In soft mode the caps still run and log what they *would*
have blocked (`[plan-limit] … would-block …`), so you can measure the
blast radius before enforcing.

Read the logs before flipping this. Today no tenant has a subscription,
so every workspace evaluates as free tier — turning enforcement on
without a plan in place caps every existing workspace at 3 users and 5
entities immediately.

Caps refuse the **next** write and never remove existing rows. A tenant
that downgrades keeps everything it has and is simply refused additions
until it fits.

## 4. Verifying

Local webhook testing with the Stripe CLI:

```bash
stripe listen --forward-to localhost:3010/api/billing/webhook
```

`stripe listen` prints its own `whsec_…` — use that one locally, not the
dashboard's.

Then, in another shell:

```bash
stripe trigger customer.subscription.created
```

The tenant row updates only if the subscription carries
`metadata.tenantId`. Our checkout stamps that automatically
(`subscription_data[metadata][tenantId]`); a bare `stripe trigger`
does not, so a triggered event will log
`subscription … has no tenantId metadata; skipping` and change nothing.
That is the correct behavior — an event we can't attribute to a
workspace is dropped, not guessed at, and Stripe will resend real ones.

## Known gaps

- **The NetSuite multi-subsidiary import bypasses the entity cap.**
  `src/lib/mappers/netsuite/subsidiaries.ts` creates `LegalEntity` rows
  through the mapper layer against the default tenant rather than the
  session tenant, and does not call `assertCanCreateEntity`. A
  30-subsidiary import walks past a cap of 5. Closing it means giving
  the importer a session-tenant seam.
- **No usage-based metering.** The `#46` branch carried a daily
  Stripe billing-meter cron that reported Anthropic token spend. It
  reads `ai_suggestion` / `ai_extraction_suggestion` /
  `ai_asset_suggestion`, none of which exist in this schema, so it was
  left out of this slice rather than shipped as dead code.
- **No dunning UI.** A `past_due` workspace silently drops to free-tier
  caps and sees a line on `/admin/billing`. Nobody emails them.
