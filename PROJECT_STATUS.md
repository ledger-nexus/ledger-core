# Project Status

Running log of where this project is, what's next, and key decisions. Updated at the end of each working session so the next session (whether by me or by Claude Code) can pick up without re-explaining context.

---

## Where we are

**Last updated:** 2026-06-08

**Current state:** **v0.9 NS Accounting Books arc — Phase 3 (per-tx routing through importer) shipped.** Multi-book parallel posting from real NS exports now works end-to-end at the JournalEntry path. A 2-book NS export creates N JEs per NS JournalEntry transaction (one per mapped ledger-core book), and the existing Book-Tax-Difference report sees both books' postings. The Phase 2 schema unblock (scoping the lineage-uniq index to `(tenantId, bookId)`) also fixed a long-standing multi-tenant collision bug as a side effect.

Earlier today (also captured below): **v0.8 ASC 830 FX translation arc** closed. The cross-currency multi-sub demo is CPA-credible end-to-end — transactions post at posting-time rate, AR/AP settlement at a different rate posts realized FX gain/loss, consolidated TB translates per ASC 830 category with a CTA plug.

**Repo:** https://github.com/ledger-nexus/ledger-core

---

## What's done

### v0.2 — Universal substrate (Layer 1+2 + seams for 3–6)
- [x] LegalEntity / Book / FiscalCalendar / Period / PeriodClose / Currency / FxRate
- [x] Party + PartyRole (unified Customer/Vendor/Employee)
- [x] Item with itemType + costing method
- [x] Account with hierarchy, control-account flags, book-scope, lineage columns
- [x] JournalEntry / JournalLine with three-currency view + lineage + dimension slot
- [x] Dimension engine tables (no values seeded)
- [x] PostingRule table (no rules registered)
- [x] CustomFieldDefinition + `extensions Json` + GIN indexes
- [x] Multi-book scoped reports (TB, IS, BS) per (entity, book)
- [x] Invariant test suite with multi-book isolation

### v0.3 — Native sub-ledgers + Pattern 2 multi-book seed
- [x] ArOpenItem + ArApplication + lifecycle helpers (open / apply / write off / aging)
- [x] ApOpenItem + ApApplication (mirror of AR)
- [x] FixedAsset + FixedAssetBookAttributes with `runDepreciation` (STRAIGHT_LINE + MACRS_5_HY stub)
- [x] Lease + LeaseBookAttributes (ASC 842 classification slots) with `runLeaseStraightLineExpense` stub
- [x] RevenueContract + PerformanceObligation + RevenueContractBookAttributes with `runStraightLineRecognition`
- [x] Book-tax-difference report with heuristic permanent/temporary classification
- [x] Northwind seed rewritten — every entry posts to US_GAAP + US_TAX + IFRS in parallel
- [x] Northwind depreciation diverges: 36-mo SL (GAAP/IFRS) vs 60-mo SL (TAX) → $1,600 BTD by 6/30
- [x] Northwind Globex prepay diverges: accrual books defer, tax book recognizes immediately
- [x] Sub-ledger reconciliation invariants (sum of open = control account balance)
- [x] Schema ERD updated to two diagrams (core + sub-ledgers)

### v0.4 — Posting-rules engine + full ASC 842 + disposal + bad debt + fast-check
- [x] Posting-rules engine (`src/lib/accounting/posting-rules.ts`) with minimal `$.path` DSL, `${$.path}` interpolation, and `registerUniformRule` for the common multi-book case. Engine looks up the latest active rule per (sourceEventType, bookId), applies the template, and posts via `postJournalEntry`.
- [x] Full ASC 842 mechanics in `runLeaseAccounting`: lease commencement (Dr ROU, Cr Lease Liability at PV of payments), monthly amortization (combined JE Dr Lease Expense / Cr ROU / Cr Lease Liability), and cash payment (Dr Lease Liability / Cr Cash). Finance + cash-basis-tax classifications handled in the same function.
- [x] Fixed asset disposal flow (`disposeFixedAsset`) — catches up depreciation through disposal date, posts paired JE (Dr Cash, Dr Accum Dep, Cr Asset gross, Dr/Cr Gain-Loss), marks asset DISPOSED. Gain/loss diverges per book due to different accumulated depreciation balances.
- [x] AR bad debt write-off (`writeOffArItem`) now posts the paired JE (Dr Bad Debt Expense, Cr AR) so the AR-control = sum-of-open invariant holds after write-off.
- [x] Property-based tests via fast-check (`tests/property-based.test.ts`) covering: balanced entries always accepted with balancing TB; unbalanced entries always rejected; arbitrary sequences leave BS balanced; AR open-item invariant survives arbitrary application sequences.
- [x] New accounts wired: 1210 Allowance for Doubtful Accounts (contra-AR), 1600 ROU Asset, 2600 Lease Liability, 7400 Lease Expense — Operating, 7500 Bad Debt Expense, 8100 Gain/Loss on Disposal, 8200 Interest Expense.

### v0.5 — QBO mapping (validate-by-mapping milestone) + allowance-method bad debt
- [x] Sample QBO export fixture (`prisma/fixtures/qbo-sample.json`) modeled on the QBO REST API shape: Accounts, Customers, Vendors, Invoices, Bills, Payments, BillPayments, JournalEntries.
- [x] QBO type definitions (`src/lib/mappers/qbo/types.ts`) — hand-rolled from the QBO API docs to avoid the heavy SDK dependency.
- [x] Pure mapper functions (`src/lib/mappers/qbo/mappers.ts`): mapAccount, mapCustomer, mapVendor, mapInvoice, mapBill, mapPayment, mapBillPayment, mapJournalEntry. Side-effect-free; testable without a DB.
- [x] Import orchestrator (`src/lib/mappers/qbo/import.ts`): idempotent end-to-end. Imports accounts → parties → JEs → invoices (opens AR) → bills (opens AP) → payments (applies AR) → bill payments (applies AP). Layer 6 lineage on every row.
- [x] Reverse exporter (`src/lib/mappers/qbo/export.ts`): reads frozen sourcePayload from each lineage row and reassembles a QBO-shaped export. The roundtrip proof of the universal-schema thesis.
- [x] Allowance method for bad debt (`estimateBadDebtAllowance` + `writeOffArItem({ method: "ALLOWANCE" })`): build the allowance via Dr Bad Debt / Cr Allowance, then apply via Dr Allowance / Cr AR — no double-counting of bad debt expense.
- [x] Tests (`tests/qbo-mapping.test.ts`): structural invariants (counts, lineage populated, AR/AP sub-ledger sums match control account, idempotency), roundtrip equivalence via diffQboExports.
- [x] Allowance-method tests added to v0.4 features suite.
- [x] New doc `docs/qbo-mapping.md` explains the import/export flow + the lineage roundtrip guarantee.

### v0.6 — NetSuite mapping (ceiling test) + dimension engine exercise
- [x] Sample NetSuite fixture (`prisma/fixtures/netsuite-sample.json`) modeled on SuiteScript / SuiteAnalytics export shape with classes, departments, locations, a custom segment, custom fields on transactions/customers, invoices/bills/payments with line-level dimension assignments.
- [x] NS type definitions (`src/lib/mappers/netsuite/types.ts`).
- [x] Dimension engine helpers (`src/lib/mappers/netsuite/dimensions.ts`): `setupDimension`, `setupDimensionValue`, `getOrCreateDimensionSet` with deterministic order-insensitive hash. The first real workout of Layer 3.
- [x] Pure mappers (`src/lib/mappers/netsuite/mappers.ts`) covering account, customer, vendor, item, invoice, bill, customer payment, vendor payment, journal entry — each extracts line-level dimension assignments and entity-level custom fields.
- [x] Import orchestrator (`src/lib/mappers/netsuite/import.ts`): registers custom fields, sets up dimensions, then imports accounts → parties → items → JEs → invoices+AR → bills+AP → payments. Each line gets a `dimensionSetId` via the dedup engine.
- [x] Reverse exporter (`src/lib/mappers/netsuite/export.ts`) with the same lineage-replay pattern as QBO.
- [x] Tests (`tests/netsuite-mapping.test.ts`): hash determinism, structural counts, sub-ledger reconciliation, dimension-engine population assertions (4 dimensions, 9 values, 5 distinct DimensionSets including the dedup case where two identical JE lines share one set), per-line dimension assignments match input, aggregation-by-department produces correct revenue totals, custom-field round-trip, idempotency, full roundtrip equivalence.
- [x] New doc `docs/netsuite-mapping.md` — the ceiling-test companion to qbo-mapping.md.

### v0.7 — Next.js UI on top of the substrate
- [x] Tailwind config + global styles + accountant-friendly color palette (slate-leaning neutrals; emerald for positive numbers; red for negative).
- [x] Inline UI primitives (`src/components/ui/`): Card, Table, Button, Badge, Input, Select, EmptyState. No shadcn CLI dependency — kept inline so the bundle stays small and the components are auditable.
- [x] Singleton PrismaClient (`src/lib/db.ts`) compatible with Next.js HMR.
- [x] Scope cookie (`lc-scope` = `{entityCode, bookCode}`) read by Server Components via `getScope()`, written by the `setScopeAction` Server Action. Default scope: NORTHWIND / US_GAAP.
- [x] Root layout (`src/app/layout.tsx`) with sidebar nav + header showing the current scope and a BookSwitcher card.
- [x] Dashboard (`/`): KPI grid (Cash, AR open, AP open, Fixed-asset NBV, Revenue YTD, Expenses YTD, Net Income YTD, BTD vs US_TAX delta when scope = US_GAAP), recent journal entries table.
- [x] Chart of accounts (`/accounts`): grouped by AccountType, lineage badge per imported account, contra/control/bank flag badges.
- [x] Journal entries (`/journal-entries`): paginated table with date range filter via URL params; detail page (`/journal-entries/[id]`) shows balanced line table + the frozen `sourcePayload` JSON (the Layer 6 lineage payoff displayed verbatim).
- [x] Trial Balance (`/reports/trial-balance`): as-of date picker, balanced badge.
- [x] Income Statement (`/reports/income-statement`): period range, two-column revenue/expenses, net income panel.
- [x] Balance Sheet (`/reports/balance-sheet`): assets / liabilities / equity tables, A=L+E equation strip with balanced badge, retained earnings line.
- [x] Book–Tax Difference (`/reports/book-tax-difference`): from-book/to-book selector + period range, summary KPIs (book NI, tax NI, Δ), P&L and BS delta tables with classification badges (PERMANENT/TEMPORARY/UNCLASSIFIED).
- [x] Deployment guide (`docs/deployment.md`): Vercel + Neon end-to-end in ~10 minutes, including the Loom walkthrough script (6 beats, 2 minutes total).
- [x] `vercel.json` wires `prisma generate` into the build command.
- [x] Updated `.env.example` for Neon's `sslmode=require` connection string.

### v0.8 — Manual JE form + AR/AP application UI + demo reset
- [x] Seed refactored into a callable module (`src/lib/seed/northwind.ts`) exporting `seedNorthwind(prisma)`, `resetNorthwindData(prisma)`, and `resetAndReseedNorthwind(prisma)`. `prisma/seed.ts` becomes a thin script wrapper.
- [x] `/journal-entries/new`: Client Component (`new-entry-form.tsx`) with multi-line table, per-line side selector + account dropdown + party + description + amount, add/remove rows, live Σ Dr / Σ Cr / Δ totals memoized on every keystroke. Submit button disabled when unbalanced, missing accounts, or zero amounts. Backed by `createJournalEntryAction` Server Action which calls `postJournalEntry`, surfaces `UnbalancedEntryError` / `UnknownAccountError` / etc. inline, and redirects to `/journal-entries/[id]` on success.
- [x] `/ar` and `/ap` pages with per-row inline payment forms. Cash-account select (filtered to `isBank` accounts), amount (defaults to current balance), payment date. `applyArPaymentAction` and `applyApPaymentAction` post the cash JE and call `applyArPayment`/`applyApPayment` atomically.
- [x] `POST /api/admin/reset` endpoint gated by `ADMIN_TOKEN` env. Calls `resetAndReseedNorthwind(prisma)` and returns timing metrics. Fails closed with 503 if the token isn't set.
- [x] Sidebar nav extended with "New entry", "Open AR", "Open AP" links.
- [x] `docs/deployment.md` and `.env.example` updated for `ADMIN_TOKEN` usage + Vercel Cron schedule example.

### v0.9 — Cash Flow Statement + AR Aging + CSV exports
- [x] `getCashFlowStatement()` in `src/lib/accounting/reports/cash-flow.ts` — indirect method. Classification heuristic via account subtype + type: OPERATING_NONCASH (depreciation, amortization), OPERATING_WC (AR, AP, inventory, prepaid, accrued, deferred revenue, allowance, sales tax), INVESTING (fixed asset cost, accum dep contra, intangible, ROU), FINANCING (equity, lease liability, debt). Anything the heuristic can't place surfaces in an `uncategorized` array.
- [x] Reconciliation tie-out: computed netCashFlow vs actual Δ cash from the BS. `reconciles` boolean + `reconcilingDifference` decimal in the result. Mismatches surface in the page's badge + the uncategorized panel.
- [x] `/reports/cash-flow` page with Operating / Investing / Financing sections, reconciliation strip at the top, uncategorized panel when relevant.
- [x] `/reports/ar-aging` page using existing `arAging()` function. Bucket KPI cards + detail table with per-row days-overdue + bucket badges. Links to `/ar` for apply-payment.
- [x] CSV utility (`toCsv` in `src/lib/utils/csv.ts`) — RFC 4180-ish escaping for cells with commas / quotes / newlines.
- [x] CSV route handlers for all six reports: `/api/reports/{trial-balance,income-statement,balance-sheet,book-tax-difference,cash-flow,ar-aging}/csv?<params>`. Use the same scope cookie and search params as the corresponding pages.
- [x] "Download CSV" link on every report page.
- [x] Sidebar nav gains Cash flow and AR aging.
- [x] Tests (`tests/cash-flow.test.ts`): capital infusion only, all-AR no-collection (NI offsets Δ AR), capex + cash sale, depreciation add-back. All assertions verify `reconciles === true`.

### v1.0 — Multi-entity consolidation + AP aging + M-1/M-3 detail
- [x] `apAging()` function in `src/lib/accounting/sub-ledgers/ap.ts` (mirror of `arAging`).
- [x] `/reports/ap-aging` page + `/api/reports/ap-aging/csv` route — bucket KPI cards + detail with days-overdue badges, link out to `/ap` for paying bills.
- [x] Four new intercompany accounts in the chart: `1300 Due from Affiliates`, `2400 Due to Affiliates`, `4900 Intercompany Revenue`, `5900 Intercompany Expense` — with subtypes (DUE_FROM_AFFILIATE / DUE_TO_AFFILIATE / INTERCOMPANY_REV / INTERCOMPANY_EXP) that the consolidation engine recognizes for elimination.
- [x] `seedConsolidationDemo()` in `src/lib/seed/consolidation-demo.ts` — sets up ACME_GROUP parent + ACME_US + ACME_UK subs with capital, external revenue, and a $3k intercompany sale. Bundled into `pnpm db:seed`.
- [x] `getConsolidatedTrialBalance()` in `src/lib/accounting/reports/consolidation.ts` — walks `LegalEntity.parentEntityId` hierarchy, aggregates per-entity TBs, eliminates intercompany subtype accounts. Returns per-entity contributions + elimination summary + post-elim totals + `netIcImbalance` (non-zero = one side recorded without its counterparty).
- [x] `/reports/consolidation` page + `/api/reports/consolidation/csv` — per-entity contribution columns, IC elimination summary, consolidated TB with sign-corrected balances.
- [x] `getM3Detail()` in `src/lib/accounting/reports/m3-detail.ts` — wraps `getBookTaxDifference` and groups deltas by Form 1120 Schedule M-3 line (Depreciation, Bad debt, Lease accounting, Deferred revenue, Accrued liabilities, Inventory, Stock comp, Meals, State tax, Charitable, Other timing, Other permanent, Unclassified). Subtype-driven so QBO/NS imports work without code changes.
- [x] `/reports/m3-detail` page + `/api/reports/m3-detail/csv` — Permanent / Temporary / Unclassified summary cards, per-M3-line group cards with row detail.
- [x] Sidebar nav updated with Consolidation, AP aging, M-3 detail links.
- [x] Tests (`tests/consolidation.test.ts`): aggregation across subs, IC elimination (DUE_FROM + DUE_TO + IC Rev + IC Exp all cancel), IC imbalance detection, non-IC accounts pass through unchanged.

**Deliberately deferred (post-v1.0):**
- NS Accounting Books (multi-book parallel posting from one NS transaction) — niche refinement; deferred because it requires fixture + mapper expansion with low portfolio payoff.
- ASC 842 cash flow presentation polish — the indirect method shows the right total but mis-classifies lease principal. Real-world refinement, not a portfolio differentiator.

---

## v1.0 is the portfolio milestone. Beyond:

### v1.1 — Loom script + autocomplete polish (shipped 2026-05-21)
- [x] `docs/deployment.md` Loom walkthrough updated to 8 beats — adds the consolidation IC elimination demo (beat 7) and the M-3 depreciation grouping (beat 8). Total run time still ~3 minutes.
- [x] Account autocomplete on `/journal-entries/new` via native `<datalist>` (no new deps). Same datalist pattern for the party selector. User types code OR name and the browser filters; no need to scroll a 35-account dropdown.

### v0.7 — NS multi-subsidiary import arc (shipped 2026-06-06)
> The headline 2026-06-06 build. Closes the "drop in a real OneWorld export → consolidated TB with IC eliminations" demo. Four PRs stacked end-to-end.

- [x] **Phase 1 — design + pure mapper + orchestrator** (PR #138)
  - `docs/netsuite-multi-subsidiary-design.md` — discriminator type `EntityResolution = {mode: "single", entityCode} | {mode: "multi", entityCodePrefix}`, two-pass orchestrator pattern, backward-compat input shape
  - `src/lib/mappers/netsuite/subsidiaries.ts` — `mapSubsidiary` pure mapper, `setupSubsidiaries` two-pass upsert + parent wiring, `resolveEntityCode` derivation, `resolveEntityResolution` backward-compat fold
  - 15 unit tests pass
- [x] **Phase 2 — fixture + integration tests + chart-of-accounts decision** (PR #139)
  - `prisma/fixtures/netsuite-multi-sub.json` — Vandelay Industries parent + USD USA + GBP UK with cross-currency UK invoice
  - 6 integration tests against real Postgres
  - Chart-of-accounts Option A locked: NS accounts on the global chart (`Account.entityId: null`) shared across all subs; matches NS's "one chart, many subs" reality
- [x] **Phase 3 — orchestrator wiring + per-tx routing** (PR #140)
  - `import.ts` gains `entityResolution?` + `setupSubsidiaries` first-step + `subsidiaryEntityCodeByInternalid` map + `resolveEntityCodeForTransaction(subsidiaryInternalid, txKind, txId)` helper
  - 7 per-tx call sites route by NS `subsidiary` field
  - Backward compat preserved: 13/13 v0.6 single-sub tests still green
  - 5 new e2e tests pass (3-sub fixture → routing + cross-currency)
- [x] **Phase 4 — reverse exporter + roundtrip proof** (PR #141)
  - `subsidiaries.ts` preserves frozen `NsSubsidiary` in `LegalEntity.extensions.nsSourcePayload` (matches Account/Party/Item/JE lineage-replay)
  - `export.ts` gains multi-mode: discovers entities by `extensions.nsIsImported`, reconstructs Subsidiary array, scopes master rows by `entityId: null`, JEs across all sub entities
  - 2 new roundtrip tests: `diffNsExports = null` (byte-equivalence) + export idempotency
  - **41/41 total NS tests pass** (15 + 6 + 5 + 2 + 13 v0.6 regression)
- [x] **Demo script** (PR #142) — `pnpm demo:ns-multi-sub` imports the fixture, prints the hierarchy + bucket counts, hands the operator a URL into `/reports/consolidation`. Idempotent.
- [x] **UI page + Server Action** (PR #143)
  - `/import/netsuite` with Single/Multi-sub mode toggle, file-upload-to-textarea, prefix input
  - `importNsAction` Server Action: requireAdmin + requireCurrentTenant gated, 10 MB cap, ASCII-only regex validation server-side (defense-in-depth — client validates too)
  - Generic catch-all error message (no internal leak) + audit log on every path (ACCESS_DENIED / PRIVILEGED_ACTION / DATA_EXPORT / SECURITY_EVENT)
  - 13/13 validation tests pass (6 baseline + 7 adversarial — spaces, path traversal, SQL chars, length overflow, Cyrillic homoglyph, null byte, shell metacharacters)
- [x] **Multi-currency disclosure banner** (PR #144) — `ConsolidationReport` now exposes `hasMultiCurrency` + `distinctCurrencies`. Page surfaces a warning banner when entities use mismatched functional currencies, explaining the consolidated totals are NOT FX-translated. Closes the CPA-credibility gap before the full ASC 830 arc lands.

### v0.8 — ASC 830 FX translation arc (shipped 2026-06-08)
> The arc that replaces the v0.7 disclosure banner with accurate translation. Five core architectural phases + UI polish; 7 PRs in the FX series alone.

- [x] **Phase 1 + 1.5: helper + Northwind seed + importer wiring** (PR #146)
  - `src/lib/accounting/fx.ts` — `getFxRateOrDefault` helper. Same-currency short-circuits to 1 without DB hit. Cross-currency does most-recent-on-or-before lookup. Throws `FxRateNotSeededError` on miss (operator-actionable message).
  - Northwind seed gains 4 baseline FxRate rows (GBP↔USD @ 1.27/0.7874, EUR↔USD @ 1.05/0.9524).
  - NS importer plumbs `fxRate` + `transactionAmount` + `transactionCurrencyId` through to `postJournalEntry` for all 5 callsites (JE, Invoice, VendorBill, CustomerPayment, VendorPayment). Same-currency case short-circuits.
  - 5 unit tests pass.
- [x] **Phase 2: NS exchangerate precedence** (PR #147)
  - NS transaction types extended with optional `exchangerate?: number | string`.
  - `convertLinesForFx` resolution order: same-currency → 1; NS `exchangerate` present → use it; else `getFxRateOrDefault`.
  - `fxRateSource` enum surfaced for tests + audit telemetry.
  - 2 tests prove the precedence (1.50 NS override beats 1.20 seed; fallback works).
- [x] **Phase 3: realized FX gain/loss on AR/AP** (PR #148)
  - Chart-of-accounts gains 8300 "Realized FX Gain/Loss" (subtype FX_GAIN_LOSS, normal balance DEBIT).
  - `ensureFxGainLossAccount(entityIdForCreate)` idempotently creates 8300 in the right scope (global chart in multi-sub mode, named entity in single mode) at orchestrator start.
  - `injectFxGainLossAdjustment({lines, paymentFxRate, side, applications})`: for each application, looks up original-invoice fxRate from `openedByEntry`, computes delta × applied amount, accumulates. Adjusts the AR/AP control line + injects a balancing FX_GAIN_LOSS line.
  - CustomerPayment + VendorPayment paths call the helper. Same-currency case is a no-op.
  - 2 tests: gain (CC payment at higher rate than invoice) + loss (VP payment at higher rate than bill).
- [x] **Phase 4a: translationCategory schema** (PR #149)
  - Prisma migration 0008 adds `TranslationCategory` enum (CURRENT_RATE / HISTORICAL / WEIGHTED_AVG / EXCLUDED) + `Account.translationCategory` nullable column.
  - Backfill: ASSET/LIABILITY → CURRENT_RATE; EQUITY → HISTORICAL; REVENUE/EXPENSE → WEIGHTED_AVG; FX_GAIN_LOSS subtype override → EXCLUDED.
  - `defaultTranslationCategory({type, subtype})` pure helper used by seed paths so new accounts get sensible defaults.
  - 9 tests: pure-logic cases + dev DB backfill invariants.
- [x] **Phase 4b: getTranslationRate per ASC 830 category** (PR #150)
  - `getTranslationRate({category, ctx})` → `{rate, source}`. Same-currency → 1 regardless of category; EXCLUDED → 1; HISTORICAL → null (caller walks lines); CURRENT_RATE → rate at periodEnd; WEIGHTED_AVG → mean of (start, end) rates.
  - `TranslationContext` type: `{fromCurrencyId, toCurrencyId, periodStart, periodEnd}`.
  - 8 tests covering each branch + sparse-rate behavior + error bubbling.
- [x] **Phase 4c: consolidation translation + CTA** (PR #151)
  - `getConsolidatedTrialBalance` gains optional `periodStart`. When set + entities have mixed currencies → translation runs. When omitted → v1.0 naïve-sum (backward compat).
  - `ConsolidationReport` gains `translationActive: boolean`, `translationRateByEntity: Record<code, string | null>`, `cumulativeTranslationAdjustment: Decimal`.
  - Per-entity rate cache; HISTORICAL passes through untranslated (CTA catches imbalance).
  - **CTA** = post-elim debit − credit total. Positive = FX loss (equity decrease), negative = FX gain (equity increase). The plug is added on the appropriate side so the consolidated TB balances.
  - 4 tests including the CPA-grade scenario (Cash 1200 × 1.30 CR = 1560; Equity 1200 untranslated HR; CTA = 360 USD credit; TB balances after CTA).
- [x] **Phase 5: page wires periodStart + replaces banner** (PR #152)
  - `/reports/consolidation` page now accepts `?periodStart=` (defaults to `asOf - 3 months, day 1` so legacy bookmarks still get translation).
  - Form gains a "Period start" date input alongside "As of."
  - Disclosure banner replaced with two modes: positive-tone "FX translation active" (showing per-entity CR rates inline + CTA amount + sign interpretation) when active; warning banner only when operator explicitly skipped periodStart.
  - End-to-end live verification on VANDEMO_NS1: translationActive=true, NS3 GBP @ 1.30, consolidated DR 299,060 = CR 299,060 balanced.

### v0.9 — NS Accounting Books arc (shipped 2026-06-08)
> The 3rd NS architectural axis after multi-sub (v0.7) and FX translation (v0.8). Real OneWorld tenants carry multiple books per company (US_GAAP / US_TAX / IFRS / MGMT); each book is an independent GL view. ledger-core's Pattern 2 multi-book substrate already supported this — the importer just needed to drive it from NS data.

- [x] **Phase 1: design + types + mapper + setupBooks** (PR #154)
  - `docs/netsuite-accounting-books-design.md` — 5-phase arc designed. Open questions resolved: lineage unique index scope (verified before Phase 2), adjustment-only books (defer to phase 4+), per-book currency divergence (defer).
  - `NsAccountingBook` + `NsBookSpecific` types in `src/lib/mappers/netsuite/types.ts`.
  - `NsExport.AccountingBook?: NsAccountingBook[]`.
  - `src/lib/mappers/netsuite/books.ts` — `BookResolution` discriminator (mirror of `EntityResolution`), `resolveBookCodes`, `BookNotMappedError`, `mapNsBook`, `setupBooks`, `resolveBookResolution` (backward-compat fold).
  - `setupBooks` validates every NS book maps to an existing ledger-core Book row. Doesn't create Book rows itself — Book metadata is operator-configurable.
  - 19 unit tests (5 `resolveBookCodes` + 4 `resolveBookResolution` + 3 `mapNsBook` + 7 `setupBooks` integration).
- [x] **Phase 2: lineage-uniq scoped to (tenantId, bookId)** (PR #155)
  - Migration 0009 drops the old global `gl_entry_header_lineage_uniq` and re-creates it scoped to `(tenantId, bookId, sourceSystem, sourceRecordType, sourceRecordId)`.
  - Fixes TWO defects: (1) the multi-tenant collision bug where tenant A importing NS Invoice 10001 blocked tenant B from doing the same; (2) the multi-book blocker where a second per-book post on the same NS source record hit the unique.
  - 3 integration tests prove cross-book posts succeed, same-book duplicates throw, normal records pass through.
- [x] **Phase 3: per-transaction routing through importer** (PR #156)
  - `ImportFromNsInput.bookResolution?` — single mode (backward compat) or multi mode (NS internalid → ledger-core book code mapping).
  - At orchestrator top: `resolveBookResolution` + `setupBooks` validate the mapping.
  - JournalEntry path: `for (const perBookCode of journalEntryBookCodes)` loop posts to each distinct mapped book. Pattern 2 multi-book driven by NS data.
  - 4 sub-ledger paths (Invoice/VendorBill/CustomerPayment/VendorPayment) swap `bookCode` → `primaryBookCode` (first mapped book in multi mode). Sub-ledger multi-book is Phase 3.5+.
  - `attachDimensionSets` called once after the loop (operates by (sourceRecordId, lineNo) across all per-book JE rows).
  - 2 routing tests: 2 NS JEs × 2 books = 4 ledger-core JEs; idempotent re-import.
  - 17/17 v0.7+v0.8 regression preserved.

### v1.2+ — ergonomics + polish (deferred)
- [ ] Keyboard shortcut for "+ Add line" (Tab from last cell)
- [ ] Recurring journal entry templates
- [ ] AR / AP aging with sortable columns
- [ ] **HISTORICAL category line-walking** — currently passes through untranslated (CTA catches the imbalance). A more sophisticated implementation walks `line.entry.fxRate` per equity line. Mostly cosmetic for the v0.8 demo since NS-imported data rarely has equity transactions.
- [ ] **NS Books Phase 3.5+** — sub-ledger multi-book (Invoice/Bill/Payment per-book) + per-tx `bookspecific[]` exchangerate + per-book idempotency check
- [ ] **NS Books Phase 4** — reverse exporter reconstructs `bookspecific[]` for roundtrip proof
- [ ] **NS Books Phase 5** — UI book-mapping editor on `/import/netsuite`
- [ ] `isEliminationEntity` column migration (currently flagged via `extensions.nsIsElimination`)
- [ ] **NS SuiteAnalytics → report endpoints** — proves the lineage layer roundtrip works for derived reports, not just transactional data

---

## Open decisions

- **PostingRule template schema** — v0.4 ships a minimal `$.path` DSL. Resolved at the level needed for the seed; an expression sublanguage with arithmetic (`$.a + $.b * 0.1`) is a v0.5 candidate when QBO/NetSuite mapping needs it.
- **Cash flow statement** — deferred. Indirect method is the lift; direct method is non-trivial too. Probably v0.6.
- **Audit log with hash chaining** — out of scope until a real customer asks for it. The `JournalEntry.status = REVERSED` + immutability rule covers GAAP-level audit trail.
- **Auth** — still nothing. Portfolio demo gates discussion until UI lands.
- **Demo data reset** — once live demo is up, decide whether to reset to clean Northwind nightly so random visitors can't mess up the public demo.

---

## Decision log

- **2026-05-21** — Rebrand: `mini-ledger` → `ledger-core`. Repo rename in place; old URL auto-redirects. Reframes the project from "tiny correct ledger" to "universal substrate."
- **2026-05-21** — Locked: US + IFRS only (no per-country statutory); own sub-ledgers natively; QBO-floor, NetSuite-ceiling.
- **2026-05-21** — Locked: multi-book Pattern 2 (full parallel posting). Pattern 1 (derive other books from a primary) rejected.
- **2026-05-21** — Surrogate keys are UUIDs (`gen_random_uuid()`), not cuid. Currency PK is the ISO 4217 code (stable across systems).
- **2026-05-21** — v0.3 sub-ledger expansion: AR/AP open items are keyed per (entity, book). Cash-basis tax customers need per-book open-item lifecycles even when GAAP and TAX are usually identical.
- **2026-05-21** — Revenue recognition math: month-based, not day-based. Day-based drifts by pennies per period and breaks clean BTD demos.
- **2026-05-21** — Posting-rules engine DSL is intentionally minimal: `$.path` lookups + `${$.path}` interpolation. Arithmetic and conditionals are OUT. If a rule needs them, author it in TS directly. The rules engine exists to make ERP-event → GL mapping declarative + auditable, not to be a general-purpose computation language.
- **2026-05-21** — Bad debt write-off shipped with both methods. DIRECT remains the default for simplicity; ALLOWANCE is opt-in via `method: "ALLOWANCE"` and pairs with `estimateBadDebtAllowance` for full GAAP-conforming flow. Initial v0.4 plan was DIRECT-only; promoted ALLOWANCE forward in v0.5 because the schema (account 1210) was already wired.
- **2026-05-21** — QBO Account codes get the `Q` prefix in `code` to avoid colliding with the native chart (`1000`, `2000`, …). Original QBO Id is preserved in `sourceRecordId` for roundtrip integrity. Unified-chart imports (mapping QBO → native codes) are a manual reclassification step, not part of the automatic mapper.
- **2026-05-21** — `exportToQbo` is a lineage-replay function: it reads `sourcePayload` and reconstructs the export. No re-translation from ledger-core data because the original payload is preserved verbatim. This is the practical demonstration of why Layer 6 lineage requires the frozen raw payload (not just IDs).
- **2026-05-21** — NS dimension engine: dedup happens at the line scope via stable hash of sorted `(dimensionCode, valueCode)` pairs. The hash is the dedup key on `DimensionSet`, so two lines with identical assignments share one row. Hashing is plain string concatenation (`dim1:val1|dim2:val2|...`) not crypto — collision risk is essentially zero at our scale and the strings remain human-readable for debugging.
- **2026-05-21** — NS custom segments map to `Dimension` rows keyed by the uppercased internalid (`custcol_region` → `CUSTCOL_REGION`). Same engine handles built-in (CLASS/DEPARTMENT/LOCATION) and custom dimensions uniformly — no fixed columns, no schema migration needed when an NS tenant adds a 9th custom segment.
- **2026-05-21** — `dimensionSetId` is attached to `JournalLine` rows via a post-write update (`attachDimensionSets`) because `postJournalEntry` doesn't accept it in its input shape. Adding `dimensionSetId` to the input is a v0.7 enhancement; until then the NS orchestrator owns this small denormalization.
- **2026-05-21** — UI is read-only in v0.7. The manual journal-entry form needs a real-time debit/credit balance indicator + client-side reactivity, which warrants its own batch with proper interactive testing. Shipping the read-only surface first means the live demo is useful immediately for recruiters who just want to click around.
- **2026-05-21** — Multi-book / multi-entity switcher uses a single `lc-scope` cookie + a Server Action (`setScopeAction`) + `revalidatePath`. No client state, no URL params for scope — the cookie persists across sessions; URL params are reserved for report-specific filters (date ranges, book pairings on the BTD page).
- **2026-05-21** — Inlined UI primitives (Card/Table/Button/Badge/Input) instead of running the shadcn CLI. Trade-off: less polish, but the bundle stays tiny, the components are auditable, and there's no interactive setup step blocking `pnpm install`.
- **2026-05-21** — The new-entry form serializes its dynamic lines array to a single hidden `linesJson` input on every keystroke. Alternative was `name="lines[0][accountCode]"` style FormData, which requires more parsing logic in the Server Action and doesn't survive `FormData.getAll` ordering. JSON serialization is one line in the client, one parse in the action — net simpler.
- **2026-05-21** — `POST /api/admin/reset` fails closed when `ADMIN_TOKEN` is unset (503, not 401). Reasoning: a 401 implies the endpoint is operational but the token is wrong; 503 communicates "this endpoint is intentionally disabled in this deployment." Helps debug a missing env var faster.
- **2026-05-21** — Seed extracted to `src/lib/seed/northwind.ts` with `prisma` passed as a parameter. The script wrapper at `prisma/seed.ts` is the same shape as before — just 30 lines instead of 670. The reset endpoint imports the same module so there's exactly one Northwind definition.
- **2026-05-21** — Cash flow classification uses subtype-driven heuristics, not hard-coded account codes, so QBO/NS-imported charts work without code changes. The `uncategorized` panel is the safety net — any BS change the heuristic can't place surfaces in the UI with a note pointing at `src/lib/accounting/reports/cash-flow.ts` for the fix. Trade-off: classification is best-effort, not authoritative.
- **2026-05-21** — Decided NOT to add a `cashFlowCategory` enum column to `Account`. Reason: would either be redundant with `subtype` (which already drives this) or would require constant tuning per ERP import. Heuristic on `subtype + type + isBank` covers ~95% of normal accounts; the `uncategorized` panel handles the long tail explicitly.
- **2026-05-21** — Cash flow tests use controlled fixtures (capital infusion only / all-AR no collection / capex + sale / depreciation add-back) rather than the full Northwind seed because Northwind has the ASC 842 lease complications. The fixtures isolate one mechanic at a time and assert `reconciles === true` on each.

---

## Notes for the next session

- Architecture canon: `docs/universal-schema.md`. Schema visual: `docs/schema-erd.md`. Both are kept in sync with the actual schema.
- Headline test command: `pnpm test` (runs invariants + sub-ledgers + seeded-company suites). Tests need a live Postgres at `DATABASE_URL`.
- Seed data dependencies: `pnpm db:push && pnpm db:seed` in that order. The seed expects a freshly pushed schema; reset with `pnpm db:reset`.
- The posting-rules engine is the v0.4 unlock. Once that lands, the seed can stop hardcoding `postToBooks([...])` and let the rules table drive divergence.
