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

## Reseting the live demo

If random visitors mess with the data (assuming you ever add a new-entry form):

```bash
# Locally with the production DATABASE_URL
pnpm db:reset
```

`db:reset` drops all data, re-runs migrations, and re-seeds. The reset is destructive — do not point it at a database you care about.

A scheduled reset (e.g. Vercel Cron → `/api/admin/reset` endpoint) is a v0.8 task once the demo has real visitors.

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

When you record the demo (the README links to it), hit these beats in order:

1. **Open the dashboard.** Point at the KPI grid, mention the BTD KPI is the result of three books posting in parallel.
2. **Switch book** to `US_TAX` in the top-right card. Show that Net Income changes (because Globex revenue recognizes immediately on cash basis).
3. **Trial balance** with the book switched, mention every TB balances per (entity, book).
4. **Balance sheet** in US_GAAP. Point at Lease Liability (account 2600) and ROU Asset (1600) — ASC 842 capitalization. Switch to US_TAX, both vanish (cash basis doesn't capitalize).
5. **Book-Tax Difference**. The total delta around −$41,600. Click into the depreciation row, mention it's classified TEMPORARY (timing difference, reverses).
6. **A journal entry detail.** Open one with `sourceSystem = QBO` or `NETSUITE`. Scroll to the bottom to show the frozen `sourcePayload` — explain Layer 6 lineage and roundtrip guarantee.

That covers the headline differentiators in about 2 minutes.
