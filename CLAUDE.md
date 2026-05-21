# Claude Code Instructions for ledger-core

This file is auto-loaded by Claude Code on every session in this repo. It tells you what this project is, how to work in it, and what rules are non-negotiable.

If a user request conflicts with anything in this file, ask before proceeding.

---

## What this project is

`ledger-core` is the **universal accounting substrate** — Layers 1 and 2 (with seams for 3–6) of a multi-book general ledger that can absorb data from any major ERP. It is the foundation of the `ledger-nexus` portfolio (this repo + `recon` + `revenue-rec`).

The owner is a CPA shipping with AI. They wrote the universal schema spec (`docs/universal-schema.md`); you implement against it. The architecture decisions in that doc are LOCKED — do not re-litigate them in conversation, do not propose alternatives, do not soften them. Read the file. Ask if anything is unclear.

## The non-negotiables

1. **The universal schema is canon.** `docs/universal-schema.md` is the architectural contract. Multi-book is locked. Pattern 2 (full parallel posting) is locked. The anti-patterns list is a hard constraint.

2. **Every ledger write goes through `postJournalEntry`.** It enforces debits = credits, atomicity, account validity, book scope, and period close. If you find yourself bypassing it, stop.

3. **AI suggests; humans approve; the system posts.** AI is not trusted to post entries directly. Any AI-influenced entry flows through `postJournalEntry` with `source: "AI_APPROVED"` after human confirmation.

4. **The invariant tests are the contract.** If a change you make causes one to fail, the change is wrong — not the test.

## What's wired now (v0.3)

- ✅ Layer 1 — `Account`, `JournalEntry`, `JournalLine` with three currency amounts, lineage columns, multi-book scope, GIN-indexed extensions
- ✅ Layer 2 — `LegalEntity`, `Book`, `Currency`, `FxRate`, `FiscalCalendar`, `Period`, `PeriodClose`, `Party`, `PartyRole`, `Item`
- ✅ Layer 3 — Dimension engine tables (no values seeded yet)
- ✅ Layer 4 — `PostingRule` table (no rules registered yet; engine lands v0.4)
- ✅ Layer 5 — `extensions Json` + `CustomFieldDefinition` registry
- ✅ Layer 6 — Source-system / source-record-id lineage columns
- ✅ Native sub-ledgers: AR open items + applications, AP open items + applications, FixedAsset + book-aware attributes + `runDepreciation`, Lease + book-aware classification, RevenueContract + PerformanceObligation + book-aware recognition basis
- ✅ Book-Tax-Difference report (`src/lib/accounting/reports/book-tax-difference.ts`)
- ✅ Northwind Cloud seed posts to all three books in parallel (Pattern 2). Depreciation diverges per book (36-mo SL vs 60-mo SL). Globex prepay diverges (accrual defer vs cash-basis immediate recognition).
- ✅ Invariant tests: multi-book isolation, AR/AP lifecycle, fixed asset divergence, BTD classification.

## What lands next (v0.4)

- 🚧 Posting-rules engine implementation (replace explicit `postToBooks` fan-out with table-driven rules)
- 🚧 Full ASC 842 ROU asset + lease liability roll-forward (v0.3 is a SL stub)
- 🚧 Disposal flow for fixed assets
- 🚧 Property-based tests via `fast-check`
- 🚧 Document layer in consumer repos (`recon`, `revenue-rec`)
- 🚧 UI + Vercel + Neon live demo (v0.5)

## Stack

- Postgres + Prisma (`@@map` keeps SQL names aligned with universal-schema vocabulary)
- decimal.js for all money math
- Vitest for tests against a real Postgres
- pnpm as the package manager
- Next.js 14 (App Router) — UI deferred until sub-ledgers land

## Rules for working in this codebase

### Money math
- Always use `Decimal` from `decimal.js`. Never `Number`.
- Compare with `.equals()`, not `===`.
- When converting from Prisma's `Decimal` to `decimal.js`, use `new Decimal(value.toString())`.

### Database writes
- All ledger writes flow through `postJournalEntry`. No exceptions.
- Schema changes require a Prisma migration; never edit the DB directly.
- New columns on `Account`, `JournalEntry`, `JournalLine` must respect the anti-patterns list in `docs/universal-schema.md` (no fixed dimension columns, no source-system PKs, no widening megatables).

### Multi-book discipline
- Every `postJournalEntry` call targets ONE `(entity, book)`. To post to N books for a single source event, call N times. Until the posting-rules engine lands (v0.4), the seed's `postToBooks(books, base)` helper is the canonical pattern.
- Reports always scope to `(entity, book)`. There is no book-agnostic report; cross-book views are computed by diffing two scoped reports (see `getBookTaxDifference`).
- `bookId="PRIMARY"` is NOT a thing in this schema. Real book codes are `US_GAAP`, `US_TAX`, `IFRS`, etc.
- Sub-ledger records (AR/AP open items, FixedAssetBookAttributes, etc.) are per-book. One physical asset → one `FixedAsset` row + N `FixedAssetBookAttributes` rows. Same for leases and revenue contracts.

### Testing
- Any new accounting logic gets an invariant test in `tests/invariants.test.ts`.
- Tests run against a real Postgres (via `DATABASE_URL`). Don't mock the DB.
- Run `pnpm test` after any change that touches `src/lib/accounting/` or `prisma/`.

### Lineage
- Every ERP-import path must populate `sourceSystem`, `sourceRecordType`, `sourceRecordId`, `sourcePayload` (frozen raw JSON), and `mappingVersion`. Native seeds leave these null.
- Never reuse a source-system primary key as our schema PK. Source IDs live in the lineage columns only.

## How to start a session

1. Read this file
2. Read `docs/universal-schema.md` (the architecture canon)
3. Read `PROJECT_STATUS.md` for the latest "where we are / what's next" (note: status doc is being rewritten in the next batch)
4. Confirm understanding before suggesting work

## Style preferences

- Be direct. The user is a CPA — they understand precision.
- Comments explain *accounting* reasoning, not code mechanics. "This is the contra-account sign flip" is useful; "this loops through the array" is not.
- When you finish a unit of work, suggest updating `PROJECT_STATUS.md`.
