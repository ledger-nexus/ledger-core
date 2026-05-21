# ledger-core

> The universal accounting substrate. A multi-book general ledger with native sub-ledgers, exercised on QBO-grade SaaS data, schema-compatible with NetSuite/Intacct.

The boring, critical foundation every accounting system sits on top of. Correct double-entry posting, multi-entity, multi-book (Pattern 2 — full parallel ledgers), three-currency, native sub-ledgers (AR / AP / fixed assets / leases / revenue contracts), dimension engine, ERP-lineage, and a book-tax-difference report that diffs two books' trial balances and surfaces ASC 740 timing differences.

Northwind Cloud (the seeded SaaS company) posts to **US_GAAP, US_TAX, and IFRS in parallel**. Depreciation diverges per book (36-month SL vs 60-month SL → $1,600 temporary difference). Globex's $60k prepay defers under GAAP / IFRS and recognizes immediately under cash-basis tax. The book-tax-difference report surfaces all of it.

**Architecture canon: [docs/universal-schema.md](docs/universal-schema.md)** · **Visual map: [docs/schema-erd.md](docs/schema-erd.md)**

---

## Why this exists

Every accounting system — QuickBooks, NetSuite, Sage, the new wave (Rillet, Numeric, Puzzle, Digits, Campfire) — is built on top of a double-entry ledger. The ledger is where bugs become misstatements and misstatements become restatements. Most "vibe-coded" finance projects skip it and stack a UI on top of a flat transaction table, which works until you try to produce a balance sheet that balances *across three books* with a real fixed-asset book-tax difference.

`ledger-core` does the unglamorous foundational work and does it against the universal schema, not a QBO-grade subset. Layers 1+2 of the universal schema, native sub-ledgers, and the book-tax-difference engine are all present today. Document tables (`invoice`, `bill`, `purchase_order`) live in the consumer repos (`recon`, `revenue-rec`) — they're consumers of the substrate, not part of it.

## What's wired (v0.4)

- ✅ **Layer 1 posting substrate** — `Account`, `JournalEntry`, `JournalLine` with debits=credits, three-currency amounts, XOR debit/credit, atomic writes, sub-ledger keys, lineage. Enforced at app + DB layers.
- ✅ **Layer 2 master data** — `LegalEntity`, `Book`, `Currency`, `FxRate`, `FiscalCalendar`, `Period`, `PeriodClose`, `Party`+`PartyRole`, `Item`.
- ✅ **Layer 3 dimension engine** — tables defined; values populated when needed.
- ✅ **Layer 4 posting-rules engine** — minimal `$.path` DSL; rules registered per `(sourceEventType, bookId)` drive multi-book divergence declaratively (v0.4).
- ✅ **Layer 5 custom fields** — `extensions Json` on every entity + `CustomFieldDefinition` + GIN indexes.
- ✅ **Layer 6 lineage** — source-system / record-id / payload on every importable entity.
- ✅ **Sub-ledgers** — AR / AP open-item lifecycle (with paired bad-debt write-off in v0.4); FixedAsset + book-aware depreciation + disposal flow (gain/loss recognized per book); Lease with full ASC 842 mechanics (commencement → amortization → cash payment) in v0.4; RevenueContract + PerformanceObligation + per-book recognition basis.
- ✅ **Reports** — Trial Balance, Income Statement, Balance Sheet, **Book-Tax Difference** — all scoped per `(entity, book)`.
- ✅ **Multi-book parallel posting** — Northwind seed exercises Pattern 2 end-to-end with divergent depreciation, cash-basis tax recognition, and ASC 842 leases (GAAP/IFRS capitalize; TAX cash-basis).
- ✅ **Invariant tests** — TB/BS balance per book, AR/AP open-item = control account, fixed asset NBV divergence, BTD classification, disposal gain/loss math, ASC 842 commencement + amortization, posting-rules engine end-to-end.
- ✅ **Property-based tests** via fast-check — balanced entries always accepted; unbalanced always rejected; arbitrary entry sequences leave BS balanced; AR open-item invariant survives arbitrary application sequences.

## What lands next (v0.5 → v1.0)

- 🚧 Next.js UI + Vercel + Neon live demo + Loom walkthrough
- 🚧 QBO and NetSuite end-to-end mapping examples (the "validate by mapping" step in `docs/universal-schema.md`)
- 🚧 Allowance method for bad debt (estimate + apply via Allowance for Doubtful Accounts)
- 🚧 M-1 / M-3 detail report (sub-classifying BTD by IRS form line)
- 🚧 Consolidation report across multiple legal entities

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Database | Postgres | CHECK constraints + GIN indexes enforce accounting rules at the schema |
| ORM | Prisma | Type-safe; `@@map` keeps SQL names aligned with universal-schema vocabulary |
| Money math | decimal.js | JS `Number` can't represent money correctly. Don't try. |
| Tests | Vitest | Fast, ESM-native, good DX; runs against real Postgres (not mocks) |
| Frontend | Next.js 14 (App Router) | Deferred until v0.5 — sub-ledgers and BTD report need data plumbing first |

## Quick start

```bash
git clone https://github.com/ledger-nexus/ledger-core.git
cd ledger-core
pnpm install
cp .env.example .env
# Edit .env: point DATABASE_URL at any Postgres (Neon free tier is easiest)

pnpm db:push      # create schema
pnpm db:seed      # load Northwind Cloud — 6 months across 3 books
pnpm test         # run the invariant suite
```

Once seeded, you can poke at the book-tax-difference report directly:

```ts
import { PrismaClient } from "@prisma/client";
import { getBookTaxDifference } from "./src/lib/accounting/reports/book-tax-difference";

const btd = await getBookTaxDifference(new PrismaClient(), {
  entityCode: "NORTHWIND",
  fromBookCode: "US_GAAP",
  toBookCode: "US_TAX",
  periodStart: new Date("2026-01-01"),
  periodEnd: new Date("2026-06-30"),
});
// btd.totalDelta ≈ -$41,600 (tax net income > book net income)
// btd.pnlRows[…depreciation expense…].classification === "TEMPORARY"
```

## How AI is (and isn't) used

This project deliberately uses **no AI at runtime**. The ledger is deterministic. Decisions about what to debit and credit are made by the human entering the transaction (or, in the consumer projects, by explicit logic).

AI was used to *build* this project — Claude Code wrote most of the schema, sub-ledger implementations, and tests. The accounting logic, the universal-schema spec, and the invariant definitions are mine. See [`AI_COLLABORATION.md`](AI_COLLABORATION.md) for the honest record.

The companion projects (`recon`, `revenue-rec`) *do* use AI at runtime — but only for suggestion, ranking, and explanation. **AI never posts to the ledger directly.** Every AI-influenced entry flows through `postJournalEntry` with `source: "AI_APPROVED"` after explicit human review. That distinction is the security model.

## Project structure

```
ledger-core/
├── prisma/
│   ├── schema.prisma                          # Layers 1+2+3 + sub-ledgers + posting rules
│   ├── migrations/                            # SQL CHECK + GIN indexes
│   └── seed.ts                                # Northwind — Pattern 2 across 3 books
├── src/lib/
│   ├── accounting/
│   │   ├── post-journal.ts                    # THE function. Read this first.
│   │   ├── reports.ts                         # TB, IS, BS per (entity, book)
│   │   ├── reports/book-tax-difference.ts     # GAAP vs TAX diff with classification
│   │   ├── posting-rules.ts                   # rules engine + minimal $.path DSL (v0.4)
│   │   ├── sub-ledgers/
│   │   │   ├── ar.ts                          # open/apply/write-off + aging + bad-debt JE
│   │   │   ├── ap.ts                          # mirror of AR
│   │   │   ├── fixed-assets.ts                # createFixedAsset + runDepreciation + disposeFixedAsset
│   │   │   ├── leases.ts                      # createLease + runLeaseAccounting (full ASC 842)
│   │   │   └── revenue-contracts.ts           # createRevenueContract + recognition runner
│   │   └── types.ts                           # domain types + custom errors
│   └── db/chart-of-accounts.ts                # shared chart
├── tests/
│   ├── invariants.test.ts                     # Layer 1 invariants
│   ├── sub-ledgers.test.ts                    # AR/AP lifecycle, FA depreciation, BTD
│   ├── v0-4-features.test.ts                  # disposal, bad debt, ASC 842, posting rules
│   ├── property-based.test.ts                 # fast-check property tests
│   └── seeded-company.test.ts                 # Northwind multi-book assertions
└── docs/
    ├── universal-schema.md                    # CANONICAL — architecture decisions
    ├── schema-erd.md                          # mermaid ERD (core + sub-ledger diagrams)
    ├── DESIGN.md                              # design doc
    └── accounting-notes.md                    # plain-English accounting explainer
```

If you only read four files:
1. `docs/universal-schema.md` — what's being built and why
2. `docs/schema-erd.md` — the visual map
3. `src/lib/accounting/post-journal.ts` — the posting boundary
4. `src/lib/accounting/reports/book-tax-difference.ts` — the v0.3 payoff

## About the project

Part of **[ledger-nexus](https://github.com/ledger-nexus)** — a portfolio of accounting tools built by an accountant learning to ship software with AI. See the org page for the consumer projects (`recon`, `revenue-rec`) and the broader thesis.

MIT licensed.
