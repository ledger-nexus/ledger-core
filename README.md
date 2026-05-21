# mini-ledger

> A double-entry general ledger that enforces accounting invariants as unit tests.

A working implementation of the bookkeeping foundation that sits underneath every real accounting system. Models a chart of accounts, balanced journal entries, and generates a live Trial Balance, Income Statement, and Balance Sheet from the raw entries.

The headline feature: **130+ accounting invariant tests** that fail loudly if debits ever don't equal credits, if the balance sheet doesn't balance, or if retained earnings doesn't reconcile with cumulative net income. A correct ledger is the contract this project signs.

**[Live demo →](https://[demo-url])** · **[2-min walkthrough →](https://[loom-url])** · **[Org page →](https://github.com/[ORG])**

---

## The problem

Every accounting system — QuickBooks, NetSuite, Sage, the new wave (Rillet, Numeric, Puzzle) — is built on top of a double-entry ledger. The ledger is the boring, critical layer where bugs become misstatements and misstatements become restatements. Most "vibe-coded" finance projects skip it and put a UI on top of a flat transaction table, which works until you try to produce a balance sheet that balances.

This project does the unglamorous foundational work: a small, correct ledger that the rest of an accounting system can be built on. The bank-recon and rev-rec-606 projects in this portfolio sit on top of it.

## The accounting concept

Double-entry bookkeeping requires every transaction to be recorded as at least one debit and one credit, with debits equal to credits. Accounts fall into five types (Asset, Liability, Equity, Revenue, Expense), each with a "normal balance" side. The Income Statement summarizes Revenue and Expense activity over a period; the Balance Sheet snapshots Assets, Liabilities, and Equity at a point in time; the two are linked because net income flows into Retained Earnings.

If any of that was hand-wavy, [docs/accounting-notes.md](docs/accounting-notes.md) has a from-scratch explainer written for developers who can read code but haven't taken an accounting class.

## Features

- ✅ Chart of accounts with five account types and explicit contra-account support
- ✅ Journal entries enforce debits = credits at three layers: app code, transaction-wrapped DB writes, and CHECK constraints
- ✅ Trial Balance, Income Statement, and Balance Sheet generated from raw entries on every request (no caching, no rollups, no stale numbers)
- ✅ Seeded with 6 months of activity for "Northwind Cloud," a fake SaaS company
- ✅ 130+ unit tests covering every accounting invariant, including cross-statement reconciliation (retained earnings on BS = cumulative net income from IS)
- ✅ All monetary math uses `decimal.js` — no floating-point errors, ever
- ✅ Posted entries are immutable; corrections happen by posting a reversal
- 🚧 Multi-currency support
- 🚧 Period close ceremony with explicit close entries
- 🚧 Cash flow statement
- 🚧 User auth and roles

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 (App Router) | Standard at the target companies (Rillet, Numeric, Puzzle) |
| Database | Postgres | Constraints can enforce accounting rules at the schema level |
| ORM | Prisma | Type-safe, generates a clean TS client, great DX |
| Money math | decimal.js | JS `Number` can't represent money correctly. Don't try. |
| Tests | Vitest | Fast, ESM-native, good DX for TS projects |
| Hosting | Vercel + Neon (free tiers) | Zero-cost portfolio deploy |

## Quick start

```bash
git clone https://github.com/[ORG]/mini-ledger.git
cd mini-ledger
pnpm install
cp .env.example .env
# Edit .env: point DATABASE_URL at any Postgres (Neon free tier is easiest)

pnpm db:push      # create schema
pnpm db:seed      # load Northwind Cloud demo data
pnpm dev          # http://localhost:3000
```

Should take under two minutes from clone to running app. If it doesn't, please open an issue.

## Running the tests

```bash
pnpm test                  # all tests
pnpm test:invariants       # core invariants (no seed required)
pnpm test:seeded           # tests against the Northwind Cloud seed
```

The invariant suite is the one to look at. See `tests/invariants.test.ts`.

## How AI is (and isn't) used

This project deliberately uses **no AI at runtime**. The ledger is deterministic. Decisions about what to debit and credit are made by the human entering the transaction (or, in the higher-level projects, by code with explicit logic).

AI was used to *build* this project — Claude Code wrote most of the React UI, scaffolded the test cases I specified, and produced the boilerplate Prisma migrations. The accounting logic, schema decisions, seed scenarios, and invariant definitions are mine. See [`AI_COLLABORATION.md`](AI_COLLABORATION.md) for the honest record.

The companion projects (bank-recon, rev-rec-606) *do* use AI at runtime — but only for suggestion, ranking, and explanation. **AI never posts to the ledger directly.** Every AI-influenced entry flows through `postJournalEntry` with `source: "AI_APPROVED"`, after explicit human review. That distinction is the security model.

## Project structure

```
mini-ledger/
├── prisma/
│   ├── schema.prisma            # data model
│   ├── migrations/              # includes raw SQL CHECK constraints
│   └── seed.ts                  # Northwind Cloud — 6 months of activity
├── src/
│   ├── app/                     # Next.js App Router pages
│   └── lib/
│       ├── accounting/
│       │   ├── post-journal.ts  # THE function. Read this first.
│       │   ├── reports.ts       # TB, IS, BS generators
│       │   └── types.ts         # domain types + custom errors
│       └── db/
│           └── chart-of-accounts.ts
├── tests/
│   ├── invariants.test.ts       # the headline test suite
│   └── seeded-company.test.ts   # tests against the Northwind seed
└── docs/
    ├── accounting-notes.md      # plain-English accounting explainer
    └── DESIGN.md                # design doc: goals, decisions, trade-offs
```

If you only read three files, read these:
1. `docs/DESIGN.md` — the thinking
2. `src/lib/accounting/post-journal.ts` — the core
3. `tests/invariants.test.ts` — the proof

## What I'd build next

Honest list of what's missing:

- **Cash flow statement.** Genuinely hard. Worth a project of its own.
- **Period close.** Currently retained earnings is computed on the fly. A production system needs explicit close entries so comparative statements work correctly.
- **Multi-entity consolidation.** Intercompany eliminations, automatic.
- **Role-based access control.** Right now every user is admin.
- **Append-only audit log with hash chaining.** Posted-entries-are-immutable is enforced at the app level but a real audit log would persist a cryptographic trail.
- **Reports UI polish.** The functions are right; the UI on top is a basic table.

## About this project

Part of **[[ORG NAME]](https://github.com/[ORG])** — a portfolio of AI-native accounting tools built by an accountant learning to ship software. See the [org page](https://github.com/[ORG]) for the other projects and the broader thesis.

Built by [YOUR NAME] · [LinkedIn](https://linkedin.com/in/[YOU]) · [Email](mailto:[YOUR_EMAIL])

MIT licensed.
