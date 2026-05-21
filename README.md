# ledger-core

> The universal accounting substrate. Layers 1 & 2 of a multi-book general ledger, exercised on QBO-grade SaaS data, schema-compatible with NetSuite/Intacct.

The boring, critical foundation that every accounting system sits on top of. A correct double-entry general ledger with multi-entity, multi-book, three-currency, dimension-engine, and ERP-lineage support — exercised on a single-entity SaaS company today, designed to absorb a tier-1 ERP tomorrow.

The headline feature: **accounting invariants enforced as unit tests** that fail loudly if debits ever don't equal credits, if a balance sheet doesn't balance, if retained earnings doesn't reconcile with cumulative net income, or if a transaction posted to US_GAAP leaks into US_TAX.

**Architecture reference: [docs/universal-schema.md](docs/universal-schema.md)** — the design decisions, in full.

---

## Why this exists

Every accounting system — QuickBooks, NetSuite, Sage, the new wave (Rillet, Numeric, Puzzle, Digits, Campfire) — is built on top of a double-entry ledger. The ledger is where bugs become misstatements and misstatements become restatements. Most "vibe-coded" finance projects skip it and stack a UI on top of a flat transaction table, which works until you try to produce a balance sheet that balances.

`ledger-core` does the unglamorous foundational work and does it against the universal schema, not a QBO-grade subset. The posting substrate, master data, dimension engine, and lineage layer are all present from commit 1. Sub-ledgers (AR/AP open items, fixed assets, leases, revenue contracts) and the posting-rules engine land next. Document tables (invoice, bill, PO) live in the consumer repos (`recon`, `revenue-rec`).

## What's wired now (v0.2)

- ✅ Layer 1 — Posting substrate (`Account`, `JournalEntry`, `JournalLine`) with debits=credits, three-currency amounts, XOR debit/credit, atomic writes, all enforced at app + DB layers
- ✅ Layer 2 — Master data: `LegalEntity`, `Book`, `Currency`, `FxRate`, `FiscalCalendar`, `Period`, `PeriodClose`, `Party`, `PartyRole`, `Item`
- ✅ Layer 3 — Dimension engine tables (`Dimension`, `DimensionValue`, `DimensionSet`, `DimensionSetValue`) — defined, no values yet
- ✅ Layer 4 — `PostingRule` table — defined, no rules yet
- ✅ Layer 5 — `extensions Json` on every entity + `CustomFieldDefinition` registry + GIN indexes
- ✅ Layer 6 — Source-system / source-record-id / source-payload / mapping-version on every entity; wired from day one
- ✅ Multi-book scoped reports (Trial Balance, Income Statement, Balance Sheet) per `(entity, book)`
- ✅ Invariant tests including multi-book isolation
- ✅ Northwind Cloud seed (6 months, single book today)

## What lands next

- 🚧 Sub-ledgers: `ArOpenItem`, `ApOpenItem` lifecycle, `FixedAsset` + `FixedAssetBookAttributes`, `Lease` + `LeaseBookAttributes`, `RevenueContract` + `RevenueContractBookAttributes`
- 🚧 Posting rules engine — multi-book parallel posting from one source event
- 🚧 Book-tax difference report (ASC 740 / M-1 / M-3 inputs)
- 🚧 The Next.js UI on top of the substrate
- 🚧 ERP mapping examples (QBO floor, NetSuite ceiling)
- 🚧 Vercel + Neon live demo

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Database | Postgres | CHECK constraints + GIN indexes enforce accounting rules at the schema |
| ORM | Prisma | Type-safe, generates a clean TS client, `@@map` keeps SQL names spec-aligned |
| Money math | decimal.js | JS `Number` can't represent money correctly. Don't try. |
| Tests | Vitest | Fast, ESM-native, good DX |
| Frontend | Next.js 14 (App Router) | Standard at target companies (deferred until sub-ledgers land) |

## Quick start

```bash
git clone https://github.com/ledger-nexus/ledger-core.git
cd ledger-core
pnpm install
cp .env.example .env
# Edit .env: point DATABASE_URL at any Postgres (Neon free tier is easiest)

pnpm db:push      # create schema
pnpm db:seed      # load Northwind Cloud demo data
pnpm test         # run the invariant suite
```

## How AI is (and isn't) used

This project deliberately uses **no AI at runtime**. The ledger is deterministic. Decisions about what to debit and credit are made by the human entering the transaction (or, in the consumer projects, by code with explicit logic).

AI was used to *build* this project — Claude Code wrote most of the schema and tests. The accounting logic, schema decisions, the universal-schema spec, and invariant definitions are mine.

The companion projects (`recon`, `revenue-rec`) *do* use AI at runtime — but only for suggestion, ranking, and explanation. **AI never posts to the ledger directly.** Every AI-influenced entry flows through `postJournalEntry` with `source: "AI_APPROVED"`, after explicit human review. That distinction is the security model.

## Project structure

```
ledger-core/
├── prisma/
│   ├── schema.prisma            # Layers 1+2 + seams for 3-6
│   ├── migrations/              # SQL CHECK + GIN indexes
│   └── seed.ts                  # Northwind Cloud — 6 months of activity
├── src/lib/
│   ├── accounting/
│   │   ├── post-journal.ts      # THE function. Read this first.
│   │   ├── reports.ts           # TB, IS, BS — all per (entity, book)
│   │   └── types.ts             # domain types + custom errors
│   └── db/chart-of-accounts.ts  # shared chart of accounts
├── tests/
│   ├── invariants.test.ts       # the headline test suite
│   └── seeded-company.test.ts   # tests against the Northwind seed
└── docs/
    ├── universal-schema.md      # CANONICAL — the architecture reference
    ├── DESIGN.md                # design doc (being rewritten for v1)
    └── accounting-notes.md      # plain-English accounting explainer
```

If you only read three files:
1. `docs/universal-schema.md` — what's being built and why
2. `prisma/schema.prisma` — the data model
3. `src/lib/accounting/post-journal.ts` — the posting boundary

## About the project

Part of **[ledger-nexus](https://github.com/ledger-nexus)** — a portfolio of accounting tools built by an accountant learning to ship software with AI. See the org page for the consumer projects (`recon`, `revenue-rec`) and the broader thesis.

MIT licensed.
