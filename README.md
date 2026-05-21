# ledger-core

> The universal accounting substrate. A multi-book general ledger with native sub-ledgers, exercised on QBO-grade SaaS data, schema-compatible with NetSuite/Intacct.

The boring, critical foundation every accounting system sits on top of. Correct double-entry posting, multi-entity, multi-book (Pattern 2 — full parallel ledgers), three-currency, native sub-ledgers (AR / AP / fixed assets / leases / revenue contracts), dimension engine, ERP-lineage, and a book-tax-difference report that diffs two books' trial balances and surfaces ASC 740 timing differences.

Northwind Cloud (the seeded SaaS company) posts to **US_GAAP, US_TAX, and IFRS in parallel**. Depreciation diverges per book (36-month SL vs 60-month SL → $1,600 temporary difference). Globex's $60k prepay defers under GAAP / IFRS and recognizes immediately under cash-basis tax. The book-tax-difference report surfaces all of it.

**Architecture canon: [docs/universal-schema.md](docs/universal-schema.md)** · **Visual map: [docs/schema-erd.md](docs/schema-erd.md)**

---

## Why this exists

Every accounting system — QuickBooks, NetSuite, Sage, the new wave (Rillet, Numeric, Puzzle, Digits, Campfire) — is built on top of a double-entry ledger. The ledger is where bugs become misstatements and misstatements become restatements. Most "vibe-coded" finance projects skip it and stack a UI on top of a flat transaction table, which works until you try to produce a balance sheet that balances *across three books* with a real fixed-asset book-tax difference.

`ledger-core` does the unglamorous foundational work and does it against the universal schema, not a QBO-grade subset. Layers 1+2 of the universal schema, native sub-ledgers, and the book-tax-difference engine are all present today. Document tables (`invoice`, `bill`, `purchase_order`) live in the consumer repos (`recon`, `revenue-rec`) — they're consumers of the substrate, not part of it.

## What's wired (v0.7)

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
- ✅ **QuickBooks Online mapper (v0.5)** — end-to-end import of QBO exports (Accounts, Customers, Vendors, Invoices, Bills, Payments, BillPayments, JournalEntries) with full Layer 6 lineage, idempotent re-runs, AR/AP sub-ledger lifecycle wired, AND a reverse exporter that proves the roundtrip is lossless. See [docs/qbo-mapping.md](docs/qbo-mapping.md).
- ✅ **Allowance-method bad debt (v0.5)** — `estimateBadDebtAllowance` builds the allowance via Dr Bad Debt / Cr Allowance; `writeOffArItem({ method: "ALLOWANCE" })` applies it via Dr Allowance / Cr AR. No double-counted expense.
- ✅ **NetSuite mapper + dimension engine exercise (v0.6)** — the "expressive ceiling" stress test. Imports the full NS object graph (Subsidiary, Account, Class, Department, Location, CustomSegment, Customer, Vendor, Item, Invoice, VendorBill, CustomerPayment, VendorPayment, JournalEntry) with line-level dimension assignments deduplicated via `DimensionSet` stable hashes. Custom fields land in `extensions JSONB`. Lossless roundtrip same as QBO. See [docs/netsuite-mapping.md](docs/netsuite-mapping.md).
- ✅ **Next.js UI (v0.7)** — read-only surface on top of the substrate. Sidebar nav + multi-book switcher (cookie-backed via Server Action) + dashboard with KPIs + chart of accounts + journal entries list/detail (with frozen `sourcePayload` lineage on display) + all four reports (Trial Balance, Income Statement, Balance Sheet, Book-Tax Difference). Vercel + Neon deployment guide in [docs/deployment.md](docs/deployment.md).

## What lands next (v0.8 → v1.0)

- 🚧 Manual journal entry form with real-time balance indicator (the one read-write piece)
- 🚧 Multi-entity consolidation report with intercompany eliminations
- 🚧 NS Accounting Books (multi-book parallel posting from one NS transaction)
- 🚧 M-1 / M-3 detail report (sub-classifying BTD by IRS form line)
- 🚧 Cash flow statement

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
pnpm dev          # http://localhost:3000 — the v0.7 UI
```

For deploying the public live demo (Vercel + Neon, ~10 minutes end-to-end) see [`docs/deployment.md`](docs/deployment.md).

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
│   │   │   ├── ar.ts                          # open/apply/write-off + aging + allowance method (v0.5)
│   │   │   ├── ap.ts                          # mirror of AR
│   │   │   ├── fixed-assets.ts                # createFixedAsset + runDepreciation + disposeFixedAsset
│   │   │   ├── leases.ts                      # createLease + runLeaseAccounting (full ASC 842)
│   │   │   └── revenue-contracts.ts           # createRevenueContract + recognition runner
│   │   └── types.ts                           # domain types + custom errors
│   ├── mappers/
│   │   ├── qbo/                               # v0.5 — QuickBooks Online import/export
│   │   │   ├── types.ts                       # QBO API shape types
│   │   │   ├── mappers.ts                     # pure mapping functions
│   │   │   ├── import.ts                      # idempotent orchestrator
│   │   │   └── export.ts                      # reverse exporter (roundtrip proof)
│   │   └── netsuite/                          # v0.6 — NetSuite import/export
│   │       ├── types.ts                       # NS record + transaction shapes
│   │       ├── dimensions.ts                  # Layer 3 dimension engine helpers
│   │       ├── mappers.ts                     # pure mapping functions (including dim extraction)
│   │       ├── import.ts                      # orchestrator with dim engine population
│   │       └── export.ts                      # reverse exporter (roundtrip proof)
│   ├── db.ts                                  # singleton PrismaClient (HMR-safe)
│   ├── scope.ts                               # cookie-backed (entity, book) scope reader
│   └── utils/                                 # cn(), formatMoney(), formatDate()
├── app/                                       # v0.7 Next.js App Router UI
│   ├── layout.tsx                             # sidebar + book switcher header
│   ├── page.tsx                               # dashboard
│   ├── accounts/                              # chart of accounts
│   ├── journal-entries/                       # list + detail (with lineage payload)
│   ├── reports/                               # trial-balance, income-statement, balance-sheet, book-tax-difference
│   └── actions/                               # Server Actions (setScopeAction)
└── components/                                # UI primitives + nav (sidebar, book-switcher)
│   └── db/chart-of-accounts.ts                # shared chart
├── tests/
│   ├── invariants.test.ts                     # Layer 1 invariants
│   ├── sub-ledgers.test.ts                    # AR/AP lifecycle, FA depreciation, BTD
│   ├── v0-4-features.test.ts                  # disposal, bad debt (DIRECT + ALLOWANCE), ASC 842, posting rules
│   ├── qbo-mapping.test.ts                    # QBO import/export + roundtrip (v0.5)
│   ├── netsuite-mapping.test.ts               # NS import + dim engine + roundtrip (v0.6)
│   ├── property-based.test.ts                 # fast-check property tests
│   └── seeded-company.test.ts                 # Northwind multi-book assertions
└── docs/
    ├── universal-schema.md                    # CANONICAL — architecture decisions
    ├── schema-erd.md                          # mermaid ERD (core + sub-ledger diagrams)
    ├── qbo-mapping.md                         # QBO import/export + roundtrip guide (v0.5)
    ├── netsuite-mapping.md                    # NS import + dimension engine guide (v0.6)
    ├── deployment.md                          # Vercel + Neon live-demo guide (v0.7)
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
