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

## What's wired now (v0.6)

- ✅ Layer 1 — `Account`, `JournalEntry`, `JournalLine` with three currency amounts, lineage columns, multi-book scope, GIN-indexed extensions
- ✅ Layer 2 — `LegalEntity`, `Book`, `Currency`, `FxRate`, `FiscalCalendar`, `Period`, `PeriodClose`, `Party`, `PartyRole`, `Item`
- ✅ Layer 3 — Dimension engine tables (no values seeded yet)
- ✅ Layer 4 — `PostingRule` table + posting-rules engine (`src/lib/accounting/posting-rules.ts`) with minimal `$.path` DSL and `${$.path}` interpolation. `registerUniformRule` is the helper for the common multi-book case.
- ✅ Layer 5 — `extensions Json` + `CustomFieldDefinition` registry
- ✅ Layer 6 — Source-system / source-record-id lineage columns
- ✅ Native sub-ledgers (v0.3 base + v0.4 additions):
  - AR open items + applications + bad-debt write-off (posts paired Dr Bad Debt / Cr AR)
  - AP open items + applications
  - FixedAsset + book-aware attributes + `runDepreciation` + `disposeFixedAsset` (catches up dep, posts paired JE, marks DISPOSED)
  - Lease + book-aware classification + `runLeaseAccounting` (full ASC 842 mechanics: commencement → amortization → cash payment for OPERATING; cash-basis for TAX_CASH_BASIS)
  - RevenueContract + PerformanceObligation + book-aware recognition basis
- ✅ Book-Tax-Difference report (`src/lib/accounting/reports/book-tax-difference.ts`)
- ✅ Northwind seed: Pattern 2 multi-book + ASC 842 lease (GAAP/IFRS show ROU + liability on BS; TAX shows neither)
- ✅ Property-based tests via fast-check (`tests/property-based.test.ts`)
- ✅ **QBO mapper (v0.5)** — `src/lib/mappers/qbo/` ships end-to-end QBO import + reverse exporter with lineage roundtrip. See `docs/qbo-mapping.md`.
- ✅ **Allowance method (v0.5)** — `estimateBadDebtAllowance` + `writeOffArItem({ method: "ALLOWANCE" })`.
- ✅ **NetSuite mapper + dimension engine exercise (v0.6)** — `src/lib/mappers/netsuite/` ships end-to-end NS import (4 dimensions: CLASS/DEPARTMENT/LOCATION + custom segments), per-line dimension assignments deduplicated via stable hash, custom fields in `extensions JSONB`, lineage roundtrip. See `docs/netsuite-mapping.md`.

## What lands next (v0.7)

- 🚧 Next.js UI: dashboard, chart of accounts, journal entries, all reports + BTD, multi-book switcher
- 🚧 Vercel + Neon live demo + Loom walkthrough
- 🚧 Multi-entity consolidation report with intercompany eliminations
- 🚧 NS Accounting Books (multi-book parallel posting from one NS transaction)
- 🚧 Cash flow statement

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
- Every `postJournalEntry` call targets ONE `(entity, book)`. To post to N books for a single source event, either call N times (still fine for one-off entries) or use the posting-rules engine via `postWithRules({ sourceEventType, payload, books })` — register a `PostingRule` per `(sourceEventType, bookId)` once, then any caller can fire the event without knowing about books.
- Reports always scope to `(entity, book)`. There is no book-agnostic report; cross-book views are computed by diffing two scoped reports (see `getBookTaxDifference`).
- `bookId="PRIMARY"` is NOT a thing in this schema. Real book codes are `US_GAAP`, `US_TAX`, `IFRS`, etc.
- Sub-ledger records (AR/AP open items, FixedAssetBookAttributes, etc.) are per-book. One physical asset → one `FixedAsset` row + N `FixedAssetBookAttributes` rows. Same for leases and revenue contracts.

### Posting-rules engine
- DSL is intentionally minimal: `$.path` lookups + `${$.path}` interpolation. No arithmetic, no conditionals. If a rule needs more, author it in TS via `postJournalEntry` directly. Don't grow the DSL.
- Each rule is keyed by `(sourceEventType, bookId, ruleVersion)`. New version supersedes old via `isActive`. Treat ruleVersion as an audit trail of when the GL mapping changed.
- Sub-ledger lifecycle (open AR/AP, mark fixed asset disposed) is NOT part of posting rules. Rules emit GL lines only. Sub-ledger updates happen in the caller around the `postWithRules` call.

### ERP mappers (`src/lib/mappers/`)
- One subdirectory per source system: `qbo/` (v0.5), `netsuite/` (v0.6). Future systems (SAP, Intacct, Dynamics) follow the same pattern.
- Each mapper has these layers: `types.ts` (source-system shape), `mappers.ts` (pure transformations, no DB), `import.ts` (idempotent orchestrator with lineage), `export.ts` (reverse — reads frozen sourcePayload to reconstruct the source JSON), `dimensions.ts` (only when the source has dimensions — NS does; QBO doesn't).
- Every imported row MUST populate `sourceSystem`, `sourceRecordType`, `sourceRecordId`, `sourcePayload` (the frozen raw original — verbatim, not a re-encoding), `mappingVersion`. The roundtrip proof depends on `sourcePayload` being preserved exactly.
- Idempotency: before creating a row, query for an existing row with the same `(sourceSystem, sourceRecordType, sourceRecordId)`. If found, skip. The QBO and NS orchestrators are reference implementations.
- Account codes from a source ERP get prefixed to avoid collisions: `Q<id>` for QBO, `NS<internalid>` for NetSuite. New mappers pick a short prefix and stay consistent. The original ID is preserved in `sourceRecordId`.

### Dimension engine (Layer 3)
- Three first-class tables: `Dimension` (the kind: CLASS, DEPARTMENT, LOCATION, etc.), `DimensionValue` (one row per value within a kind), `DimensionSet` (a deduplicated combination of `(dimension, value)` pairs), `DimensionSetValue` (the bridge).
- Lines reference `DimensionSet` via `JournalLine.dimensionSetId`. Two lines with identical assignments share one `DimensionSet` row (dedup via stable hash on `DimensionSet.hash`).
- The hash is plain string `dim1:val1|dim2:val2|...` sorted by dimensionCode. Not crypto — collision risk is essentially zero at our scale.
- `getOrCreateDimensionSet` in `src/lib/mappers/netsuite/dimensions.ts` is the canonical entry point. New mappers that need dimensions should call it directly.

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
