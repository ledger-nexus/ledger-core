# Multi-repo deployment — the full ledger-nexus stack

This runbook takes you from five GitHub repos to five live Vercel URLs sharing one Neon Postgres, in roughly 30 minutes. The single-repo guide at `deployment.md` covers ledger-core in isolation — this one covers the full portfolio.

The architecture: five Next.js apps, each its own Vercel project, all connecting to one shared Neon database. They talk to each other over HTTP via the internal endpoints documented in each repo's `docs/`. Cross-repo URLs are env-injected so dev (`localhost:3001`) and prod (`recon.vercel.app`) are config differences, not code differences.

---

## TL;DR — one-command deploy

If you'd rather not click through Vercel's dashboard five times, the script `bin/deploy.sh` does the whole thing non-interactively. Total runtime: ~10–15 minutes (Vercel builds dominate).

### One-time signup (do this first)

Both services have generous free tiers and don't ask for a credit card.

1. **Vercel** — go to [vercel.com/signup](https://vercel.com/signup), sign in with GitHub. After signup you'll land on a dashboard.

2. **Vercel deploy token** — visit [vercel.com/account/tokens](https://vercel.com/account/tokens). Click **Create Token**. Name it `ledger-nexus-deploy`. Expiration: pick whatever — 1 year is reasonable. Scope: full account (default). Copy the token. **You won't see it again.**

3. **Neon** — go to [neon.tech](https://neon.tech), sign in with GitHub. After signup, click **New Project**. Name it `ledger-nexus`. Region: pick something close to you (default `aws-us-east-2` is fine; for Vercel deploys to `iad1` you'd ideally pick `aws-us-east-1`). Click **Create**.

4. **Neon connection string** — once the project is created, look for the **Connection Details** panel on the dashboard. **You want the POOLED connection string**, not the direct one. It ends in `-pooler` (e.g., `ep-misty-snow-12345-pooler.us-east-2.aws.neon.tech`). The pooled URL is required for Vercel's serverless cold-starts; the direct URL will run you out of Postgres connections under load. Copy it.

### Run the deploy

```bash
export VERCEL_TOKEN=<token from step 2>
export DATABASE_URL=<Neon pooled URL from step 4>

cd /path/to/ledger-core
./bin/deploy.sh
```

The script auto-discovers all 5 sibling repos (`ledger-core/`, `recon/`, `revenue-rec/`, `integrations/`, `fa-amort/` under one parent directory). It then:

- generates three random internal-auth tokens
- creates 5 Vercel projects under your account (named `ledger-nexus-*`)
- wires every Vercel project's env vars (cross-repo URLs propagate automatically)
- pushes the ledger-core schema to Neon
- runs the Northwind seed
- deploys all 5 repos in order

Output: five `https://*.vercel.app` URLs printed at the end. Tokens saved to `/tmp/ledger-nexus-tokens.txt` for redeploys.

### Troubleshooting

- **"Project name already exists"** — Vercel project names are unique per account. If you've deployed before, the script reuses the existing project. If you want a fresh project, delete it from the Vercel dashboard first.
- **"Schema push failed"** — Neon idle-suspends free-tier compute after 5 minutes. First connection wakes it up; the script retries. If it really fails, run `DATABASE_URL=<url> npx prisma db push` from `ledger-core/` manually.
- **"Permission denied on /tmp/ledger-nexus-tokens.txt"** — your `/tmp` is locked down. Edit the script's `cat > /tmp/...` line to write elsewhere.

Want to see every step manually? Skip this section and follow Steps 1-8 below.

---

## The big picture

```
                     ┌─────────────┐
                     │   Neon DB   │ ← all 5 repos share one Postgres
                     └──────┬──────┘
                            │
       ┌────────────────────┼────────────────────────┐
       │                    │                        │
  ┌────▼────┐         ┌─────▼─────┐         ┌────────▼────────┐
  │ ledger- │ ◄────── │   recon   │         │    fa-amort     │
  │  core   │ HTTP    │           │         │                 │
  │  (3000) │ ◄────── │ revenue-  │         └────────┬────────┘
  └────▲────┘ HTTP    │   rec     │                  │ HTTP
       │              └─────┬─────┘                  │
       │ HTTP               │ HTTP                   ▼
       │              ┌─────▼─────┐         ┌────────────────┐
       └──────────────┤integrations         │  ledger-core   │
                      └───────────┘         │   /api/...     │
                                            └────────────────┘
```

Cross-repo HTTP boundaries:
- **ledger-core** exposes `POST /api/internal/{journal-entries, bank-lines (recon's), fixed-asset, fixed-asset/record-depreciation}`
- **recon** exposes `POST /api/internal/bank-lines`
- **revenue-rec** calls ledger-core's journal-entries endpoint
- **fa-amort** calls ledger-core's journal-entries, fixed-asset, and record-depreciation endpoints
- **integrations** calls recon's bank-lines endpoint

Every cross-repo call is token-gated. One token (`INTERNAL_API_TOKEN`) gates the ledger-core endpoints; a separate one (`RECON_INTERNAL_API_TOKEN`) gates recon's. The tokens are the only thing standing between a typo and a free arbitrary-write API, so set them and don't commit them.

---

## Prerequisites

- GitHub: all five repos forked or cloned to your account (or use [github.com/ledger-nexus](https://github.com/ledger-nexus) directly).
- Vercel account (free).
- Neon account. Free tier works for proof-of-concept; you'll want the Launch plan ($19/mo) for any real use — the free tier idle-suspends after 5 minutes, which makes first-page loads slow and breaks cross-repo HTTP boundaries.
- Anthropic API key (optional, for the AI surfaces in recon, revenue-rec, fa-amort).
- Plaid sandbox keys (optional, for integrations).

Total time: 30 minutes if you're focused, 45 if you're new to Vercel.

---

## Step 1 — Provision Neon (5 min)

1. Sign in at [neon.tech](https://neon.tech), click **New Project**.
2. Name it `ledger-nexus`. Pick a region close to where you'll be running Vercel (default `iad1` = US East = match Neon's US East).
3. Open **Connection Details** → copy the **Pooled connection string** (the `-pooler` one — required for Vercel serverless to avoid running out of Postgres connections under cold-start spikes).

That URL is your `DATABASE_URL` everywhere.

**Schema push from your laptop, once:**

```bash
cd ledger-core
echo 'DATABASE_URL="<paste-Neon-pooled-URL>"' > .env
npm install
npm run db:push       # creates all substrate tables
npm run db:seed       # loads Northwind + consolidation demo
```

The other four repos' schemas are MIRRORS — they read the same tables ledger-core creates. **Do NOT run `prisma db push` from recon/revenue-rec/integrations/fa-amort against prod** — they'd want to drop tables they don't model.

---

## Step 2 — Generate one set of tokens (1 min)

These tokens gate the internal HTTP boundaries. Each must be ≥32 random chars; if you skip them, the endpoints return 503 (fail-closed).

```bash
# Run this once, save the output somewhere safe
echo "INTERNAL_API_TOKEN=$(openssl rand -hex 32)"
echo "RECON_INTERNAL_API_TOKEN=$(openssl rand -hex 32)"
echo "AUTH_STUB_SECRET=$(openssl rand -hex 32)"
```

Three tokens. You'll paste each into multiple Vercel projects in the next step.

---

## Step 3 — Deploy ledger-core first (5 min)

Order matters: ledger-core is the substrate, every other repo's `LEDGER_CORE_URL` env points at it.

1. Vercel dashboard → **Add New → Project** → pick your `ledger-core` fork.
2. Framework: **Next.js** (auto-detected from `vercel.json`).
3. Environment variables — paste these:
   ```
   DATABASE_URL              = <Neon pooled URL>
   INTERNAL_API_TOKEN        = <generated in Step 2>
   AUTH_STUB_SECRET          = <generated in Step 2>
   ADMIN_TOKEN               = <random hex; gates /api/admin/reset>
   ```
4. Click **Deploy**.
5. Once green, note the production URL (e.g., `https://ledger-core-abc123.vercel.app`). Add a custom domain or shorter alias if you have one — that's the URL the other repos will hit.

Hit the deployed URL in a browser. The dashboard should render against your seeded Northwind data. If `/admin/users` or `/admin/orphans` show empty, the seed didn't run — verify `DATABASE_URL` and re-run `npm run db:seed` from your laptop.

---

## Step 4 — Deploy recon (5 min)

1. Vercel → **Add New → Project** → your `recon` fork.
2. Env vars:
   ```
   DATABASE_URL                  = <Neon pooled URL — same as ledger-core>
   LEDGER_CORE_URL               = <ledger-core's Vercel URL from Step 3>
   LEDGER_CORE_INTERNAL_TOKEN    = <INTERNAL_API_TOKEN from Step 2>
   RECON_INTERNAL_API_TOKEN      = <RECON_INTERNAL_API_TOKEN from Step 2>
   AUTH_STUB_SECRET              = <same as ledger-core>
   ANTHROPIC_API_KEY             = <optional; AI matcher needs it>
   ```
3. Deploy. Once green, note recon's URL.

Smoke test: open `<recon-url>/statements`. The Acme March 2026 fixture should render. Open one and try "Suggest matches" on a line — if you set `ANTHROPIC_API_KEY`, the AI matcher fires; if not, only the deterministic scorer runs (still functional).

---

## Step 5 — Deploy revenue-rec (3 min)

1. Vercel → **Add New → Project** → your `revenue-rec` fork.
2. Env vars:
   ```
   DATABASE_URL                  = <Neon pooled URL>
   LEDGER_CORE_URL               = <ledger-core's Vercel URL>
   LEDGER_CORE_INTERNAL_TOKEN    = <INTERNAL_API_TOKEN>
   AUTH_STUB_SECRET              = <same shared value>
   ANTHROPIC_API_KEY             = <optional; AI contract extractor needs it>
   ```
3. Deploy.

Smoke test: open `<revenue-rec-url>/contracts`. The Globex contract should render with its existing AI extraction + recognition schedule.

---

## Step 6 — Deploy integrations (3 min)

1. Vercel → **Add New → Project** → your `integrations` fork.
2. Env vars:
   ```
   DATABASE_URL                  = <Neon pooled URL>
   RECON_URL                     = <recon's Vercel URL from Step 4>
   RECON_INTERNAL_API_TOKEN      = <RECON_INTERNAL_API_TOKEN>
   AUTH_STUB_SECRET              = <same shared value>
   PLAID_CLIENT_ID               = <optional; from dashboard.plaid.com>
   PLAID_SECRET                  = <optional>
   PLAID_ENV                     = sandbox
   PLAID_PRODUCTS                = transactions
   PLAID_COUNTRY_CODES           = US
   ```
3. Deploy.

Smoke test: open `<integrations-url>/connections`. The list is empty until you wire a Plaid connection — that's expected on first deploy.

---

## Step 7 — Deploy fa-amort (3 min)

1. Vercel → **Add New → Project** → your `fa-amort` fork.
2. Env vars:
   ```
   DATABASE_URL                  = <Neon pooled URL>
   LEDGER_CORE_URL               = <ledger-core's Vercel URL>
   LEDGER_CORE_INTERNAL_TOKEN    = <INTERNAL_API_TOKEN>
   AUTH_STUB_SECRET              = <same shared value>
   ANTHROPIC_API_KEY             = <optional; AI capex classifier needs it>
   ```
3. Deploy.

Smoke test: open `<fa-amort-url>/`. The dashboard should show the seeded fixed asset and the "behind on depreciation" widget. Visit `/ai-capex` and try a sample classification (requires `ANTHROPIC_API_KEY`).

---

## Step 8 — Run the demo against production (2 min)

```bash
cd ledger-core
# Make sure your local .env points at the same Neon DB
npm run demo
```

Wait ~30s. The output prints a localhost URL — **swap localhost:3000 for your ledger-core Vercel URL** and open it:

```
https://ledger-core-abc123.vercel.app/reports/month-end?entity=DEMO_CO&book=US_GAAP&period=2026-05
```

The packet renders against your prod Neon DB. CSV + PDF downloads work too. That's your sharable demo URL.

---

## What you've shipped

After Steps 1–8 you have:
- One Neon DB (pooled, prod-suitable)
- Five Vercel deployments on `*.vercel.app` (or your custom domain if you wired one up)
- Cross-repo HTTP boundaries authenticated by shared tokens
- A working `/demo` URL that produces a real tied-out month-end packet
- GitHub Actions CI running tsc + tests on every PR

Cost: $0 (Neon free) to $19/mo (Neon Launch) plus Vercel's hobby tier (free for non-commercial). Anthropic + Plaid only charge per use.

---

## Custom domains (optional, 5 min per repo)

Default Vercel URLs work fine, but custom domains are how this turns into a product. In Vercel project settings → **Domains**:

```
ledger-core    →  app.ledger-nexus.com
recon          →  recon.ledger-nexus.com
revenue-rec    →  rev.ledger-nexus.com
integrations   →  integ.ledger-nexus.com
fa-amort       →  fa.ledger-nexus.com
```

After adding each domain, update the relevant `LEDGER_CORE_URL` / `RECON_URL` env vars in each Vercel project to use the custom URL, then redeploy.

---

## Deferred follow-ups

These are real deficiencies of the current deploy that you'll want to address before this hosts real client data:

### Real auth (replace the HMAC stub)

`src/lib/auth/current-user.ts` in ledger-core is a dev-only HMAC-signed cookie stub. It's safe enough for a demo (the secret is salted, the cookie is HTTP-only) but it's not real auth. Two natural swap paths:

- **[Clerk](https://clerk.com)** — easiest, ~30 min. Sign in with email/Google/etc., real session management, role gates ready-made. Add `<ClerkProvider>` to the root layout, replace `getCurrentUser()` with `auth()` from Clerk, drop the cookie + HMAC logic. Free tier is generous.
- **[NextAuth](https://authjs.dev)** — more configuration but no per-user pricing. Use Postgres adapter against the same Neon DB.

The `getCurrentUser` / `requireAdmin` exports stay the same — only the body changes. Server Actions that call them keep working.

### Sentry / monitoring

Set `NEXT_PUBLIC_SENTRY_DSN` in each Vercel project after creating a free Sentry account. The Next.js integration is `npx @sentry/wizard@latest -i nextjs` per repo.

### Backups

Neon has point-in-time recovery on paid plans; the free tier doesn't. Either upgrade or set up a daily `pg_dump` cron via GitHub Actions.

### Production observability

- Cost telemetry: surface the `/ai-audit` token-spend numbers via metrics so AI usage doesn't drift into a surprise bill.
- Period-close enforcement: today the audit log proves period closes happened; production should also alert when a closed period gets a posted JE rejection (that's typically a signal someone's misusing the system).
- Cross-repo health checks: an `/api/health` endpoint per repo that pings ledger-core (or recon for integrations) so Vercel + a status page can flag a broken cross-repo link.

---

## Troubleshooting

**`PERIOD_CLOSED` errors on prod** — the demo seed closes May 2026 on US_GAAP. That's intentional; the friendly error message in fa-amort + recon explains how to reopen. If you want production to start with all periods open, edit `prisma/demo.ts` to skip the `closeMayPeriod` call.

**Tests pass locally but Vercel build fails** — almost always a missing env var. Check the Vercel build logs for `Error: Environment variable not found: X`. Add it in Project Settings → Environment Variables and redeploy.

**`LEDGER_CORE_URL` is set but cross-repo calls timeout** — Neon free-tier idle-suspend. The first cross-repo call after 5 min of idle wakes the compute (5-15s); subsequent calls are normal. Either upgrade Neon to Launch plan (eliminates the suspend), or add a warm-up cron.

**Vercel deploy succeeds but `/ai-capex` returns "ANTHROPIC_API_KEY is not set"** — you didn't set the env var on that specific Vercel project. Each project has its own env. (Or you set it but didn't redeploy after.)

**`P2002: gl_entry_header_lineage_uniq`** — you tried to re-post a JE with the same `(sourceSystem, sourceRecordType, sourceRecordId)` triple. This is by design — the lineage triple is the idempotency key. The endpoint will return `wasDuplicate: true` if you hit the right code path; check that your bridge code uses `postEntryViaLedgerCore` (which routes through the endpoint) rather than direct Prisma writes.
