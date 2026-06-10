# Deployment — Vercel + Neon

This guide takes you from a fresh repo to a live URL in ~10 minutes. The stack is deliberately conventional (Next.js on Vercel, Postgres on Neon) so the moving parts are well-understood.

---

## Prerequisites

- A GitHub account with the `ledger-core` repo (fork or clone)
- A free Vercel account ([vercel.com](https://vercel.com))
- A free Neon account ([neon.tech](https://neon.tech)) — generous Postgres free tier with `gen_random_uuid()` support enabled out of the box

---

## Step 1: Provision Postgres on Neon

1. Sign in at [neon.tech](https://neon.tech) and click **New Project**.
2. Name it `ledger-core`. Pick the closest region.
3. Once created, open **Connection Details** and copy the **Pooled connection string** (it ends with `-pooler` and is the right one for Vercel serverless). It looks like:
   ```
   postgresql://username:password@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. The schema uses `gen_random_uuid()` (Postgres 13+) and `pgcrypto` is enabled by default on Neon. Nothing else to configure.

## Step 2: Push the schema to Neon

From your local machine:

```bash
git clone https://github.com/ledger-nexus/ledger-core.git
cd ledger-core
pnpm install
cp .env.example .env
# Paste the Neon connection string into DATABASE_URL in .env
pnpm db:push       # creates all the ledger-core tables
pnpm db:seed       # loads the Northwind multi-book demo
pnpm test          # confirms invariants hold against the live DB
```

The seed produces ~150 journal entries across three books (US_GAAP, US_TAX, IFRS) with all sub-ledgers populated. The headline assertions (multi-book divergence, AR/AP reconciliation, book-tax difference) verify in under 30 seconds.

## Step 3: Deploy to Vercel

1. Open [vercel.com/new](https://vercel.com/new) and import the GitHub repo.
2. Framework: **Next.js** (auto-detected).
3. Environment Variables:
   - `DATABASE_URL` — paste the same Neon **pooled** connection string.
4. Build settings (defaults are correct):
   - Build command: `prisma generate && next build`
   - Install command: `pnpm install` (or `npm install`)
5. Click **Deploy**.

First deploy takes ~2 minutes. Subsequent pushes auto-deploy on the `main` branch.

### Vercel build hook

The `vercel.json` in the repo wires `prisma generate` into the build so the Prisma client is generated against the deployed schema each time. No manual step.

## Step 4: Verify the live demo

Open the Vercel URL. You should see:

- The dashboard with KPI cards (Cash, AR, AP, Fixed-asset NBV, BTD vs US_TAX)
- A working multi-book switcher in the header (top-right card)
- All four reports populated (Trial Balance, Income Statement, Balance Sheet, Book-Tax Difference)
- The chart of accounts grouped by type
- 150+ journal entries in the list, each with detail view + lineage payload

### Sanity checks

| Page | What to check |
|---|---|
| `/` | Net income YTD on US_GAAP is around **−$25,000** for the seed (you spent more than you earned in H1) |
| `/reports/book-tax-difference` | Total delta (book − tax) is around **−$41,600** — the dollar value of GAAP vs cash-basis-tax divergence on Globex + fixed-asset depreciation |
| `/reports/balance-sheet` | "A = L + E ✓" badge is green |
| `/journal-entries` | Switching the book in the header from `US_GAAP` → `US_TAX` shows different counts and amounts |

---

## Resetting the live demo

Random visitors will post test entries via `/journal-entries/new` and apply payments on `/ar` and `/ap`. To return to a clean Northwind state without touching the deployment:

### Option 1 — POST /api/admin/reset

Live since v0.8. Authenticated by an `ADMIN_TOKEN` env var.

1. **Set the token** in Vercel (Settings → Environment Variables):
   ```
   ADMIN_TOKEN=<a long random string you generate locally>
   ```
   (e.g. `openssl rand -hex 32`)

2. **Trigger the reset**:
   ```bash
   curl -X POST https://your-demo.vercel.app/api/admin/reset \
        -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

   Response:
   ```json
   { "ok": true, "cleared": true, "entriesAfter": 148, "elapsedMs": 4203 }
   ```

   The endpoint clears all NORTHWIND-scoped transactional + sub-ledger
   data and re-runs `seedNorthwind`. QBO/NetSuite-imported entities
   (other entity codes) are untouched.

   If the token is unset, the endpoint fails closed with a 503 — so
   you can leave it absent in development and the endpoint stays dormant.

3. **Schedule it** with Vercel Cron (optional). Add to `vercel.json`:
   ```json
   {
     "crons": [
       {
         "path": "/api/admin/reset",
         "schedule": "0 6 * * *"
       }
     ]
   }
   ```
   That runs the reset daily at 06:00 UTC. Note: Vercel Cron sends GET
   by default; you'd need a tiny rewrite wrapper or move the logic into
   a GET handler with bearer-token check. For the v0.8 demo, manual
   triggers are sufficient.

### Option 2 — `pnpm db:reset` (local with prod DATABASE_URL)

For a truly clean slate (drops every table, re-runs migrations, re-seeds):

```bash
DATABASE_URL=<neon-pooled-url> pnpm db:reset
```

This is destructive — it also drops QBO/NS-imported entities. Use Option 1 unless you want a from-scratch wipe.

---

## Slack notifier (optional)

The close-management surface ships with a Slack notifier that pings configured webhooks when high-severity close alerts appear (recon `EXCEPTION`, required blocked task, flux statement with stale `NEEDS_COMMENT`). Setup takes ~5 minutes.

### Environment variables

Two env vars need to be set in **Vercel → Settings → Environment Variables** for the notifier to function. Both should be **encrypted (sensitive)** and scoped to **Production + Preview**:

| Name | Purpose | Generate |
|---|---|---|
| `WEBHOOK_ENCRYPTION_KEY` | AES-256-GCM key that encrypts every channel's webhook URL at rest. Stored in the `notification_channel.webhookUrl` column as ciphertext; never logged. | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (32 bytes, base64) |
| `CRON_SECRET` | Shared secret that gates `POST /api/cron/close-alerts-dispatch`. The cron worker passes it as `Authorization: Bearer <CRON_SECRET>`. | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (32 bytes hex; min 16 chars required by `isAuthorizedCronRequest`) |

**Key rotation.** `WEBHOOK_ENCRYPTION_KEY` is single-version in v1 — rotating it means re-encrypting every channel under the new key (no automated path). For portfolio scale (~10 channels per tenant) one-shot manual rotation is acceptable; larger deployments would want a versioned KMS scheme.

### Configure the cron schedule

`vercel.json` ships with two cron entries — one for each cadence:

```json
{
  "crons": [
    {
      "path": "/api/cron/close-alerts-dispatch",
      "schedule": "*/15 9-18 * * 1-5"
    },
    {
      "path": "/api/cron/close-alerts-digest",
      "schedule": "0 9 * * *"
    }
  ]
}
```

Vercel cron times are **UTC**. Adjust the hours window if your team isn't on EU/UK time. The dedupe table (`notification_dispatch` with `@@unique([channelId, alertFingerprint])`) makes any cadence safe — every (channel, alert) tuple pings at most once regardless of how often the cron fires. Aggressive cadences waste compute but never double-page.

**Two cadences, one channel chooses one.** A channel is either `IMMEDIATE` (per-alert ping, every 15m business hours) or `DIGEST_DAILY` (one batched message at 09:00 UTC summarizing every fresh alert since the last successful digest). Pick the mode when you create the channel; flip it later from the channel's edit panel. Same dedupe table backs both modes — flipping a channel mid-day moves it to the new cadence on the next cron tick.

### Wire a Slack channel

1. Sign into Vercel + redeploy (env vars require a new deploy to take effect).
2. Open the app. Sign in as a **tenant admin**.
3. Sidebar → **Admin** → **Slack channels · alerts** (visible to admins only).
4. **Add a Slack channel** form:
   - **Channel name** — operator-facing label, e.g. `#finance close alerts`
   - **Slack webhook URL** — create at https://api.slack.com/messaging/webhooks; copy the full URL (starts with `https://hooks.slack.com/services/T.../B.../...`). The form masks the value as you type.
   - **Severity filter** — pick `high` only, or leave blank for all severities.
   - **Cadence** — `Immediate` (pings every 15m business hours, one Slack message per alert) or `Daily digest` (one batched message at 09:00 UTC summarizing all fresh alerts). Defaults to Immediate.
5. Click **Add channel**. The URL is encrypted under `WEBHOOK_ENCRYPTION_KEY` before the row lands in the DB.
6. Click **Test** on the new row. A diagnostic message lands in the Slack channel ("Test message from ledger-core notification channel ..."). If you see `SLACK_REJECTED` or `DECRYPT_FAILED`, the audit log under **Admin → Audit log** carries the diagnostic — filter by `resource=NotificationChannel`.

### Audit trail

Every dispatch — successful or failed — writes a row to `notification_dispatch` with status code + error. Every admin action on a channel (create / update / delete / test / setEnabled) writes a `PRIVILEGED_ACTION` row to `audit_log` with the masked URL only — the plaintext webhook URL never appears in any audit-visible payload. The cron tick itself writes one aggregate `PRIVILEGED_ACTION` row per invocation summarizing tenants scanned + alerts dispatched + errors.

### Rotating WEBHOOK_ENCRYPTION_KEY

The encryption key should rotate periodically (SOC 2 CC6.7 — annual minimum; sooner if a deploy team-member leaves with prior access to the secret). The repo ships a one-shot rotation script:

1. Generate a new key:
   ```bash
   NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
   ```

2. Set the OLD + NEW keys as separate env vars locally (do NOT touch the live `WEBHOOK_ENCRYPTION_KEY` yet — it must stay set to OLD until the script finishes):
   ```bash
   export WEBHOOK_ENCRYPTION_KEY_OLD=<the current Vercel value>
   export WEBHOOK_ENCRYPTION_KEY_NEW="$NEW_KEY"
   export DATABASE_URL=<your production connection string>
   ```

3. Run the rotation:
   ```bash
   npx tsx scripts/rotate-webhook-encryption-key.ts
   ```

   Output is JSON with `{ok, total, rotated, alreadyOnNew, errors, durationMs}`. The script is idempotent — re-runs after a partial failure re-do only what's still on the OLD key.

4. **Confirm `ok: true` and `errors: []` before proceeding.** Investigate any errors first (the channel's webhook URL was encrypted under neither OLD nor NEW; likely the row predates this key OR a previous rotation left it in a different state).

5. In Vercel → Settings → Env Vars, update `WEBHOOK_ENCRYPTION_KEY` to the NEW value. Redeploy.

6. Smoke-test: open the admin UI, click **Test** on every channel; each should still deliver. If any fail with `DECRYPT_FAILED`, restore the OLD env value, investigate, retry.

7. Once production is verified, wipe the OLD key from your secret store.

The rotation does NOT re-encrypt other column-level encrypted fields (those are managed by the PrismaExtension stack with its own key). For a portfolio-wide rotation, run the equivalent script in each repo.

### Disabling the notifier

To pause without removing config: in the admin UI, click **Disable** on every channel (or toggle individual ones). The cron continues to run but emits no dispatches. To remove entirely: delete `vercel.json`'s `crons` block and unset the env vars.

---

## Troubleshooting

**`Error: P1001: Can't reach database`**
The Neon free tier suspends inactive databases after ~5 minutes of idle. The first request after suspension takes ~3 seconds to wake up — subsequent requests are fast. For a demo this is fine; for production-style usage, upgrade to a paid Neon tier or use the autoscaling pooler.

**`PrismaClientInitializationError: gen_random_uuid() does not exist`**
Make sure your Postgres version is 13+ AND `pgcrypto` is available. Neon has it enabled by default. Self-hosted Postgres: run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` before `pnpm db:push`.

**Build fails with `Type error: Cannot find module 'next/headers'`**
The repo targets Next.js 14. Make sure `next` is installed via `pnpm install` before running `next build`.

---

## Loom walkthrough script

When you record the demo (the README links to it), hit these beats in order. v1.1 script — 8 beats, ~3 minutes total. Adjust to taste.

1. **Open the dashboard.** Point at the KPI grid; mention the BTD KPI is the result of three books posting in parallel.
2. **Switch book** to `US_TAX` in the top-right card. Show that Net Income changes (because Globex revenue recognizes immediately on cash basis).
3. **Trial balance** with the book switched; mention every TB balances per (entity, book).
4. **Balance sheet** in US_GAAP. Point at Lease Liability (account 2600) and ROU Asset (1600) — ASC 842 capitalization. Switch to US_TAX; both vanish (cash basis doesn't capitalize).
5. **Book-Tax Difference.** Total delta around −$41,600. Click into the depreciation row, mention it's classified TEMPORARY (timing difference, reverses).
6. **A journal entry detail.** Open one with `sourceSystem = QBO` or `NETSUITE`. Scroll to the bottom to show the frozen `sourcePayload` — explain Layer 6 lineage and the roundtrip guarantee.
7. **Consolidation.** Switch the entity to `ACME_GROUP` in the top-right (or open `/reports/consolidation` directly). Show the $3k IC sale: per-entity columns show Sub-A's IC AR ($3k Dr in 1300) and Sub-B's IC AP ($3k Cr in 2400). The **Consolidated** column shows both as zero — the elimination did its job. Group net income excludes the IC revenue ($3k) and IC expense ($3k), so the group never appears to have earned money from itself.
8. **M-3 detail.** Open `/reports/m3-detail`. Point out the "Depreciation and amortization" line — $1,600 TEMPORARY delta, the exact ASC 740 deferred-tax input. Mention each M-3 line is auto-classified by account subtype so a tax preparer doesn't have to re-bucket BTD rows by IRS form line.

That covers the headline differentiators (multi-book substrate, lineage roundtrip, multi-entity consolidation, ASC 740 tax provision input) in about 3 minutes.
