# Billing setup (Stripe)

What you need to configure in the Stripe Dashboard + your env to make
`/admin/billing` work.

## 1. Stripe account + API keys

1. Create a Stripe account (or pick a test-mode account for staging).
2. In **Developers → API keys**, copy the **Secret key**:
   ```
   STRIPE_SECRET_KEY=sk_test_...   # or sk_live_... in production
   ```

## 2. Products + prices

For each plan you want to sell, create one **Product** with one
**Price** (recurring monthly). Set the price's `lookup_key` to match
the plan's `key` in `src/lib/billing/plans.ts`. The current catalog:

| Plan key  | Suggested label | Suggested price |
|-----------|-----------------|-----------------|
| `starter` | Starter         | $49 / month     |
| `growth`  | Growth          | $199 / month    |
| `scale`   | Scale           | $799 / month    |

Copy each Price's id (looks like `price_...`) into env:

```
STRIPE_PRICE_STARTER=price_1A...
STRIPE_PRICE_GROWTH=price_1B...
STRIPE_PRICE_SCALE=price_1C...
```

Plans without a configured Price id render as "not configured" on the
billing page — the catalog gracefully degrades.

## 3. Webhook endpoint

1. In **Developers → Webhooks**, click **Add endpoint**.
2. URL: `https://<your-domain>/api/billing/webhook`
3. Subscribe to these events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `checkout.session.completed`
4. Copy the **Signing secret** (starts with `whsec_`) into env:
   ```
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

## 4. Billing Portal config

Stripe needs the Billing Portal "branding" to be configured before
`/api/billing/portal` will work. Visit **Settings → Billing → Customer
portal** in the Stripe dashboard and click **Save** at the bottom
(defaults are fine for v1).

## 5. App env

```
APP_BASE_URL=https://app.example.com   # for success/cancel + portal return URLs
```

## 6. Verify the loop

1. As the workspace OWNER, visit `/admin/billing`.
2. Click **Subscribe** on a plan. You should be redirected to Stripe Checkout.
3. Use a test card (`4242 4242 4242 4242`, any future date, any CVC).
4. After payment, you're redirected back to `/admin/billing?status=success`.
5. Within a few seconds (the webhook fires async), the page shows your
   active subscription.
6. Click **Manage subscription** to confirm the portal opens.

## 7. Usage-based metering (AI tokens)

Optional but recommended once you have Growth/Scale customers: bill
heavy AI users for their actual Anthropic spend on top of the flat
plan price. Configuration:

1. **Create a Meter** in Stripe dashboard (**Billing → Meters → +**):
   - `event_name`: `ai_token_cents` (or any string — copy it to env)
   - `aggregation_formula`: `Sum`
   - `value`: keep `Value` (numeric value posted with each event)

2. **Create a Price** linked to the meter (**Products → + Price** on an
   existing product, or new product "AI usage"):
   - Recurring, usage-based
   - Choose the meter from step 1
   - Pricing model: e.g. `$0.01 per unit` for pass-through (we report
     cents-of-cost, $0.01/unit = $1 of customer cost per $1 we spent).
     For markup, use `$0.015 per unit` (50% markup) etc.

3. **Attach the metered Price** to each subscription that should include
   usage billing. Either:
   - Add as a second subscription item on the existing plan
     (`subscriptions.create({ items: [{price: planPrice}, {price: meterPrice}] })`),
     OR
   - Edit existing subscriptions in the dashboard to add the meter Price.

4. **Set env vars** in your deployment:
   ```
   STRIPE_AI_METER_EVENT_NAME=ai_token_cents   # must match step 1
   CRON_SECRET=<random hex>                    # if not already set
   ```

5. **Verify the cron**: `vercel.json` includes a daily 01:00 UTC entry.
   On the first run, check `/admin/ai-budget` — the "Stripe usage-meter
   reports" section shows one row per tenant with status REPORTED /
   NO_USAGE / NO_SUBSCRIPTION / LOGGED_ONLY / FAILED.

6. **Manual catch-up** for a missed day:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
        "https://<your-domain>/api/cron/report-ai-usage?usageDay=2026-05-15"
   ```

Idempotency: `AiUsageReport` is unique per `(tenantId, usageDay)` and
the Stripe meter event itself uses `identifier=<tenantId>-<usageDay>`
— retries don't double-bill on either side.

## What's deliberately not in this skeleton

- **Tax handling.** Add Stripe Tax in the dashboard if you sell to
  multiple jurisdictions; it doesn't require code changes.
- **Trials.** Add `trial_period_days` to the price in Stripe and they
  flow through to `subscriptionStatus: "trialing"` automatically.
- **Plan-change preview.** Today the Stripe portal handles upgrades /
  downgrades. A native preview ("you'll be charged $X prorated") would
  use `/v1/invoices/upcoming` and is a follow-up.
- **Coupons / promo codes.** Configure in the Stripe dashboard; the
  checkout session can pass `allow_promotion_codes: true` if needed.
- **Cancellation grace periods.** The webhook clears the subscription
  immediately on `customer.subscription.deleted`. For an at-period-end
  cancellation, check `subscription.cancel_at_period_end` and keep the
  row populated until the deletion event arrives.
