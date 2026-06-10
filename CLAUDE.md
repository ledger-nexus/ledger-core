# Claude Code Instructions for ledger-core

This file is auto-loaded by Claude Code on every session in this repo. It tells you what this project is, how to work in it, and what rules are non-negotiable.

If a user request conflicts with anything in this file, ask before proceeding.

---

## What this project is

`ledger-core` is the **universal accounting substrate** — Layers 1 and 2 (with seams for 3–6) of a multi-book general ledger that can absorb data from any major ERP. It is the foundation of the `ledger-nexus` portfolio (this repo + `recon` + `revenue-rec` + `fa-amort` + `integrations`).

The owner is a CPA shipping with AI. They wrote the universal schema spec (`docs/universal-schema.md`); you implement against it. The architecture decisions in that doc are LOCKED — do not re-litigate them in conversation, do not propose alternatives, do not soften them. Read the file. Ask if anything is unclear.

## The non-negotiables

1. **The universal schema is canon.** `docs/universal-schema.md` is the architectural contract. Multi-book is locked. Pattern 2 (full parallel posting) is locked. The anti-patterns list is a hard constraint.

2. **Every ledger write goes through `postJournalEntry`.** It enforces debits = credits, atomicity, account validity, book scope, and period close. If you find yourself bypassing it, stop.

3. **AI suggests; humans approve; the system posts.** AI is not trusted to post entries directly. Any AI-influenced entry flows through `postJournalEntry` with `source: "AI_APPROVED"` after human confirmation (reference example: the FX revaluation gate at `/reports/fx-revaluation`).

4. **The invariant tests are the contract.** If a change you make causes one to fail, the change is wrong — not the test. Never disable a test to go green; fix the test or the code.

## Current state (v1.25)

Full version history lives in `PROJECT_STATUS.md` — read that for the "when/why" of every arc. The capability map:

- **Substrate (Layers 1–6)** — `Account` / `JournalEntry` / `JournalLine` (three currency amounts, lineage, multi-book), entities/books/currencies/FX rates/calendars/periods/parties/items, dimension engine, posting-rules engine (`src/lib/accounting/posting-rules.ts`, minimal `$.path` DSL), `extensions Json` + custom-field registry, source-system lineage. Idempotent JE posts dedupe on `(sourceSystem, sourceRecordType, sourceRecordId)`.
- **Native sub-ledgers** — AR/AP open items + applications (`src/lib/accounting/sub-ledgers/`), fixed assets + depreciation + disposal, ASC 842 leases, revenue contracts; allowance-method bad debt.
- **ERP mappers** — QBO (`src/lib/mappers/qbo/`) and NetSuite incl. multi-subsidiary (`src/lib/mappers/netsuite/`), both with reverse exporters and frozen-`sourcePayload` roundtrip proofs.
- **Reports** — TB, IS, BS, cash flow (indirect), AR/AP aging, book-tax difference, M-3 detail, multi-entity consolidation with intercompany eliminations, month-end packet (+PDF), CSV routes for all.
- **UI** — full Next.js 14 App Router surface: dashboard, COA, JE list/detail/new/paste, AR/AP workbenches, periods + close/reopen, all report pages, import pages. Server Components by default; Server Actions for writes.
- **Close management (BlackLine-style)** — Reconciliations (state machine + sign-off + sub-ledger auto-pull, `src/lib/recon/`), Close Task Calendar (dependency DAG + templates + append-only state history, `src/lib/close-tasks/` + `CloseTaskStateChange`), Flux/variance analysis (frozen snapshots, `src/lib/flux/`), cross-pillar dashboard + alerts + retrospective (`src/lib/close/`, `/close`, `/api/close/alerts`).
- **Notifications** — Slack close-alert dispatcher (`src/lib/notifications/`): IMMEDIATE (15-min business-hours cron) and DIGEST_DAILY (09:00 UTC) cadences, webhook URLs AES-256-GCM-encrypted at rest (`WEBHOOK_ENCRYPTION_KEY`, rotation script in `scripts/`), dedupe via `notification_dispatch @@unique(channelId, alertFingerprint)`, admin UI at `/admin/notification-channels`.
- **Recurring JEs** — templates + anchored monthly enumeration + daily cron auto-run (`src/lib/accounting/recurring.ts`), idempotent via lineage.
- **FX revaluation (ASC 830 / IAS 21)** — `Account.isMonetary`, `resolveFxRate` (CLOSE/AVG curves, on-or-before, inverse fallback) in `src/lib/accounting/fx.ts`, pure `computeRevaluation` + posting `postRevaluation` (adjustment + auto-reversal next period) behind the human-approval gate. P&L accounts 8300/8310.
- **Multi-tenancy** — every customer-data table carries `tenantId`; scope resolves from session via `getCurrentScope()` / `requireCurrentTenant()`, never client input. **RLS status: Phase 1 only** — `withTenantContext` (`src/lib/tenant-context.ts`) sets the `app.current_tenant_id` GUC but NO policies exist and queries use the raw singleton; enforcement is application-level WHERE clauses. Do not assume RLS is live (deficiency #12, open).
- **SOC 2 stack** — append-only `audit_log` (DB trigger), `logAuditEvent`/`auditPrivilegedAction`, column-level encryption extension, DSR export/erasure, timing-safe cron auth (`src/lib/auth/cron.ts`), control matrix + deficiency log under `docs/policies/`.

Open items beyond v1.25: RLS Phases 2–4 (policies → query-path migration → FORCE; see `docs/multi-tenancy.md`), CTA for foreign consolidated entities, realized FX on settlement.

## Stack

- Postgres + Prisma (`@@map` keeps SQL names aligned with universal-schema vocabulary); Neon in prod; tests run against a real Postgres
- decimal.js for all money math
- Vitest; **npm** is the package manager (lockfile is `package-lock.json`; CI runs `npm ci`) — older docs that say `pnpm` are historical
- Next.js 14 (App Router) — UI fully shipped; `zod` for input validation; `@react-pdf/renderer` for the month-end packet

## Rules for working in this codebase

### Money math
- Always use `Decimal` from `decimal.js`. Never `Number`. Compare with `.equals()` / `.comparedTo()`, not `===`.
- When converting from Prisma's `Decimal`, use `new Decimal(value.toString())`.

### Database writes
- All ledger writes flow through `postJournalEntry`. No exceptions. It accepts `PrismaClient | Prisma.TransactionClient` so it can nest inside outer transactions.
- Schema changes require a Prisma migration; never edit the DB directly. NOTE: CI uses `prisma db push`, which skips migration SQL — triggers and other non-Prisma DDL added in a migration also need a mirror block in `.github/workflows/ci.yml` (see the migration-0011 step there).
- New columns on `Account` / `JournalEntry` / `JournalLine` must respect the anti-patterns list in `docs/universal-schema.md`.

### Tenant scoping
- Every query against a tenant-scoped table MUST filter by `tenantId`, derived from the session (`getCurrentScope()` / `requireCurrentTenant()`), never from client input. Server Actions authorize (admin checks) before mutating, and every privileged mutation writes an audit row.
- Cron routes authenticate with `isAuthorizedCronRequest` (timing-safe `CRON_SECRET`); schedules live in `vercel.json`.
- Never log webhook payloads or URLs; decrypt webhook URLs only at send time; scrub URLs from persisted error strings (see `src/lib/notifications/`).

### Multi-book discipline
- Every `postJournalEntry` call targets ONE `(entity, book)`. For N books per source event, call N times or use `postWithRules`. Real book codes are `US_GAAP`, `US_TAX`, `IFRS` — `bookId="PRIMARY"` is not a thing.
- Reports always scope to `(entity, book)`; cross-book views diff two scoped reports. Sub-ledger records are per-book.

### Posting-rules engine
- DSL stays minimal: `$.path` lookups + `${$.path}` interpolation, no arithmetic/conditionals — author complex rules in TS via `postJournalEntry`. Rules emit GL lines only; sub-ledger lifecycle happens in the caller.

### ERP mappers (`src/lib/mappers/`)
- One subdirectory per source system, layered `types.ts` / `mappers.ts` (pure) / `import.ts` (idempotent orchestrator) / `export.ts` (reads frozen `sourcePayload`) / `dimensions.ts` (if the source has them).
- Every imported row populates the full lineage set with `sourcePayload` preserved verbatim. Account codes get a short source prefix (`Q…`, `NS…`). Idempotency: skip when the lineage triple already exists.

### Dimension engine (Layer 3)
- Lines reference deduplicated `DimensionSet` rows (stable `dim:val|…` hash). `getOrCreateDimensionSet` in `src/lib/mappers/netsuite/dimensions.ts` is the canonical entry point.

### Testing
- New accounting logic gets an invariant test. Tests run against a real Postgres (`DATABASE_URL`); don't mock the DB. Run `npm test` after touching `src/lib/accounting/` or `prisma/`.
- The test DB is shared and persistent: suites must be collision-safe — mint per-run fixtures (unique suffixes, dedicated calendars/tenants) instead of reusing shared rows with random ordinals, and DB-dependent suites must skip (not fail) when `DATABASE_URL` is absent if they live in a DB-free workflow.

### Lineage
- Every ERP-import path populates `sourceSystem` / `sourceRecordType` / `sourceRecordId` / `sourcePayload` (frozen raw JSON) / `mappingVersion`. Never reuse a source-system PK as our PK.

### UI work
- App Router conventions; Server Components by default; Server Actions in `src/app/actions/` for forms. UI primitives are inlined in `src/components/ui/` (no shadcn CLI). Money displays through `formatMoney()`.
- The scope cookie (`lc-scope`) is the canonical `(entity, book)` for the UI — read via `getCurrentScope()`, write via `setScopeAction`. Import `prisma` from `@/lib/db` (singleton); never `new PrismaClient()` in a page or component.

## How to start a session

1. Read this file
2. Read `docs/universal-schema.md` (the architecture canon)
3. Read `PROJECT_STATUS.md` for current state + version history
4. For security-touching work, check `docs/policies/control-deficiency-log.md` for open items
5. Confirm understanding before suggesting work

## Style preferences

- Be direct. The user is a CPA — they understand precision.
- Comments explain *accounting* reasoning, not code mechanics. "This is the contra-account sign flip" is useful; "this loops through the array" is not.
- When you finish a unit of work, update `PROJECT_STATUS.md`.
