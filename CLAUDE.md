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

5. **All error emission goes through the monitoring shim.** `src/lib/monitoring/index.ts` (shipped via PR #10) is the canonical path — `captureError(err, context)` / `captureMessage(msg, level, context)`. Every emit runs `redactPii()` from `src/lib/soc2/` before the error reaches Sentry or the console fallback. **Never call Sentry directly + never console.error a Prisma error's `.message`** — Prisma errors echo column values verbatim in their messages, which on this substrate include party names, account codes, amounts (Confidentiality TSC leak class). The shim's `sanitizeErrorForCapture()` also strips the V8 stack preamble so `.message` PII can't leak via `.stack` (14th adversarial pass closure 2026-06-05). Add new field names to `src/lib/soc2/index.ts` `redactPii` allowlist when new sensitive columns ship — over-redaction is acceptable; under-redaction is a SOC 2 finding.

## SOC 2 + adversarial-pass cadence

This repo is the substrate of the ledger-nexus portfolio's SOC 2 Type 2 readiness program. Current state (`docs/SOC2_READINESS.md` v2.3): **≈80% to Type 1 audit-ready**.

**Adversarial-pass discipline:** every substantive code shipment (new posting flow, new internal HTTP endpoint, encryption work, audit-log change, monitoring code, anything cross-tenant-touching) should be followed by an adversarial-pass audit before merge. The portfolio has run **14 adversarial passes** to date. Recent passes found real HIGHs in newly-shipped code from across the portfolio (not just ledger-core):

- **12th pass:** found bearer-token leak class in upstream-body error embedding (asc606 repo) — closed via `scrubUpstreamBody()` helper applied to 35+ sites
- **13th pass:** found silent `catch {}` in fa-amort + unbacked audit_log delegation claim in revenue-rec
- **14th pass:** found Error.stack PII leak via V8 preamble across the 4-PR Sentry shim arc

Standing rule: when a substantive change ships, run an adversarial pass before declaring done. **The cadence IS the SOC 2 CC4 evidence** — auditors grade "this team finds + closes their own weaknesses without external intervention." A self-discovered HIGH closed in-session with tests pinning the attack scenario is the highest-confidence CC4 evidence form the framework recognizes.

**See `docs/policies/control-deficiency-log.md` v2.3 + `docs/SOC2_READINESS.md` v2.3 for the full session evidence trail** (6 amendments captured 5 closures + 1 new meta-control).

## What's wired now (v1.0)

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
- ✅ **Next.js UI (v0.7)** — read-only surface in `src/app/`. Sidebar nav + multi-book switcher (cookie-backed via `setScopeAction` Server Action), dashboard, chart of accounts, journal entries list + detail (with frozen lineage payload), all four reports including BTD. Deployment guide at `docs/deployment.md`.
- ✅ **Interactive UI + demo reset (v0.8)** — `/journal-entries/new` with live debit/credit balance indicator, `/ar` and `/ap` with inline apply-payment forms, `POST /api/admin/reset` gated by `ADMIN_TOKEN`. Seed extracted to `src/lib/seed/northwind.ts` so the CLI and the reset endpoint share one code path.
- ✅ **Cash Flow + AR Aging + CSV exports (v0.9)** — `getCashFlowStatement()` (indirect method) with classification heuristic + reconciliation tie-out + `uncategorized` self-audit panel. `/reports/cash-flow` and `/reports/ar-aging` pages. CSV route handlers under `/api/reports/.../csv` for all six reports, with Download buttons on each page.
- ✅ **Multi-entity consolidation + AP aging + M-3 detail (v1.0)** — `getConsolidatedTrialBalance()` walks the `LegalEntity.parentEntityId` hierarchy + eliminates intercompany subtype accounts (DUE_FROM/DUE_TO_AFFILIATE, INTERCOMPANY_REV/EXP). `seedConsolidationDemo()` ships an Acme Group + 2 subs hierarchy so the page renders out of the box. `getM3Detail()` groups BTD deltas by Form 1120 Schedule M-3 line. `apAging()` mirrors `arAging()`. Three new report pages + CSVs.
- ✅ **Internal HTTP endpoint for companion repos (v1.2)** — `POST /api/internal/journal-entries` is the boundary recon (v0.2-beta) and future revenue-rec use to write JEs through `postJournalEntry`. Gated by `INTERNAL_API_TOKEN`, returns structured `{code, message}` errors mirroring the postJournalEntry error types (UNBALANCED, PERIOD_CLOSED, etc.). NO companion repo touches ledger-core source directly — the wire format is the contract.
- ✅ **Idempotent JE posts + transactional depreciation endpoint (v1.11)** — `POST /api/internal/journal-entries` now dedupes by the lineage triple `(sourceSystem, sourceRecordType, sourceRecordId)` via a partial unique index; a repeat post returns the existing entry with `wasDuplicate: true`. New endpoint `POST /api/internal/fixed-asset/record-depreciation` wraps N JE posts + the `FixedAssetBookAttributes` update in one transaction — closes fa-amort's v0.1 two-step drift window. `postJournalEntry` now accepts either a `PrismaClient` or a `TransactionClient` so it can be invoked from inside an outer transaction.
- ✅ **Period close UI + month-end packet (v1.12–v1.13)** — `/periods` page with admin-gated close/reopen Server Actions. `/reports/month-end?period=YYYY-MM` is the composite view (cover + IS + BS + TB tie-out checks). `/api/reports/month-end/{csv,pdf}` downloads via `@react-pdf/renderer`. Closing a period writes a `PeriodClose` row that `postJournalEntry` honors.
- ✅ **One-shot demo flow (v1.17)** — `pnpm demo` wipes a dedicated `DEMO_CO` entity, posts 28 JEs across one believable May 2026 (capital contribution, prepaid rent, equipment purchase, AR + AP cycles, multi-book depreciation, ASC 606 deferred revenue, month-end accruals), and closes May on US_GAAP. Opens to a tied-out month-end packet you can hand to a CPA cold. Doesn't touch Northwind. Entry point: `prisma/demo.ts` calling `seedDemoMonth()` in `src/lib/seed/demo-month.ts`.

## v1.0 is the portfolio milestone

The roadmap from v0.2 (universal substrate scaffolding) to v1.0 (full multi-entity, multi-book, dual-mapper, three-statement, tax-provision-aware portfolio) is complete. Beyond v1.0 is polish (autocomplete, recurring entries, multi-currency revaluation, FX gain/loss wiring) — not new architecture.

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

### UI work (v0.7)
- App Router conventions in `src/app/`. Server Components by default; client components only when interactivity demands it.
- UI primitives are inlined in `src/components/ui/` (no shadcn CLI dep). To add a new primitive, follow the existing pattern: `cn()` helper for class composition, `forwardRef` for inputs, simple variant maps for things like Button/Badge.
- Forms: Server Actions (files marked `"use server"` in `src/app/actions/`). Don't add API routes unless an external caller needs them.
- Money values run through `formatMoney()` in `src/lib/utils/format.ts` for consistent display (2 decimals, comma thousands, parens for negatives — accountant convention).
- The scope cookie (`lc-scope`) is the canonical source for which `(entity, book)` the UI is viewing. Read with `getScope()` (Server Components); write via `setScopeAction` (Server Action). Never plumb scope through query params except for one-shot overrides (e.g. the BTD report's from/to book selectors).
- Database access: import `prisma` from `@/lib/db` (the singleton). Never `new PrismaClient()` in a page or component — that exhausts the connection pool in dev under HMR.

## How to start a session

1. Read this file
2. Read `docs/universal-schema.md` (the architecture canon)
3. Read `PROJECT_STATUS.md` for the latest "where we are / what's next" (note: status doc is being rewritten in the next batch)
4. Confirm understanding before suggesting work

## Style preferences

- Be direct. The user is a CPA — they understand precision.
- Comments explain *accounting* reasoning, not code mechanics. "This is the contra-account sign flip" is useful; "this loops through the array" is not.
- When you finish a unit of work, suggest updating `PROJECT_STATUS.md`.
