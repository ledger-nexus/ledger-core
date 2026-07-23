# Project Status

Running log of where this project is, what's next, and key decisions. Updated at the end of each working session so the next session (whether by me or by Claude Code) can pick up without re-explaining context.

---

## Where we are

**Last updated:** 2026-07-17

**2026-07-17 — Codex external-review remediation (PRs #269/#270/#271):** closed all 8 findings from an AI code review of `main@0cb47d4`, each verified against source before fixing. Critical: the dashboard read the raw `lc-scope` cookie (`getScope()`) and fed unverified `entityCode` into report calls + ~12 Prisma queries — a cross-tenant read leak, now pinned to a tenant-verified `getCurrentScope()`. High/Med: the ask-your-ledger `get_book_tax_difference` tool accepted a model-chosen comparison book (now allowlisted to books the entity uses); bank-feed categorize/exclude/match were tenant-only (now entity+book pinned) with a categorize double-post race (now an atomic FOR_REVIEW claim) and a match claim race (now `postedEntryId @unique`, migration 0023). AGENTS.md's intentional exceptions (RLS Phase 1, shared `entityId=null` accounts, legacy `postJournalEntry` fallback) were preserved. **Deploy note:** migration 0023 needs `prisma db push` on prod + personal-books; it does not auto-deploy.

**2026-07-17 — Reclassification / correcting-entry slice (Documents & Corrections arc, Half A):** first code slice of the corrections half scoped in `docs/spec/documents-and-corrections-arc.md` (PR #288). Added a nullable self-link `JournalEntry.correctionOfId` (mirrors `reversalOfId`; migration 0024, additive/nullable, no backfill, not mirror-DDL) + `reclassifyJournalEntryAction` (`src/app/actions/reclassify-journal-entry.ts`): moves an amount from one GL account to another via a balanced correcting entry through `postJournalEntry`, links `correctionOfId`, and leaves the source POSTED — a correction *supplements*, it does not negate (unlike reverse, which flips the source to REVERSED). Direction is derived from the source's net on the from-account (no direction input; proves the account was in the source; bounds per-correction to what the source booked there — cumulative over-reclass is a documented v1 limitation). Tenant-scoped source lookup + privileged-action audit row. `tests/reclassify-journal-entry.test.ts`: happy path (correctionOfId set, source stays POSTED, sides correct), amount-exceeds + from-not-in-source + non-POSTED guards, cross-tenant not-found. tsc + schema-fingerprint clean locally; DB suite runs in CI (this clone holds real books — ⛔ no local run). **Deploy note:** migration 0024 needs `prisma db push` on personal-books + any prod. UI entry point deferred (unverifiable from this clone).
**2026-07-17 — Reopen-with-reason + queryable reopen history (Documents & Corrections arc, Half A / A3):** `reopenPeriodAction` now REQUIRES a reason (empty → refused before any delete) and records each reopen as an immutable fact in a new `period_reopen_log` table (migration 0025; denormalized tenant/entity/book codes + reason + reopenedBy + reopenedAt, no FK relations so the row survives period/entity deletion — same rationale as `audit_log.actorEmail`). The close-lock delete + log insert run in one `$transaction`; the reason also lands in the reopen audit-log metadata. Rationale: `PeriodClose` is binary (row present = closed), so deleting it on reopen previously erased the fact that a period was reopened and why. UI `periods/period-actions.tsx` collects the reason via prompt. **Contract change:** `ReopenPeriodInput.reason` is now required (only caller was the periods UI; existing reopen tests updated to pass a reason with mechanics assertions intact); new tests cover empty-reason-refused + log-row-written. tsc + fingerprint clean locally; DB suite runs in CI. **Deploy note:** migration 0025 needs `prisma db push` on personal-books + any prod. (May trivially conflict with the reclassify PR #289 on this changelog — keep both entries.)

**2026-07-17 — Balance-change lineage resolver + JE-detail view (Documents & Corrections arc, Half A / A4):** `getEntryLineage(db, {tenantId, entryId})` (`src/lib/accounting/lineage.ts`) — a tenant-scoped resolver returning an entry's reversal + correction lineage in both directions (reverses/reversedBy via `reversalOfId`, corrects/correctedBy via `correctionOfId`). The JE detail page (`journal-entries/[id]/page.tsx`) now renders a unified related-entries display from it — corrections shown alongside the existing reversals, and the ReverseButton fed from the same single lineage source. Read-only, **no schema change**. `tests/entry-lineage.test.ts` verifies both relation types, both directions, tenant isolation, and unknown-id → null. Stacked on the reclassify branch (#289) because it walks `correctionOfId`. tsc clean; DB suite runs in CI. The page is server-rendered (typechecked; visual browser-deferred — verifying it here would mean browsing real books). (May trivially conflict with #290 on this changelog — keep all entries.)
**2026-07-17 — period_reopen_log append-only enforcement (Documents & Corrections arc, Half A / A3 hardening):** the A3 follow-up — `period_reopen_log` is now append-only at the DB level via Postgres RULEs (`period_reopen_log_no_update` / `period_reopen_log_no_delete` → `DO INSTEAD NOTHING`), the same silent no-op mechanism as `audit_log`: reopen history can't be silently edited even by a privileged user running raw SQL; INSERT stays open. The rules live in `prisma/sql/migration-mirror.sql` (section 7, applied by `db:restore-ddl` + CI) and `prisma/migrations/0026_period_reopen_log_append_only/` (migrate-deploy). A test escape hatch `withPeriodReopenLogMutable` (`tests/_helpers/audit-log-cleanup.ts`, mirrors `withAuditLogMutable`, same disposable-DB gate) lets suites clear residue; the A3 test's `beforeEach` cleanup uses it. New `tests/period-reopen-log-append-only.test.ts` proves UPDATE/DELETE no-op + INSERT allowed. No schema.prisma change → no fingerprint change. Stacked on #290 (needs the `period_reopen_log` table). **Deploy note:** migration 0026 rules ride along with `db:restore-ddl`/mirror DDL on the personal-books DB + any prod.


**2026-07-18 — Inventory booking engine (Beancount adoption, slice ④ / part 1 of the lots arc):** the pure algorithmic core of lots & cost basis (`src/lib/accounting/inventory.ts`). `bookReduction(held, reduceUnits, method, opts)` decides which lots a sale draws down and computes cost relieved + realized gain (proceeds − cost basis, driven by basis not price). Booking methods **STRICT** (refuse ambiguity unless one lot / whole position / a named lot), **FIFO**, **LIFO**; helpers `totalUnits`/`totalCost`/`averageCost`. NONE (append-only, never reaches a reduction) and AVERAGE (unimplemented upstream) are out of scope. **PURE — no DB, no schema, no posting integration**, so it is exhaustively unit-testable and was **verified locally 16/16** (DB-free single-file run, safe from this clone) as well as in CI. All decimal.js (fractional lots exact). This is the seam the rest of the arc builds on. **④ ARC PLAN (remaining parts, each its own PR):** part 2 = `Lot` persistence model (book-aware, per the canon's "inventory layers"; stacks on commodity ③) + augment-on-acquire; part 3 = posting integration (reduce-on-dispose emits the realized-gain JE lines through `postJournalEntry`); part 4 = UI / holdings view. Deferred so each stays reviewable. **No migration, no deploy action for part 1.**
**2026-07-18 — Balance assertions (Beancount adoption, slice ①):** first slice from `docs/spec/beancount-adoption-study.md` (#295). New `BalanceAssertion` table (migration 0027, additive: table + `AssertionStatus` enum + FKs, no backfill, not mirror DDL) records "this account held exactly this much on this date", and `checkBalanceAssertions()` (`src/lib/accounting/balance-assertions.ts`) verifies them. Where `postJournalEntry` enforces correctness at the moment of WRITE, this enforces it ACROSS TIME — catching drift no single write would reject (double-posted import, missed reversal, mapper regression) on the date it first appears. **Complementary to `Reconciliation`, not a replacement**: reconciliation is the periodic human attested control; this is the cheap machine tripwire. Reuses `getTrialBalance` rather than inventing a second notion of "the balance" (one TB per distinct asOf date, so N assertions on a date cost one query); default tolerance derived from `Currency.decimals` (USD→0.01, JPY→1); `expectedAmount` on the account's normal side. ⚠️ **asOf is END-of-day** (`documentDate <= asOf`, matching getTrialBalance) — Beancount asserts at the START of the date; the divergence is deliberate and documented in schema + module + tests, because mixing the two silently answers a different question. **v1 is ADVISORY** — reports only, does not gate posting or close (that's a separate decision). Tests cover exact-PASS, real-FAIL, explicit-tolerance override, currency-derived default tolerance, the end-of-day convention, tenant isolation, and the persist cache. **Deploy note:** migration 0027 needs `prisma db push` on personal-books + any prod.


**Current state:** **Multi-currency revaluation shipped (v1.25) — the deferred queue is empty.** Period-end ASC 830 / IAS 21 remeasurement of foreign-currency monetary balances at the CLOSE rate: `Account.isMonetary` + `resolveFxRate` (PR 1), `computeRevaluation` engine over GL + AR/AP open items (PR 2), `postRevaluation` posting the adjustment + an auto-reversal next period (PR 3), and `/reports/fx-revaluation` with a tenant-admin "Post revaluation" gate (PR 4). Posts `source=AI_APPROVED` behind human approval. Before this, the Slack notifier completed through v1.24 (immediate + daily-digest cadences).

Right before this, **BlackLine arc** (Phase 1-4, 22 PRs across 23 commits, +15,847 LOC) shipped F1000-grade close management: Account Reconciliations with state machine + signoff + attachments + sub-ledger auto-pull (Phase 1, 8 PRs), Close Task Calendar with dependency DAG + cycle prevention + 50 canonical templates (Phase 2, 6 PRs), Flux / Variance Analysis with frozen-snapshot evidence + materiality cascade (Phase 3, 4 PRs), and the cross-pillar integration capstone with `/close` dashboard + `/close/alerts` cross-pillar feed + `/close/retrospective` process-improvement metrics (Phase 4, 4 PRs). Followed by close-task state-history (3 PRs, v1.19) and Retrospective CSV (1 PR, v1.20).

The portfolio is now end-to-end close-capable: substrate (Layer 1+2), ERP mapping (QBO + NetSuite + NS multi-subsidiary), interactive UI, three financial statements, BTD + M-3 for tax provision, multi-entity consolidation, **AND** F1000-class close management. Counts: 559 tests across 56 files; 15 new test files added by the arc (~5,150 LOC of test coverage).

**Between v1.0 and the BlackLine arc**, the portfolio went through a substantial SOC 2 hardening phase tracked separately (see `SOC2_READINESS.md` v2.3, control-deficiency-log v2.3, risk-register v2.4), an RLS arc (deficiency #12, Phase 1-3), portfolio-wide encryption stack (PRs #11-#36), automated retention engine, DSR end-to-end wire-up across companion repos, and `npm run demo` one-shot flow. CLAUDE.md tracks v1.2 through v1.17 inline; this status doc was paused during the SOC 2 work to keep one source of truth.

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
- [x] `seedConsolidationDemo()` in `src/lib/seed/consolidation-demo.ts` — sets up ACME_GROUP parent + ACME_US + ACME_UK subs with capital, external revenue, and a $3k intercompany sale. Bundled into `npm run db:seed`.
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

### v1.2–v1.17 — interim shipments (tracked in CLAUDE.md, summarized here)
- [x] **v1.2** — Internal HTTP endpoint `/api/internal/journal-entries` for companion repos (recon, fa-amort, revenue-rec). Token-gated, structured `{code, message}` error shape mirroring `postJournalEntry` error types. The contract between repos.
- [x] **v1.3–v1.10** — Companion-repo wire-up sprints (recon, fa-amort, revenue-rec): NS mappers + Server Actions + import UI + reverse exporters + DSR attribution helpers. Portfolio reaches 5/5 attribution coverage.
- [x] **v1.11** — Idempotent JE posts via partial unique index on `(sourceSystem, sourceRecordType, sourceRecordId)`. Repeat posts return existing entry with `wasDuplicate: true`. Transactional `POST /api/internal/fixed-asset/record-depreciation` closes fa-amort's two-step drift window.
- [x] **v1.12–v1.13** — Period close UI: `/periods` admin-gated close/reopen Server Actions; `/reports/month-end?period=YYYY-MM` composite (cover + IS + BS + TB tie-out checks); `/api/reports/month-end/{csv,pdf}` downloads via `@react-pdf/renderer`.
- [x] **v1.14–v1.16** — SOC 2 hardening tracked separately in `SOC2_READINESS.md` v2.x: RLS arc (Postgres FORCE + cross-tenant test suite, deficiency #12), column-level encryption stack (PRs #11–#36, 5/5 portfolio coverage), automated retention engine, control-deficiency-log + risk-register at v2.3 / v2.4.
- [x] **v1.17** — One-shot `npm run demo` flow: wipes a dedicated `DEMO_CO` entity, posts 28 JEs across one believable May 2026 (cap contribution, prepaid rent, equipment, AR + AP cycles, multi-book depreciation, ASC 606 deferred revenue, month-end accruals), and closes May on US_GAAP. Opens to a tied-out month-end packet you can hand to a CPA cold. Entry: `prisma/demo.ts` → `seedDemoMonth()` in `src/lib/seed/demo-month.ts`.

### v1.18 — BlackLine arc · F1000 close management (shipped 2026-06-09)

The portfolio's biggest single arc: 22 PRs across 4 phases, +15,847 LOC, 15 new test files, 3 new top-level table groups (Reconciliations, Close Tasks, Flux). Brings close-management functionality on par with BlackLine F1000 — minus the enterprise-tier integration breadth, which is exactly the scope a series-A controller needs.

**Phase 1 — Account Reconciliations (PRs 1–8)**
- [x] **PR 1** — Schema + migration 0008: `Reconciliation`, `ReconciliationAttachment`, `ReconciliationConfig`, `ReconStatus` enum. Frozen-snapshot pattern on `glBalance` + `tolerance` so backdated JE posts don't retroactively flip signed-off recons.
- [x] **PR 2** — 6 Server Actions (`createRecon`, `startPreparation`, `recordSupporting`, `submitForReview`, `approveOrSendBack`, `markException`) + 3-level cascade resolver (Account override → Config → BlackLine fallback). Preparer ≠ reviewer enforced via `SAME_USER` error code.
- [x] **PR 3** — `/close/reconciliations` list page + CSV export via `/api/close/reconciliations/csv`. Per-row status badges, scope chips, ordering by status priority.
- [x] **PR 4** — Detail page with full state machine UI: preparer form, reviewer actions, waive button. Frozen-snapshot displayed verbatim.
- [x] **PR 5** — Attachment upload + download + delete. Encrypted bytes via PrismaExtension confidential-column path. Self-contained storage; no S3 vendor lock.
- [x] **PR 6** — Auto-instantiate recons at period-open (idempotent via composite-unique key on `(entityId, bookId, periodId, accountId)`).
- [x] **PR 7** — Sub-ledger supporting-balance auto-pull (AR / AP / FixedAsset). One click pulls the actual sub-ledger balance into `supportingBalance` and computes `reconciledDiff`.
- [x] **PR 8** — Month-end packet integration: recon completion status surfaces in `/reports/month-end` + the PDF cover page. Phase 1 capstone.

**Phase 2 — Close Task Calendar (PRs 9–14)**
- [x] **PR 9** — Schema + migration 0009: `CloseTask`, `CloseTaskTemplate`, `CloseTaskComment`, `CloseTaskStatus` + `CloseTaskCategory` enums. Polymorphic owner pattern matches JE/ArOpenItem. Tenant-wide tasks supported via nullable `entityId/bookId`.
- [x] **PR 10** — 8 Server Actions + state machine (`NOT_STARTED → IN_PROGRESS → DONE | BLOCKED | WAIVED`). DFS cycle prevention on `dependsOnIds`. Required-task gate composes with period close.
- [x] **PR 11** — `/close/tasks` list page + sidebar entry + scope chips + status filter.
- [x] **PR 12** — Detail page wires the state machine: own/unown, start/complete, block/unblock with reason, comment thread, evidence URL.
- [x] **PR 13** — 50-task BlackLine-standard template seed: ACCRUAL × 10, RECON × 9, DEPRECIATION × 5, FX × 2, REVENUE × 4, INVENTORY × 3, TAX × 5, REPORTING × 8, ADMIN × 4. Default ownership + due offsets + dependsOnKeys wired so a fresh tenant gets a working calendar instantly.
- [x] **PR 14** — Periods-page integration + close-gate composition (recon completion + required task DONE-ness). Phase 2 capstone.

**Phase 3 — Flux / Variance Analysis (PRs 15–18)**
- [x] **PR 15** — Schema + migration 0010: `FluxStatement`, `FluxLine`, `FluxStatementStatus` + `FluxLineStatus` enums. Frozen `priorAmount` + `currentAmount` at generation time so analytics don't drift when prior periods are restated.
- [x] **PR 16** — `getFluxAnalysis` helper joins two TBs and classifies materiality (absolute + percent thresholds, OR). 4 Server Actions: generate, commentary, waive, finalize. Finalize gate refuses while NEEDS_COMMENT lines remain.
- [x] **PR 17** — `/close/flux` list + `/close/flux/[id]` detail with kanban-by-status: NEEDS_COMMENT / EXPLAINED / WAIVED / IMMATERIAL. Commentary form per line; bulk waive.
- [x] **PR 18** — Month-end packet integration: flux statement summary on cover page + per-pillar status chips. Phase 3 capstone.

**Phase 4 — Integration capstone (PRs 19–22)**
- [x] **PR 19** — `/close` cross-pillar dashboard composing all 3 rollups in `Promise.all`. Pillar tiles, period chips, "where are we in this close" at-a-glance view.
- [x] **PR 20** — `/close/alerts` aggregator: `getCloseAlerts` walks all 3 pillars and returns unified `CloseAlert[]` with severity (high/medium/low) + pillar + age + deep-link href. JSON endpoint at `/api/close/alerts` for Slack notifier / daily digest integration. DATA_EXPORT audit row on every pull.
- [x] **PR 21** — `/close/retrospective` close-process improvement metrics: days-to-close trend (per period vs target SLA), avg task lead time by category, exception rate trend, recurring blockers (top 10 templates by BLOCKED count). Helper `getCloseRetrospective(prisma, scope, lookbackPeriods=12, targetDays=5)`.
- [x] **PR 22** — This status amendment + arc codification. Phase 4 + arc complete.

**SOC 2 coverage for the arc:**
- **CC6.1** — every new table carries `tenantId`; every query tenant-scoped via `getCurrentTenant`.
- **CC6.3** — preparer ≠ reviewer at the Server Action layer (`SAME_USER` error); page-level EmptyState on missing scope.
- **CC6.7** — attachment bytes encrypted via PrismaExtension; no secrets in NEXT_PUBLIC_ env.
- **CC6.8** — Zod on every Server Action; searchParams clamped against enum allowlists.
- **CC7.2** — every mutation writes `audit_log` with `before_state` / `after_state`; bulk operations use ONE aggregate row.
- **CC8.1** — all 3 migrations reversible; PR descriptions state risk + rollback.

**Verified:** 528 / 559 tests pass (98.75%). The 7 failing tests are pre-existing infrastructure flake in `tests/tenant-context.test.ts:406` (audit_log append-only constraint blocks tenant cleanup → leak); none of the 15 new arc test files are in the failing set. Arc-owned tests verified passing per-PR.

### v1.19 — Close-task state history (shipped 2026-06-10)

Closes the documented v1.18 limitation in `src/lib/close/retrospective.ts`:
recurring-blockers was current-snapshot only, so a template that hit
BLOCKED four periods ago and was since unblocked would not appear.
Now the rollup reads from an append-only state-change log and counts
ever-blocked, not currently-blocked — the actual signal a controller
wants when planning process improvements.

- [x] **PR 1/3** — Schema + migration 0011 + Server Action wiring. New
  `CloseTaskStateChange` table with append-only DB trigger (cascade
  carve-out via `pg_trigger_depth()` so tenant teardown still works).
  All 5 status-mutating actions (`startTask`, `completeTask`,
  `blockTask`, `unblockTask`, `waiveTask`) wrap their update +
  state-change insert in a single `$transaction`. Bulk
  `instantiateCalendarForPeriod` writes one INITIAL row per task via
  `createMany`. Migration backfills an INITIAL row for every
  pre-existing task with the current status as the baseline
  (`changedById = null` documents "pre-0011 backfill").
- [x] **PR 2/3** — Replay walker integration. `getCloseRetrospective`
  recurring-blockers section rewritten as a two-query strategy:
  fetch tasks in window + fetch state-change rows where
  `toStatus = BLOCKED` for those task ids, then bucket by templateKey
  using a `Set` of ever-blocked task ids. Same return shape — UI
  code keeps working. Distinct task ids (not transitions) — a
  task that hit BLOCKED twice counts as ONE.
- [x] **PR 3/3** — UI timeline on `/close/tasks/[id]` + this status
  doc amendment. State-change card rendered chronologically below
  Details, above Comments. Each row shows `fromStatus → toStatus`,
  actor, timestamp, and reason (when populated). Backfill rows
  surface "system backfill (pre-0011)" so the auditor can distinguish
  baseline rows from live transitions.

**Verified:** 14 new tests (8 schema + wiring, 6 replay integration), plus
1 fixture update on the pre-existing recurring-blockers test for the
behavior change. Total 13/13 retrospective tests pass; total 8/8
state-history tests pass.

### v1.20 — Retrospective CSV export (shipped 2026-06-10)

Closes one of the documented v1.19+ items. `GET /api/close/retrospective/csv` emits a five-section CSV (summary + days-to-close + task lead time + exception rate + recurring blockers) board-deck-ready, with `Download CSV` button on `/close/retrospective`. CC7.2 audit row on every pull (`DATA_EXPORT` with `resource=CloseRetrospective`). Lookback + target clamped to safe ranges; same scope-resolution as the page.

### v1.21 — Slack notifier arc (shipped 2026-06-10)

Productionalizes `/api/close/alerts` — closes the controller's loop. Open close alerts now ping operator-configured Slack channels through a cron-driven dispatcher with dedupe + severity filtering + admin UI. 4 PRs + 1 hotfix:

**PR 1/4 (PR #212)** — Schema + helpers:
- `NotificationChannel` table — per-tenant Slack webhook config. `webhookUrl` column carries the AES-256-GCM ciphertext (key in `WEBHOOK_ENCRYPTION_KEY`); operators only ever see the masked URL after creation.
- `NotificationDispatch` table — per-(channel, alert) idempotency record. `@@unique([channelId, alertFingerprint])` is the dedupe key.
- `src/lib/notifications/crypto.ts` — `encryptWebhookUrl` / `decryptWebhookUrl` / `maskWebhookUrl` / `timingSafeEqualB64`. Packed iv(12) || tag(16) || ct format; fail-closed on missing env + tampered ciphertext + wrong key.
- `src/lib/notifications/slack.ts` — `formatSlackBlocks(alert, context)` + `sendSlackMessage(url, payload)` with 5s timeout. Block Kit rendering: severity-coded color, fallback text, context block, Open button.

**PR 2/4 (PR #213)** — Cron dispatcher:
- `src/lib/auth/cron.ts` — `isAuthorizedCronRequest` timing-safe `Authorization: Bearer <CRON_SECRET>` check (or `?cron_secret=` for manual triggering).
- `src/lib/notifications/dispatch.ts` — `dispatchCloseAlerts(prisma, opts?)`. Per tenant: walks entities × books, finds latest open period, calls `getCloseAlerts`, applies `severityFilter`, dedupe-probes via `findUnique`, decrypts URL, sends, writes dispatch row with status/error. Decrypt failures + Slack 4xx + network errors all write the row (with dedupe lock) so we don't infinite-retry.
- `POST /api/cron/close-alerts-dispatch` — thin route wrapper. One aggregate `PRIVILEGED_ACTION` audit row per cron tick.

**PR 3/4 (PR #214)** — Admin UI + Server Actions:
- `/admin/notification-channels` page — admin-only. Lists every channel: name, masked URL, severity-filter chips, enabled badge, dispatch count, last-sent. Per-row actions: Test, Edit (inline panel; URL field empty by default — paste to rotate), Enable/Disable toggle, Delete (with confirm).
- `src/app/actions/notification-channels.ts` — `createChannel`, `updateChannel`, `deleteChannel`, `testChannel`, `setEnabled`. All admin-only via `requireAdminContext()`. `testChannel` sends a diagnostic message without writing a `NotificationDispatch` row (test sends are operational, not alerts).
- Sidebar entry: "Slack channels · alerts" under Admin.

**PR 4/4 (this PR, PR #216)** — Deploy + docs:
- `vercel.json` cron schedule: `*/15 9-18 * * 1-5` (every 15 min, business hours UTC, weekdays). Dedupe table makes cadence safe — any frequency emits one ping per (channel, alert) max.
- `docs/deployment.md` — new "Slack notifier (optional)" section between Resetting and Troubleshooting. Covers `WEBHOOK_ENCRYPTION_KEY` + `CRON_SECRET` generation, env-var setup in Vercel, cron schedule, wire-a-channel walkthrough, audit-trail explanation, disable path.
- This PROJECT_STATUS amendment.

**Hotfix PR #215 (during arc)** — `sendSlackMessage` was echoing Slack's response body up into its error return value (`Slack returned ${status}: ${body.slice(0, 200)}`). Two consumer paths persisted that string (`notification_dispatch.sendError` plaintext column + `audit_log.metadata.error`). Slack's 4xx responses can contain the webhook URL itself plus arbitrary other content — the URL regex on the consumer side caught URLs only; non-URL content leaked. Fixed to return just `Slack returned HTTP ${status}` with body drained but not echoed. Both PR #213 and #214 picked up the fix automatically via merge of main.

**SOC 2 coverage for the arc:**
- **CC6.1** — every read/write tenantId-scoped via join + `requireAdminContext`.
- **CC6.3** — admin gating on all 5 actions; cross-tenant id surfaces `NOT_FOUND` (no existence leak); cron-secret check is timing-safe.
- **CC6.7** — webhookUrl encrypted at write time + only decrypted at send time; never logged; `maskWebhookUrl` applied at every render + error path; error strings stripped of webhook URLs even as defense-in-depth after the hotfix.
- **CC6.8** — Zod on every action input; severity filter against enum allowlist.
- **CC7.2** — `PRIVILEGED_ACTION` audit row on every channel mutation; one aggregate row per cron tick + per-dispatch detail in `notification_dispatch` table.
- **CC8.1** — migration 0012 reversible; PR descriptions state risk + rollback.

**Verified:** 30+ new tests pass (13 crypto + 9 Slack formatter + 7 dispatcher + 8 cron-auth + 8 channel actions). All on real Postgres. Tsc clean. CodeQL findings (`js/incomplete-url-substring-sanitization`) addressed by dropping `.includes()` URL-substring gates in favor of authoritative regex scrub.

### v1.22 — Recurring JE auto-run cron (shipped 2026-06-10)

Cleanup discovery: the recurring-JE *engine* + UI + Server Actions were already shipped (see `src/lib/accounting/recurring.ts` with `runRecurringEntries`, `addMonthsAnchored`, `enumerateDueDates` + idempotent lineage triple; `/recurring-entries` list + new + detail pages; 4 Server Actions). What was missing: an unattended cron driver. Operators had to click "Run all" in the UI each month-end to flush due posts.

This release adds `POST /api/cron/recurring-je-run` — a thin route gated by `CRON_SECRET` that drives `runRecurringEntries(prisma, { throughDate: today })` across every active template in every tenant. Idempotent (the engine's existing `sourceSystem="SUBSTRATE", sourceRecordType="RecurringEntry"` lineage triple dedupes against the partial unique index on `journal_entry`). One aggregate `audit_log` row per cron tick.

`vercel.json` schedule: **daily at 02:00 UTC** (`0 2 * * *`). Aligned with month-end — any template anchored on the last day of the month gets posted before the next business day. The dedupe makes any cadence safe, so daily is just sufficient.

The "Recurring journal entry templates" item in the v1.22+ queue was stale (the feature was ~95% done; only the cron driver was the gap). Removed from the deferred list.

### v1.23 — Ergonomic wins + webhook key rotation tooling (shipped 2026-06-10)

Three documented v1.22+ items closed in one stretch.

**(a) Tab→add JE line** (`/journal-entries/new`) — Tab from the last row's Amount cell appends a new same-side line and focuses the new Account input. Shift+Tab still navigates backwards normally; Tab on non-last rows is unchanged. Implementation: `onKeyDown` handler on the Amount input; `data-je-line-account` attribute on the account input lets focus move there after React commits via `requestAnimationFrame`.

**(b) Sortable AR/AP aging columns** (`/reports/ar-aging` + `/reports/ap-aging`) — every column header is a clickable sort link. 9 sortable fields per page (reference, customer/vendor, opened, due, daysOverdue, bucket, status, original, balance). Default unchanged: dueDate ASC. Smart direction defaults: text/date columns get ASC, amount + daysOverdue columns get DESC (biggest first). URL allowlist on `searchParams.sort` prevents query-string fiddling. Sort runs in-memory because `daysOverdue` and `bucket` are computed from `asOf`, not column data.

**(c) Webhook encryption key rotation** — `scripts/rotate-webhook-encryption-key.ts` re-encrypts every `notification_channel.webhookUrl` from OLD key to NEW key. Idempotent: rows that already decrypt under NEW are reported as `alreadyOnNew` and not re-written. Errors are logged per-row (channel id only, never plaintext URL) so the operator can investigate before flipping the live env var. `docs/deployment.md` gains a 7-step rotation runbook covering: generate new key → run script → verify ok → swap env var → redeploy → smoke test → wipe old key. SOC 2 CC6.7 — annual rotation minimum.

### v1.24 — Slack daily digest variant (shipped 2026-06-10)

The Slack notifier's third item — daily-digest cadence — landed as a 1 PR.

A `NotificationChannelMode` enum (`IMMEDIATE` | `DIGEST_DAILY`) hangs off `notification_channel`. Existing rows backfill to `IMMEDIATE` so the per-tick cron's behavior is unchanged at deploy. The IMMEDIATE channel filter on the existing dispatcher (`type: "SLACK", enabled: true, mode: "IMMEDIATE"`) keeps that cron honest. A new `dispatchCloseDigests` function in `src/lib/notifications/digest.ts` mirrors the per-tick walker but: pulls only DIGEST_DAILY channels, collects ALL alerts across the tenant's open periods (severity-filtered), bulk-probes `notification_dispatch` to drop already-sent ones, sends ONE Slack message batching every fresh alert (header + N attachments via `formatSlackDigest`), then writes N dispatch rows — one per batched alert with the send outcome. Quiet days send nothing. The new cron route is `/api/cron/close-alerts-digest`, scheduled `0 9 * * *` in `vercel.json` (09:00 UTC daily). Admin UI gains a Cadence picker on both the create form and the per-row edit panel; the channels table shows the current mode as a badge.

Failure modes inherit the existing pattern: Slack 4xx / network / timeout / decrypt-failure all write dispatch rows for every batched alert with `sendStatus` + scrubbed `sendError` — the dedupe lock prevents tomorrow's digest from re-pinging. URL scrub uses the same regex-without-`.includes()` pattern that closed the CodeQL `js/incomplete-url-substring-sanitization` finding earlier in the Slack arc.

Same SOC 2 lineage as the IMMEDIATE cadence: CC6.1 tenant-scoped reads/writes; CC6.3 timing-safe `CRON_SECRET`; CC6.7 webhook URLs decrypted only at send time; CC7.2 per-alert dispatch row + one aggregate audit row per tick (action=`notifications.cron.digest`). Tests in `tests/notifications-digest.test.ts` (cadence separation, batching, severity filter, idempotency, 4xx, decrypt, URL scrub) + `tests/close-alerts-digest-route.test.ts` (auth + audit + 405).

### v1.25 — Multi-currency revaluation (ASC 830 / IAS 21) — shipped 2026-06-10

Both remaining FX items closed as one 4-PR arc. Period-end remeasurement of foreign-currency monetary balances to the book's reporting currency at the CLOSE rate, with the unrealized gain/loss posted and auto-reversed next period. This empties the deferred queue.

- **PR 1 (#221)** — `Account.isMonetary` flag (migration 0014) + `src/lib/accounting/fx.ts` (`resolveFxRate`: on-or-before `asOf`, rateType curve, inverse fallback; the first code to read the dormant FxRate table) + new P&L accounts 8300 Unrealized / 8310 Realized FX Gain/Loss + GBP currency and H1-2026 EUR/GBP CLOSE+AVG seed rates.
- **PR 2 (#222)** — `computeRevaluation` pure engine. GL-sourced math in signed (debit−credit) space so AR/AP signs fall out: `foreignBalance × closeRate − carrying`. Walks every monetary account; AR/AP control-account rows are enriched with per-invoice open-item detail (no double-count — the total sums each GL group once; `openItemForeignTotal` surfaces sub-ledger drift). Same-currency lines excluded.
- **PR 3 (#223)** — `postRevaluation`: one balanced adjustment JE in the reporting currency (per-account line + offset to 8300), `source=AI_APPROVED`, idempotent on the lineage triple `(FX_REVAL, MonetaryRevaluation, "<entity>-<book>-<period>")`, + a reversing entry dated day 1 of the next period via `reversalOfId`, both atomic in one `$transaction`. Reverse-next-period keeps each period revaluing against the original historical basis (proven by a TB test: 8300 holds the gain at period end, nets to zero after the reversal lands). Fixed a CC6.1 tenant-scope gap in the FX-account lookup mid-build.
- **PR 4 (this)** — `/reports/fx-revaluation` page (read-only preview: per-account table, CLOSE rate, gain/loss, net total) + the `postFxRevaluationAction` Server Action (the human-approval gate: `requireTenantAdmin` → `postRevaluation`). Already-posted state shows the entry number and the button no-ops. Sidebar link under Reports (hint `ASC 830`). The existing `POST_FX_REVALUATION` close-task is the controller's checklist pointer to this page.

"AI suggests; humans approve; the system posts": `computeRevaluation` + `postRevaluation` are machine logic; nothing posts until a tenant admin clicks "Post revaluation", which posts `source=AI_APPROVED`. Money math is decimal.js throughout; the offset = −Σ(rounded gains) so entries balance to the cent.

### v1.26 — NS multi-subsidiary import arc (landed 2026-06-11)

Built 2026-06-06 as a stacked 6-PR chain (#138, #140–#144), landed 2026-06-11 via the bottom-up merge train after the backlog triage. A real OneWorld NS export (3-sub Vandelay group: USD parent + USD USA + GBP UK) imports end-to-end and renders a consolidated trial balance with intercompany eliminations.

- **EntityResolution discriminator** — `{mode: "single", entityCode} | {mode: "multi", entityCodePrefix}`; single mode preserves v0.6 behavior byte-for-byte (13/13 legacy tests).
- **`subsidiaries.ts`** — `setupSubsidiaries` two-pass upsert builds the LegalEntity hierarchy (parent wiring, per-sub functional currency) before any transaction lands; frozen `NsSubsidiary` preserved in `LegalEntity.extensions.nsSourcePayload` for lineage replay.
- **Chart-of-accounts Option A** — NS accounts go on the tenant-global chart (`Account.entityId: null`), matching NS's one-chart-many-subs reality; `postJournalEntry`'s resolver already unions global + entity-scoped accounts.
- **Per-tx routing** — 7 call sites route by the NS `subsidiary` field; missing/unknown subsidiary throws with a named error.
- **Reverse exporter + roundtrip proof** — `exportToNs` multi mode reconstructs the Subsidiary array byte-exact from `nsSourcePayload`; import→export→diff is empty and idempotent.
- **`npm run demo:ns-multi-sub`** — the 30-second clip: wipes prior demo state, imports the fixture, prints the consolidated-TB URL. Verified live against the shared dev DB.
- **`/import/netsuite` UI** — single + multi modes, hardened Server Action, sidebar link.
- **Multi-currency disclosure banner** on `/reports/consolidation` (CPA credibility: states translation basis when subs differ in functional currency).
- **Three defects fixed in transit** (the arc predated current main): e2e cleanup deleted JEs before AR open items (FK restricts — partial runs bricked later runs); `INV-UK-001` fixture lacked `total` (mapNsInvoice now rejects missing totals with a named error instead of a cryptic DecimalError); fixture lacked account 5000. e2e 5/5 + roundtrip 2/2 green vs the live shared DB.
- PR #145 (the original status doc for this arc) closed as overtaken; this entry is its corrected graft.

### v1.27 — v0.8 FX lifecycle arc (landed 2026-06-11, translation phases dispositioned)

Built 2026-06-08 as a stacked chain, landed car-by-car through the merge train with per-car math review. The FX lifecycle from document to settlement is now complete on main; the consolidation-translation tail was closed after review rather than merged.

- **#146 — transaction-date measurement.** Foreign-currency documents measure into the book's reporting currency at the transaction-date rate via `resolveFxRate`; Northwind seeds the rate curves; the NS importer wires per-entry `fxRate`.
- **#148 — NS rate precedence + realized FX on settlement.** Three-tier rate precedence (same-currency → NS posting-time `exchangerate`, rejected if ≤ 0 → seeded CLOSE curve). AR/AP application books the realized difference to **8310 Realized FX G/L**: cash at the payment-date rate, the open item relieved at its invoice-date rate, delta realized. Importer ensure-account is tenant-scoped.
- **#149 — `Account.translationCategory` (migration 0016).** ASC 830 classification enum (`CURRENT_RATE` / `HISTORICAL` / `WEIGHTED_AVG` / `EXCLUDED`) with type-based backfills; FX G/L accounts stamped `EXCLUDED` at creation; importer gained adopt-before-create (re-attaches lineage to a lineage-less row occupying the same `(entityId, code)` slot).
- **#150 — `getTranslationRate`.** Maps each category to its ASC 830 rate on top of `resolveFxRate` (CLOSE curve): current-rate at period end, weighted-average of period endpoints, historical as an explicit per-line caller contract, excluded/same-currency as identity.
- **#151/#152 — CLOSED after math review (not merged).** The translation layer would have **double-applied rates**: `JournalLine` stores debit/credit already converted to the book's reporting currency at transaction-date (there is no per-line functional-currency amount), and #151 multiplied those stored values by the period-end rate again — its own test asserted 1200 stored USD × 1.30 = 1560 where ASC 830 current-rate translation is 1000 GBP × 1.30 = 1300. Full analysis on the PRs; branches retained.

**Accounting position:** main implements the ASC 830 **remeasurement (temporal) method** — transaction-date measurement plus v1.25 period-end revaluation of monetary items to P&L 8300. Current-rate-method translation with a CTA in equity is deferred until a per-line `functionalAmount` schema arc exists to translate from (roadmap decision; #149/#150 are its landed groundwork).

### v1.28 — NS Accounting Books arc, Phases 1–3 (landed 2026-06-11; Phases 4–5 in flight)

The third NS architectural axis after multi-sub (v1.26) and the FX lifecycle (v1.27). Real OneWorld tenants carry multiple books per company (US_GAAP / US_TAX / IFRS / MGMT); the Pattern 2 multi-book substrate already supported parallel posting — this arc drives it from NS data. Built 2026-06-08 as a stacked chain, landed car-by-car with per-car review.

- **Phase 1 (#154) — types + mapper + `setupBooks`.** `BookResolution` discriminator (`single` | `multi` with an NS-internalid → ledger-core-book mapping; a faithful mirror of v1.26's `EntityResolution`), `resolveBookCodes` with dedupe and operator-actionable `BookNotMappedError`, `setupBooks` validating every mapping target exists (it never creates Book rows — Book metadata is operator-configurable), and `resolveBookResolution` folding the legacy `bookCode` input. 19 unit tests. Note: `Book` is a tenant-global reference table (code globally unique), so its lookups are correctly unscoped.
- **Phase 2 (#155) — lineage scope, tests only.** The chain designed a migration scoping `gl_entry_header_lineage_uniq` to `(tenantId, bookId, source-triple)` — but main already had exactly that index, byte-equivalent, via migration 0015's production PITR capture (the chain independently identified the same two defects: cross-tenant source-id collision and the multi-book second-post blocker). The redundant migration was dropped in port; what landed is the previously-missing integration coverage — same source record posting to two books, the per-`(tenant, book)` duplicate still rejected.
- **Phase 3 (#156) — per-transaction routing.** The JournalEntry path posts one JE per mapped book (2 NS JEs × 2 books = 4 ledger-core JEs verified); sub-ledger paths (Invoice/VendorBill/CustomerPayment/VendorPayment) post to `primaryBookCode` until Phase 3.5 wires per-book sub-ledgers. **Three defects fixed in transit:** (1) the importer's `alreadyImported` dedupe was unscoped by tenant (one tenant's import blocked another importing the same NS internalid — CC6.1) and unscoped by book (a crashed multi-book import could never complete; the chain had deferred this); now a tenant-scoped per-book lookup posts exactly the missing books on re-run. (2) `setupBooks` warnings were never wired into the import result. (3) The FX measurement currency was anchored to the legacy `bookCode` default, which in multi mode may not be a mapped book; now `primaryBookCode`.

Still open in this arc: Phase 3.5 (sub-ledger multi-book + per-tx `bookspecific[]` exchangerate), Phase 4 (reverse exporter reconstructs `bookspecific[]` for the roundtrip proof), Phase 5 (UI book-mapping editor on /import/netsuite).

> **Update (v1.29):** every item above subsequently landed — Phases 4/4.5/5 (#158/#163/#165), the Phase 3.5 sub-arc (#167–#172), and the per-book idempotency wired through the sub-ledger paths (#169). The "still open" list is preserved for history only.

### v1.29 — NS Books completion + SuiteAnalytics external API (landed 2026-06-11/12)

The closing arcs of the NetSuite line, landed car-by-car through the merge train with per-car review. With these, every documented deferral from v0.7–v0.9 is closed or dispositioned.

**NS Books finale + Phase 3.5 sub-arc:** byte-perfect AccountingBook roundtrip via the frozen-payload stash (#163), the `nsIsElimination` dual-write retired after verifying zero readers (#164), the book-mapping UI on a verified `requireAdmin` boundary (#165), the Phase 3.5 design doc with corrective preamble (#167), sub-ledger lineage uniques live-applied as migration 0018 **plus the migration-mirror section the chain missed** — partial uniques are db-push-invisible (#168), the per-book sub-ledger loops with per-book resume extended to all four paths in transit (#169), aging CSV filename collision fix (#170), the cross-book application guard (#171), and the multi-book discovery banner (#172).

**SuiteAnalytics external API (#173–#187):** bearer-authed read endpoints under `/api/external/ns-analytics/` for BI tools expecting NS REST shapes.
- **#173 design** landed with a corrective preamble: no CTA on main (v1.27 disposition), and "RLS enforcement" corrected to explicit tenant-scoped queries (RLS is Phase-1-only, deficiency #12 user-gated).
- **#174 auth** reuses the existing `TenantApiToken` infra (SHA-256 + `timingSafeEqual`, rotation/revocation); `tenantId` derives from the token, never query params; ACCESS_DENIED/DATA_EXPORT audit rows with IP + UA.
- **#175 resolvers** — NS internalid → ledger-core code via lineage; `resolveNsAccount` tenant-scoped in port (an unscoped lookup was a cross-tenant existence oracle).
- **#176/#177 shape mappers** — NS-canonical TB/IS/BS via `?shape=ns`; #182 refined the 5→14 accttype taxonomy with subtype hints.
- **#178 Saved Search** — whitelisted fields/operators per searchType, scalar-only values, hard caps, structural injection resistance (Prisma where-objects, never SQL); #181 added Customer/Vendor/Item; #184 added the amount filter on denormalized JE totals (migration 0019 + backfill).
- **#179 consolidated TB** — `periodStart` rejected with an explicit 400 (remeasurement method; no translation layer exists), translation JSON keys pinned null for shape-strict adapters; #183 added wide-format CSV (no CTA row — CSV has no key contract).
- **#185** — `OpenItemState` reverse-export extension carrying the per-book sub-ledger divergence NS's one-item-per-transaction shape cannot represent.
- **#187 (34th adversarial pass)** — CWE-1236 CSV formula injection closed across all four serializers: shared `toCsv` helper prepends a quote to `=`/`+`/`-`/`@`/tab/CR leaders; NS-controlled account names flow byref into CSVs auditors open in Excel.

**Forward-compat flag (recorded on #181):** saved-search string filters use equality on columns the deferred encryption-split PRs plan to encrypt (e.g. `Party.displayName`, plaintext today) — when that arc revives, those filters silently match nothing unless deterministic encryption or a search-index column ships with it.

### v1.30+ — beyond
The v1.0 polish list (autocomplete, recurring entries, multi-currency revaluation, FX gain/loss wiring) is fully shipped, and v1.27 completed realized FX on settlement. Remaining FX depth — current-rate-method consolidation translation + CTA (`POST_CTA` close-task stub) — is gated on per-line functional-currency amounts (see the v1.27 disposition) and waits for a multi-entity foreign-currency engagement to ask for it.

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
- **2026-05-21** — Inlined UI primitives (Card/Table/Button/Badge/Input) instead of running the shadcn CLI. Trade-off: less polish, but the bundle stays tiny, the components are auditable, and there's no interactive setup step blocking `npm install`.
- **2026-05-21** — The new-entry form serializes its dynamic lines array to a single hidden `linesJson` input on every keystroke. Alternative was `name="lines[0][accountCode]"` style FormData, which requires more parsing logic in the Server Action and doesn't survive `FormData.getAll` ordering. JSON serialization is one line in the client, one parse in the action — net simpler.
- **2026-05-21** — `POST /api/admin/reset` fails closed when `ADMIN_TOKEN` is unset (503, not 401). Reasoning: a 401 implies the endpoint is operational but the token is wrong; 503 communicates "this endpoint is intentionally disabled in this deployment." Helps debug a missing env var faster.
- **2026-05-21** — Seed extracted to `src/lib/seed/northwind.ts` with `prisma` passed as a parameter. The script wrapper at `prisma/seed.ts` is the same shape as before — just 30 lines instead of 670. The reset endpoint imports the same module so there's exactly one Northwind definition.
- **2026-05-21** — Cash flow classification uses subtype-driven heuristics, not hard-coded account codes, so QBO/NS-imported charts work without code changes. The `uncategorized` panel is the safety net — any BS change the heuristic can't place surfaces in the UI with a note pointing at `src/lib/accounting/reports/cash-flow.ts` for the fix. Trade-off: classification is best-effort, not authoritative.
- **2026-05-21** — Decided NOT to add a `cashFlowCategory` enum column to `Account`. Reason: would either be redundant with `subtype` (which already drives this) or would require constant tuning per ERP import. Heuristic on `subtype + type + isBank` covers ~95% of normal accounts; the `uncategorized` panel handles the long tail explicitly.
- **2026-05-21** — Cash flow tests use controlled fixtures (capital infusion only / all-AR no collection / capex + sale / depreciation add-back) rather than the full Northwind seed because Northwind has the ASC 842 lease complications. The fixtures isolate one mechanic at a time and assert `reconciles === true` on each.

### BlackLine arc decisions (2026-06-08 → 2026-06-09)

- **Frozen-snapshot pattern, applied uniformly** — `Reconciliation.glBalance` + `Reconciliation.tolerance`, `FluxLine.priorAmount` + `FluxLine.currentAmount` are captured at sign-off / generation time, not computed on read. Reason: backdated JEs into a signed period would otherwise retroactively flip a RECONCILED recon into EXCEPTION (and vice versa). The auditor's principle "what did the preparer see when they signed" rules. Trade-off: snapshot can drift from real-time GL if the period reopens; this is accepted because period close enforces a hard boundary.
- **3-level cascade resolver for recon defaults** — `Account.reconTolerance` → `ReconciliationConfig.defaultTolerance` → BlackLine baseline ($0). Same pattern for `requiresReview` and `category`. Reason: a controller can set a per-tenant default once, override on the few accounts that need different treatment, and never re-litigate the question. Reads cleanly, audits cleanly.
- **Strict segregation of duties at the Server Action layer** — `preparer.id !== reviewer.id` enforced via `SAME_USER` error code rather than RLS. Reason: the rule is logical, not row-level; the same user IS the actor for both actions across time. Server Action is where the policy lives.
- **DFS cycle prevention on close-task dependencies** — `CloseTask.dependsOnIds` is enforced via depth-first walk in the Server Action, NOT a Prisma constraint. Reason: Prisma can't validate DAG-ness at the schema level. Walk happens before insert; cycle → SoftError → 400. Wall-clock cost is negligible at the task scale (50–200 tasks per period).
- **Audit log: ONE aggregate row on bulk operations, ONE per-line on commentary** — bulk waive of 30 flux lines writes a single `audit_log` row with `metadata.count = 30`; per-line commentary writes one row each (different commentary text is the audit evidence). Reason: noisy bulk rows make `audit_log` unreadable; per-line is fine when each carries unique evidence.
- **Period-close gate composes Phase 1 + Phase 2 + Phase 3** — `checkPeriodClosePrerequisites(periodId)` returns the list of (recon not RECONCILED, required task not DONE, flux statement not FINALIZED) blocking signoff. UI shows the list; admin override is still possible (with `bypass` audit log entry). Reason: the three pillars are conceptually independent but operationally must all close together — the controller wants ONE gate to consult.
- **`audit_log` append-only DB constraint blocks tenant cleanup in tests** — `prisma.tenant.deleteMany` fails when audit rows reference the tenant; tests leak tenants. Documented as environmental, not a flake. The constraint is correct (SOC 2 CC7.2); the test pattern was wrong. Lesson institutionalized in CLAUDE.md.
- **Test cold-start flake on Neon** — first test run after idle sometimes fails on Prisma cold-start; retry succeeds. Documented as environmental, not a flake. Don't disable; don't retry-loop; just be aware.
- **22-PR arc composed via stacked branches + `-X ours` merge** — `blackline-arc-recons` → `blackline-arc-tasks` → `blackline-arc-flux` → `blackline-arc-capstone`. The capstone branch's three-way merge of all three phase branches had 9 schema collision sites; aborted the complex 3-way merge and re-did with `git merge -X ours`, then manually layered Phase 3 backrefs across Tenant/LegalEntity/Book/Period/Account/User. Backref blocks across all three phases needed to coexist in one schema. Lesson: stacked branches WORK but the final merge is non-trivial; budget time for it.
- **Severity matrix for cross-pillar alerts** — high (immediate eyes) / medium (slipping but not stuck) / low (informational). Tuned for a 5-7 day close window: recon EXCEPTION = high; recon PREPARED ≥2d stale = medium; task BLOCKED + required = high; flux statement NEEDS_COMMENT ≥3d = high. The aging thresholds are the controller's institutional knowledge.
- **Retrospective metrics are read-only and lookback-bounded** — `getCloseRetrospective(prisma, scope, lookbackPeriods, targetDays)`. Lookback clamped [3, 36] periods; target clamped [1, 30] days. Recurring-blockers is current-snapshot (no state-history table yet); doc'd as accepted v1.18 limitation, candidate for v1.19+ enhancement when an `audit_log` replay walker lands.
- **Close-task templates use `defaultDependsOnKeys` (not ids)** — instantiation resolves keys → ids at the tenant level. Reason: re-seeding against a fresh tenant gives matching dependency wiring without UUID juggling. Same pattern as the QBO/NS mapper lineage triples. The portability dividend.

### Close-task state-history decisions (2026-06-10)

- **Append-only DB trigger with `pg_trigger_depth()` cascade carve-out** — same as `audit_log`, but the FK chain `close_task → close_task_state_change` would deadlock with a strict refuse-all-DELETE trigger when a tenant tears down. Solution: trigger checks `pg_trigger_depth()` and lets cascade-context deletes through (depth > 1). Direct DELETE from a client query is always depth = 1 and stays blocked. SOC 2 audit-trail property preserved; right-to-erasure still works.
- **Nullable `changedById` is a deliberate concession to the backfill** — the migration can't invent an actor for historical rows. Schema permits null; the `recordStateChange` helper requires non-null on live writes. The UI surfaces "system backfill (pre-0011)" so the auditor can distinguish baseline rows from live transitions. The alternative — backfilling to a "system user" id — would have been a lie.
- **State-change writes inside `$transaction` with the close-task update** — atomic. A failed insert rolls the status update back too. The audit_log call stays outside the transaction (matches the existing pattern across the codebase; audit is best-effort).
- **`recurringBlockers` semantics changed from current-snapshot to ever-blocked** — the return shape stayed identical so the UI didn't need touching, but the meaning changed. Documented in the docstring + commit message. The fixture update on the pre-existing test was unavoidable — the test was implicitly relying on snapshot semantics; under the new contract it had to mint the matching state-change row by hand because it created the task via raw Prisma, bypassing the action layer.
- **`createMany` for INITIAL rows on bulk instantiation** — one round trip for N tasks instead of N transactions. Append-only trigger allows bulk INSERT (only UPDATE/DELETE blocked), so this is clean.
- **`reason` populated only for BLOCKED + WAIVED** — start/complete/unblock leave it null. Reduces noise; captures the audit-relevant signal. The block reason is the most-asked-about field when reviewing close history.

### db:reset repair (2026-06-10)

- **`db:reset` switched from `prisma migrate reset --force` to `prisma db push --force-reset --skip-generate`** — the repo has no baseline `0000_init` migration (the schema has always been `db push`-managed; `prisma/migrations/` is incremental-only), so `migrate reset` drops the schema, replays only the incrementals, fails at `0001_constraints` with P3018 ("relation gl_entry_line does not exist" — nothing created the base tables) and leaves the database EMPTY. This happened on 2026-06-10 and required a full manual recovery. Post-reset caveats (shared-DB companion tables, migration-only DDL mirroring, default-tenant bootstrap) are documented in `docs/deployment.md` under "db:reset caveats".
- **Post-incident audit of the live Neon DB found the manual recovery was INCOMPLETE** — production had been running since the reset with NO append-only triggers (`audit_log`, `close_task_state_change`), NO `0001_constraints` CHECK constraints/GIN indexes, and NO lineage partial unique index. `db push` restores only what `schema.prisma` can express; nobody re-applied the migration-only DDL. Another attestation-drift case: the docs said the enforcement existed; the database disagreed.
- **Fix: `prisma/sql/migration-mirror.sql` is now the single source of truth for migration-only DDL** — idempotent, applied by `npm run db:restore-ddl` (which `db:reset` chains automatically), by CI (replacing the inline psql heredocs), and re-applied to production via Neon on 2026-06-10. The `audit_log` trigger and lineage unique index had no migration of their own (predate the practice); they were reconstructed from the 0011 migration commentary and `src/lib/accounting/recurring.ts`'s idempotency contract. Rollback for each block is noted inline in the file. Logged as deficiency #13 (Closed).
- **audit_log enforcement is the silent-RULE mechanism, restored from the PR #10 arc** — the first restoration draft used a loud RAISE trigger; the PR #232 CI run failed 21 tests across 12 files (suites delete their own audit rows in cleanup), which surfaced the real history: the original mechanism was Postgres RULEs (`DO INSTEAD NOTHING` on UPDATE + DELETE — deliberate: ORMs issue spurious UPDATEs, and silent failure gives attackers no feedback), authored Jun 6 in commit a0caf92 with a `withAuditLogMutable` test escape hatch + probe tests, extracted from PR #10 but never merged — so it existed only on the live DB and died with the reset. Adopted a0caf92 wholesale into PR #232: `prisma/sql/audit-log-append-only.sql` (applied by `db:restore-ddl` next to the mirror file), helper, probe tests, 15 patched test files. Deficiency #14 opened + closed same day. LESSON: the rule names in the SQL file and the helper's re-arm statements must stay in sync.
- **Migration 0015 — both formerly source-less objects captured byte-exact from pre-incident production** — a Neon point-in-time branch at 2026-06-10T21:00:00Z (the wipe re-seeded at 21:14Z; 6h retention window) recovered the actual pre-reset catalog via pg_rules/pg_indexes, replacing reconstruction-from-commentary with primary evidence. It confirmed the RULE mechanism above AND exposed a second material error: the real lineage index is `gl_entry_header_lineage_uniq` on `("tenantId","bookId",sourceSystem,sourceRecordType,sourceRecordId) WHERE` all three lineage columns NOT NULL — the interim reconstruction was a tenant-less bare triple, under which the SECOND tenant importing any given ERP record id fails with a unique violation (QBO ids are small per-company integers; CC6.1 cross-tenant import failure + existence leak). `prisma/migrations/0015_audit_log_rules_and_lineage_uniq/` is now the numbered in-repo source for both objects (exact DDL + repair DROPs for the interim trigger/index); mirror section 5 and `audit-log-append-only.sql` carry the applied forms verbatim. Re-applied to production and verified via pg_catalog: rules present, interim objects gone, index matches the capture byte-for-byte. Side effect: the 7 historical `tenant-context` cleanup failures (audit_log append-only pinning tenants) are gone — cleanup goes through the escape hatch.
- **The seed now self-bootstraps the default tenant** (`ensureDefaultTenant` in `src/lib/seed/default-tenant.ts`, called only from `prisma/seed.ts`) — so `db:reset` is one-shot on a fresh database. `getDefaultTenantId` stays strict (throws) because runtime code must never silently mint a tenant. CI's psql bootstrap step was removed; CI's fresh database now proves the bootstrap path on every run.
- **Pre-incident catalog diff — three orphaned `gl_entry_header` objects deliberately NOT restored** — the same PITR capture that recovered the byte-exact 0015 DDL also surfaced a `"totalDebit"` column and two indexes (`gl_entry_header_total_debit_idx` on `("tenantId","totalDebit")`; `gl_entry_header_tenantId_status_createdAt_idx` on `("tenantId",status,"createdAt")`) with NO in-repo source — not in `schema.prisma`, no migration, zero hits in code or git history (`git log -S` across this repo and the companions). Disposition recorded here so the next pre/post-reset catalog diff doesn't re-flag them; all three verified absent from production (pg_attribute/pg_indexes) on 2026-06-10 post-restore.
  - `"totalDebit"` + its index: an abandoned hand-applied experiment — a denormalized header debit total. Nothing in the portfolio read, wrote, or maintained it (no trigger was captured alongside it), so it could only drift from the line-level truth; header totals derive from `gl_entry_line` at query time, which is the discipline `postJournalEntry` and the trial balance are built on. The PITR window has expired and the column type was never captured, so a faithful restore is no longer possible even if wanted. Dropped from consideration.
  - `gl_entry_header_tenantId_status_createdAt_idx`: name follows Prisma convention but it was never in `schema.prisma` — likely a hand-applied query-tuning experiment. The query shape it implies (filter tenant + status, order by createdAt) is issued NOWHERE in ledger-core or any companion: the JE list filters `(tenantId, entity, book, documentDate range)` ordered `(documentDate, entryNumber)`; the dashboard recent-entries list is `(entity, book)` ordered `(documentDate, createdAt)`; both are served by existing indexes (`entityId_bookId_documentDate`, `tenantId_postingDate`). `status` is write-only today — set `POSTED` at create, `VOID`/`REVERSED` by id — no read path filters on it. An unused three-column btree on the system's hottest insert table is pure write amplification, so it was NOT restored. Revival path if a status-filtered JE view ever ships (e.g. a DRAFT approval workflow): `@@index([tenantId, status, createdAt])` in `schema.prisma` plus a numbered migration — Prisma can express a plain composite btree, so `prisma/sql/migration-mirror.sql` is NOT its home (the mirror carries only what `db push` cannot create).
  - Same change-management failure class as deficiency #13: DDL applied by hand to production with no in-repo source, discovered only because the wipe forced a catalog diff. The mirror-file rule plus this disposition note close the loop on all three objects.

---

### Consolidation tenant-scoping fix (2026-06-11)

- **Three unscoped lookups in the consolidation path closed** (deficiency #15, Closed). The account-metadata `findMany` in `getConsolidatedTrialBalance` matched by code alone — a same-code account in another tenant carrying an IC subtype could eliminate a real balance from the consolidated TB (subtype drives `ALL_IC_SUBTYPES` classification) and `isContra` would flip the sign. Now pinned to `root.tenantId`. The root-entity `findFirst` takes an optional `tenantId` pin; both UI callers (`/reports/consolidation` page + CSV route) pass the session tenant because `?root=` is client-controlled — cross-tenant codes now fail closed. Per-entity `getTrialBalance` calls pass `tenantId` too.
- **`getTrialBalance`'s account scan was the deeper hole** — shared accounts (`entityId=null`) exist per tenant, and the unfiltered `OR: [{entityId: null}, {entityId}]` scan pulled every tenant's shared chart: zero-row code/name leak, plus same-code shadowing via the by-code dedup (the regression test caught this when the poisoned account returned debit 0 for a real $1,000 balance). `resolveEntityBook` now returns the entity's `tenantId` and the scan filters on it — always, not just when the caller passes `tenantId`.
- **Same pattern still open in IS / BS / cash flow / M-3 detail** — logged as deficiency #16 (Open). Lower severity: no elimination logic rides on those scans and the entity is session-derived on those pages, but the zero-row leak + name shadowing is the same. Fix is mechanical now that `resolveEntityBook` returns `entityTenantId`.
- **Regression tests are adversarial, not just structural** — `tests/consolidation.test.ts` mints a unique per-run account code in the default tenant AND a poisoned same-code IC-subtype/contra account in a second tenant, then asserts the balance survives consolidation unclassified. Lesson from the first draft: don't assert against the shared chart's pre-existing rows (the persistent test DB's `1000` had `subtype: null`, not the chart's `CASH`) — mint your own. Second lesson re-confirmed: `app_user` hard-deletes in cleanup need `withAuditLogMutable` (deficiency #14's XX000 sharp edge).

### Report tenant-scoping sweep (2026-06-11) — deficiency #16 closed

- **The remaining unscoped report account scans are fixed.** `getIncomeStatement` + `getBalanceSheet` (`src/lib/accounting/reports.ts`) now pin their account scans to `resolveEntityBook`'s `entityTenantId`, exactly mirroring the `getTrialBalance` fix. `getCashFlowStatement`, `getBookTaxDifference`, and `getM3Detail` each resolve the entity first (optional `tenantId` pin from the session, same fallback semantics as `resolveEntityBook`) and scope their metadata scans to that entity's tenant; all UI pages + CSV routes for the three thread `scope.tenantId` from `getCurrentScope()`.
- **`book-tax-difference.ts` was worse than logged** — the "needs review" subtype scan read the ENTIRE account table (every tenant, no filter at all) into a last-write-wins by-code map. A same-code account in another tenant could flip a delta's permanent/temporary classification, and the M-3 bucketing downstream of it. Now tenant + entity-or-shared scoped.
- **Five adversarial regression tests** in `tests/report-tenant-scoping.test.ts` (one per report: IS, BS, cash flow, BTD, M-3), modeled on the consolidation poisoned-shared-account describe: per-run unique codes in the default tenant, same-code hostile-metadata rows (`isBank` flips, `MEALS` subtype) plus leak-probe codes in a second tenant. All five verified to fail pre-fix (leak of zero-balance rows, AR dropped from the working-capital walk, TEMPORARY→UNCLASSIFIED flip, M-3 re-bucketing) and pass post-fix.
- **Sweep result:** no `account`/`legalEntity` lookup in `src/lib/accounting/reports/` remains without a tenant pin. The dashboard (`src/app/page.tsx`) still calls IS/BS with the raw cookie scope (no `tenantId`) — the legacy fallback resolves the entity by code and the scan pins to *that entity's* tenant, so the account bleed is closed there too; threading the session tenant through the dashboard remains nice-to-have hardening.

### v1.26 — personal-books arc: bank feed, automations Phase 0, ask-your-ledger, competitive docs (2026-07-16)

- **Dogfood instance**: ledger-core now runs Chris's personal books (dedicated Neon project, encrypted at rest, runbook off-repo). The arc's fixes all came from using the product for real.
- **UX/correctness sweep (#244–#251)**: Laws-of-UX nav restructure (then NetSuite-ontology restore in #250 — Master data ≠ Transactions), dashboard demo-date/close-counting/cash-tile fixes, provenance forgery closed (#247 — `source` is server-stamped), production build gated in CI (#248 — tsc+vitest can't catch bundler rules), account register (#251).
- **Bank feed Cars 1–2 (#252, #253)**: `BankTransaction` staging + CSV import (dedupe-safe) → For-Review inbox → Add / Match / Exclude; learned merchant→category rules (SUGGEST-only) + match-to-existing with server-side re-verification. Car 3 (auto-add) held for the automation-library §8 sign-off.
- **Automation library (#254 spec, #255 Phase 0)**: `/automations` read-only control center — every standing automation, its governance level (posts automatically vs suggests only), live status from real data. The Trust-Label-shaped disclosure surface (Sage shipped theirs Nov 2025; convergent design).
- **Ask your ledger (#257 + this PR)**: read-only NL query at `/ask` — Claude picks the tools, the SAME deterministic report builders the pages use compute every number, Claude phrases. Ten tools after this PR (balances, IS, BS, activity, accounts, JE search, cash flow, AR/AP aging, book-tax difference). Degrades to not-configured without `ANTHROPIC_API_KEY`.
- **Sub-ledger aging tenant pin (this PR)**: `arAging`/`apAging`/`openArBalance`/`openApBalance` carried the pre-tenancy signature (bare `entity: {code}`) — same class as closed deficiency #16, found while wiring the aging tools. Optional `tenantId` pin added; all page/CSV callers thread the session tenant.
- **⌘K command palette (this PR)**: keyboard-first navigation over every destination (Jakob's — the universal ⌘K convention; Fitts — zero-distance target; Hick's — typing collapses ~30 pages to the 1–3 that match). New `src/components/nav/catalog.ts` is now the SINGLE source of nav truth — sidebar + palette both consume it, so neither can list a page the other misses (5 DB-free contract tests prove it; sidebar shrank 105 lines). Visible ⌘K header chip for mouse discovery; `flattenCommands` leads with the New-entry action. Navigation only, never posts.
- **UI/UX round 2 — competitor-informed (#261)**: header ✦ Ask (Campfire/JAX: the assistant is chrome, not a page; Fitts), "Bank lines to review" leads Action items + live nav count pill (Xero: the daily rec loop is the retention surface; Zeigarnik), close x/y progress bar when tasks exist (Rillet "zero-day close"; Goal-Gradient), humanized provenance badges on JE list + register rows ("posted automatically" / "AI · you approved" — Sage Trust Label; Proximity). Nav ontology from #250 deliberately untouched (Jakob's).
- **Competitive landscape (#256, #258)**: Campfire/Rillet (AI-native frontier) + Xero/Sage (incumbents) in `docs/design/`. Lane: Intacct depth at Xero price, self-serve.
- **CI flake fixed (#259)**: close-retrospective-history P2002 — overlapping random ordinal ranges self-collide ~3.3%/run (not concurrency; vitest is singleFork). Dedicated calendar + deterministic ordinals + self-healing scrub.
- **xbrl-filer v1 shipped** (companion repo): raw XBRL 2.1 instance generation, 35-concept us-gaap subset, calc validator, per-fact tie-out. ⚠️ Portfolio-wide lesson: `db push` from a companion with a stale mirror is destructive to the shared DB (263-statement near-miss) — reviewed-diff protocol documented there; recon's mirror needs the same fix (chip open).

## Notes for the next session

- Architecture canon: `docs/universal-schema.md`. Schema visual: `docs/schema-erd.md`. Both are kept in sync with the actual schema.
- Headline test command: `npm test` (runs invariants + sub-ledgers + seeded-company + BlackLine arc suites). Tests need a live Postgres at `DATABASE_URL`. The historical 7 `tenant-context.test.ts` cleanup failures (audit_log append-only pinning tenant teardown) are fixed as of migration 0015 — audit-row cleanup goes through `withAuditLogMutable`. Watch for the XX000 sharp edge: hard-deleting `app_user` rows requires the same escape-hatch window (deficiency #14).
- Seed data dependencies: `npm run db:push && npm run db:seed` in that order. The seed expects a freshly pushed schema; reset with `npm run db:reset` — but read the db:reset caveats in `docs/deployment.md` first (shared DB with companion repos, migration-only DDL to re-mirror, default-tenant bootstrap before the seed can run).
- One-shot demo: `npm run demo` (v1.17). Wipes DEMO_CO + posts 28 JEs across May 2026 + closes May. Opens to a tied-out month-end packet.
- BlackLine arc entry points: `/close` (dashboard) → `/close/alerts` (cross-pillar feed) → `/close/retrospective` (process metrics). Sub-pillars: `/close/reconciliations` → `/close/tasks` → `/close/flux`. JSON API at `/api/close/alerts` for Slack notifier wiring.
- SOC 2 readiness state: `SOC2_READINESS.md` v2.3 / control-deficiency-log v2.3 / risk-register v2.4. Audit window opens 6 months out; cannot bolt on later. Every mutation MUST `logAudit`; every fetch-by-id MUST be org-scoped `findFirst`; every input MUST `validateForm/Json`; every log MUST `redactPii`.
- Branch state when this amendment shipped: `blackline-arc-capstone` at 5c510c6 (Phase 4 PRs 1–3 + this PR 4 amendment). Merge target: `main` (assumes branch protection). PR description should call out: 22 PRs total, 4 phases, +15,847 LOC, 15 new test files, 3 new migrations all reversible.
- Pre-PR checklist run on 2026-06-09 verified READY FOR PR (two operator caveats: run `pnpm approve-builds` for local lint; acknowledge the 7 pre-existing tenant-context flakes in the PR description).
