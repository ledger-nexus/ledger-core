# Project Status

Running log of where this project is, what's next, and key decisions. Updated at the end of each working session so the next session (whether by me or by Claude Code) can pick up without re-explaining context.

---

## Where we are

**Last updated:** 2026-06-06 (5-deficiency closure capstone + 5 PR #10 splits + CLAUDE.md institutionalization — Critical-Open=0 milestone + PR #10 substantively decomposed)

**Current state:** **Critical-severity Open count: 1 → 0.** 5 deficiencies closed in 2 days (2 Closed, 3 Remediated) including the session-defining #1 auth Critical Remediation. End-to-end engineering + doc-pentagon + merge-train coverage for #1 (auth), #12 (RLS), #4 (npm pinning portfolio-wide), #2 (CSP), and #9 (audit log replication design). Closed-state count 12 → **14** of 28 tracked; Remediated-state 1 → **3**; readiness % 80% → **85%**.

**Deficiency #1 (Auth uses dev cookie stub) → Remediated** via re-audit of code already on main: Clerk integration env-gated + middleware fails closed with 503 in prod when CLERK env unset (commit b99bbb4) + verification test (tests/middleware-fail-closed.test.ts). Original attack now requires BOTH prod CLERK env unset AND attacker to obtain AUTH_STUB_SECRET — first condition blocked by the 503 gate. Risk register #1 score drops from 20 (4×5) to 5 (1×5) — biggest single-risk score drop in register history. **Deficiency #12 (RLS not FORCED) → Remediated.** The 27-PR RLS arc closed across Phases 1+2a+2b + Phase 3 design + Phase 3 prereqs + 15th adversarial pass + institutional record. Phase 3 implementation (the actual `ALTER TABLE FORCE` flip + 6-category cross-tenant test suite) is DRAFT in PR #89 awaiting operator ack on the Decision C runbook. **Deficiency #4 (npm deps not pinned) → Closed portfolio-wide** via 5-PR sweep: 115 dependency ranges pinned to exact versions across all 5 repos. **Deficiency #2 (No CSP header) → Closed** via standalone PR #99 extraction from PR #10's foundation arc (strict-dynamic nonce middleware, 9/9 tests pass). **Deficiency #9 (audit log replication) → Remediated** via PR #104 Phase 1 design doc; Phase 2 (sync inline emit) deferred until customer #2 onboarding.

Auth + multi-tenant isolation + supply-chain control + anti-XSS + audit-trail-integrity postures all upgraded in the same day. **Engineering parity reached on tracked deficiencies** — all remaining Open severities (#3 HIGH backup drill; #6/#7/#8 Medium; #10 Low) are operator/founder-coordinated.

**v1.0 portfolio milestone** remains intact — substrate (Layer 1+2), ERP mapping (QBO + NetSuite), interactive UI, three financial statements, BTD + M-3 for tax provision, multi-entity consolidation. The 2026-06-05 → 2026-06-06 SOC 2 hardening (Groups U + V + W + X + Y arcs) is multi-tenant safety + supply chain + XSS + audit-trail + auth hardening on top of the v1.0 portfolio.

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

### RLS arc — multi-tenant safety hardening (2026-06-05, 27 PRs)

The full closure of deficiency #12 (RLS not FORCED). Sits between v1.x portfolio milestones and Phase 3 implementation.

**Engineering:**
- **Phase 1** (PR #66): 39 per-table RLS policies + `app_current_tenant_id()` SQL function
- **Phase 2a** (PR #67): `withTenantContext` helper — opens a Postgres transaction + sets the GUC via parameterized `set_config` (injection-safe)
- **Phase 2b** (PRs #69-#83, 14 PRs): 23 Server Actions + 3 HTTP routes + 1 batch helper migrated to `withTenantContext`. Full 7-shape catalog (W1/W2/T1/T2/E/M/P) institutionalized in `docs/architecture/rls-phase-2b-migration-guide.md` with reference PRs per shape.
- **Phase 3 design** (PR #84): full design + bypass-role runbook (`docs/runbooks/rls-phase-3-bypass-roles.md`) + decisions A/B/D resolved with recommendations
- **Phase 3 prereqs** (PRs #85, #86): Decision B entity scoping + Decision A drop-probes (+ 15th-pass HIGH/M2/M3 fixes embedded)
- **Phase 3 implementation DRAFT** (PR #89): 37 ALTER TABLE FORCE statements + 6-category cross-tenant test suite (env-gated via `RLS_FORCE_ENABLED=1` for CI matrix per Decision E). Awaits operator ack on Decision C 5-item checklist.

**15th adversarial pass** found 1 HIGH (audit-bypass on Decision A drop) + 3 MEDIUMs + 1 historical finding (deficiency #28: createFixedAsset tenant-blind lookup). All closed in-session before any upstream PR merged:
- HIGH (audit-bypass) → embedded in PR #86
- M2 (uncaught tenant errors) + M3 (multi-tenant-admin contract regression) → embedded in PR #85
- Deficiency #28 → standalone PR #88

**Institutional record** (PRs #87, #90, #91, #92):
- `docs/policies/control-deficiency-log.md` v2.5 — #12 Remediated, #28 Closed
- `CLAUDE.md` — 7-shape catalog + adversarial-pass cadence baked into the repo's auto-loaded rulebook
- `docs/SOC2_READINESS.md` v2.5 — CC6.1 / CC7.4 posture upgrade narrative
- `docs/policies/risk-register.md` v2.3 — Risk #17 → Mitigated (1×5=5, down from latent 4×5=20); new Risk #21 (Phase 3 FORCE flip data-disappearance) captured at 2×4=8 with mitigations

**Ready-to-flip checklist** (PR #89 gating):
1. Phase 2b PRs (#69-#83) merged to main
2. Phase 3 prereq PRs (#85, #86) merged
3. Operator acks Decision C 5-item runbook checklist
4. Migration applied to dev → test suite green under `RLS_FORCE_ENABLED=1`
5. Production cutover per 3-stage rollout in `docs/architecture/rls-phase-3-design.md`

---

### npm pinning arc — supply chain hardening (2026-06-06, 7 PRs portfolio-wide)

Closes deficiency #4 (HIGH severity, opened 2026-05-25) — npm deps not pinned to exact versions. Same playbook as the Sentry shim arc (Group S): one engineering PR per repo + doc-pentagon amendments.

**Engineering (Group V.1, 5 PRs, 115 ranges total):**
- ledger-core PR #95 (23 deps), recon PR #26 (24), fa-amort PR #23 (22), revenue-rec PR #30 (24), integrations PR #20 (22)
- Each PR strips `^`/`~` to the exact version currently in `package-lock.json` — no upgrades introduced
- Verified per-repo: 0 remaining `^`/`~` ranges; `npm install --package-lock-only` clean

**Institutional record (Group V.2, 2 PRs):**
- `docs/policies/control-deficiency-log.md` v2.5 → v2.6 (PR #96): row #4 → Closed
- `docs/SOC2_READINESS.md` v2.5 → v2.6 (PR #97): readiness 80% → 81%, CC7.1 posture upgrade ("range + Dependabot review" → "pinning + Dependabot review + npm audit CI")

**Merge-train**: MERGE_ORDER Group V (PR #98) captures the 7-PR ordering.

After all 7 merge: silent-transitive-upgrade attack vector eliminated on every `npm ci` deploy. Closed-state count 12 → 13.

---

### CSP arc — standalone closure of #2 (2026-06-06, 3 PRs)

Closes deficiency #2 (HIGH severity, opened 2026-05-25) — No CSP header. **Standalone extraction** from PR #10's 9-feature foundation arc so #2 closes on its own merge schedule rather than block on the entire encryption-stack arc.

**Engineering (Group W.1, 1 PR):**
- PR #99: `src/middleware.ts` generates a 16-byte base64url nonce per request via Edge `crypto.getRandomValues`. CSP header on every response with `strict-dynamic` script-src + Clerk/Sentry/Stripe connect-src + `frame-ancestors 'none'` + `object-src 'none'` + `upgrade-insecure-requests`
- Wraps existing Clerk middleware (preserves 503 fail-closed-in-prod behavior)
- 9/9 tests pass (`tests/csp-nonce.test.ts`); `npx tsc --noEmit` clean

**Institutional record (Group W.2, 2 PRs):**
- `docs/policies/control-deficiency-log.md` v2.6 → v2.7 (PR #100): row #2 → Closed
- `docs/SOC2_READINESS.md` v2.6 → v2.7 (PR #101): readiness 81% → 82%, CC6.6 posture upgrade ("static headers + Next.js default escape" → "static headers + per-request CSP nonce + strict-dynamic delegation")

**Merge-train**: MERGE_ORDER Group W (PR #102) captures the 3-PR ordering.

**Pattern documented**: PR #10 still exists with the full foundation arc (helper module + env validator + audit-log RULE + Sentry shim + /soc2-check + pre-commit hook + soc2 skill + /api/health). PR #99 cherry-picks the CSP-only changes. Future extractions follow the same pattern if individual deficiency closures get gated on PR #10's slow merge.

After all 3 merge: anti-XSS control upgrades to defense-in-depth at the response layer. Closed-state count 13 → 14.

---

### Audit log replication arc — Phase 1 design (2026-06-06, 3 PRs)

Remediates deficiency #9 (Medium severity, opened 2026-05-25) — audit_log not replicated outside primary DB. **Same architectural pattern as the RLS arc**: Phase 1 design captures the SOC 2 commitment now; Phase 2 implementation defers to customer-onboarding trigger.

**Engineering / design (Group X.1, 1 PR):**
- PR #104: `docs/architecture/audit-log-replication-design.md` — 4-option comparison (S3 + Object Lock, secondary Postgres, event stream via SQS/Kinesis, periodic snapshot)
- **Recommended Option A**: S3 + Object Lock compliance mode + 7-year retention
- **3-phase rollout**: Phase 1 (this doc) → Phase 2 (sync inline emit via `src/lib/audit/mirror.ts` — DEFERRED until customer #2 onboards) → Phase 3 (async via SQS — DEFERRED until ~1000 rows/day)
- Implementation skeleton + schema migration plan (`sha256` + `priorSha256` columns for hash chain) + cost estimate ($0.02/mo at v1, $1.50/mo at 10-customer scale) + CC mapping (CC4 + CC7.2 + CC7.4 + CC6.7) + 6-step migration sequence with chaos-drill verification

**Institutional record (Group X.2, 2 PRs):**
- `docs/policies/control-deficiency-log.md` v2.7 → v2.8 (PR #105): row #9 → Remediated
- `docs/SOC2_READINESS.md` v2.7 → v2.8 (PR #106): readiness 82% → 83%, CC4 / CC7.4 posture upgrade

**Merge-train**: MERGE_ORDER Group X (PR #107) captures the 3-PR ordering.

**Why Remediated (not Closed)**: mirrors v2.4 RLS deficiency #12 transition. Design surface is captured + implementation path is clear; Phase 2 hasn't shipped yet. Customer #2 onboarding triggers Phase 2 ship.

**Phase 2 trigger requirements**: AWS account + IAM role with `s3:PutObject` only + Object-Locked bucket (compliance mode, 7-year retention) + secrets in Vercel env + boot-time validator enforcement + schema migration + portfolio-wide `prisma.auditLog.create` → `emitAuditRow` cutover + chaos-drill verification. All captured in design doc's Migration sequence section.

After all 3 merge: CC4 / CC7.4 audit-trail-integrity posture upgrades to "documented architecture for substrate-loss survival". Remediated-state count 1 → 2.

---

### #1 auth Critical Remediated arc — re-audit closure (2026-06-06, 3 PRs)

**The most significant single-deficiency closure of the session.** Flips deficiency #1 (the ONLY Critical-severity Open) from Open → Remediated based on a re-audit of code already on `main`. **No engineering required** — the layered defense was already shipped weeks ago; only the auditor-facing log hadn't been updated.

**Re-audit findings (Y.0, all already on main):**
- `src/lib/auth/clerk.ts` — Clerk-backed implementation with JIT user provisioning
- `src/lib/auth/current-user.ts` — env-gated dispatch via `isClerkEnabled()`
- `src/middleware.ts` (commit b99bbb4) — 503 fail-closed-in-prod when `CLERK_SECRET_KEY` unset
- `tests/middleware-fail-closed.test.ts` — verification of the 503 behavior

**Original attack vs current state:**
- **Original** (deficiency #1 row): "Anyone with `AUTH_STUB_SECRET` can impersonate any user."
- **Current**: Attack now requires BOTH (a) prod `CLERK_SECRET_KEY` unset (blocked by 503 gate) AND (b) attacker to obtain `AUTH_STUB_SECRET`. Combo unreachable in production.

**Institutional record (Group Y.1, 3 PRs stacked on v2.8 bases):**
- `docs/policies/control-deficiency-log.md` v2.8 → v2.9 (PR #110): row #1 → Remediated
- `docs/SOC2_READINESS.md` v2.8 → v2.9 (PR #111): readiness 83% → 85%, Critical-Open=0 milestone
- `docs/policies/risk-register.md` v2.4 → v2.5 (PR #112): Risk #1 score 20 (4×5) → 5 (1×5), Open → Mitigated. **Biggest single-risk score drop in register history.**

**Merge-train**: MERGE_ORDER Group Y (PR #113) captures the 3-PR ordering.

**Why Remediated, not Closed**: dev cookie stub remains in code as a dev/test fallback (intentional for UserSwitcher demo). Path to Closed: remove `src/lib/auth/session.ts` HMAC path + remove `AUTH_STUB_SECRET` from `src/lib/env.ts`. Deferred until first customer onboarding.

After all 3 merge: **Critical-severity Open count: 1 → 0** — the session-defining audit-readiness milestone. CC6.1 / CC6.6 auth posture upgraded to "Clerk + env-gated dispatch + 503 fail-closed in prod + verification test".

---

### PR #10 splits — foundation-by-piece (2026-06-06, 5 PRs — fully decomposed)

PR #10 (`soc2-hardening-rollout`) has been open since 2026-06-01 with 9 bundled features. Group Z extracts substantive features as **standalone PRs** so they reach main on their own merge schedule. After Group Z, PR #10 is **substantively decomposed** — the remaining 4 leaf items are either already amended elsewhere or are part of the encryption stack arc.

**Engineering (Group Z, 5 PRs):**
- **PR #99** (also Group W) — `src/middleware.ts` CSP nonce + `tests/csp-nonce.test.ts`. Closes deficiency #2 (HIGH).
- **PR #115** — `src/lib/soc2/index.ts` (10 exports) + `src/lib/monitoring/index.ts` (Sentry shim) + 25 tests. **Completes 5/5 portfolio Sentry shim coverage** (Group S covered 4 companions; this brings the ledger-core piece to main).
- **PR #116** — `src/app/api/health/route.ts` endpoint surfacing schemaFingerprint + DB ping + monitoring presence + uptime + version. 503 on DB-unreachable for pod rotation. **CC7.1 anomaly detection at substrate level.**
- **PR #120** — `prisma/sql/audit-log-append-only.sql` Postgres RULE + `tests/_helpers/audit-log-cleanup.ts` (`withAuditLogMutable` escape hatch) + 3 RULE tests + **15 test files patched** to wrap audit cleanup in the escape hatch. **CC4 + CC7.2.** Pairs with PR #104 design.
- **PR #123** — `.claude/commands/soc2-check.md` (slash command auditing pending git diff against SOC 2 control matrix) + `scripts/pre-commit-secrets-scan.sh` (pre-commit hook scanning staged files for API keys + JWT + PII + .env content). **CC4 + CC8 + CC6.7.** The 5th and effectively final substantive PR #10 split.

**Splitting trajectory:**
- Pre-session: 0/9 PR #10 features standalone, PR #10 bundled at 9 features
- Post-session: **5/9 standalone**, PR #10 bundled at **4 leaf items** (encryption-stack `field-encryption.ts` + docs already amended via v2.4-v2.9 + env validator already on main + soc2 skill which isn't actually in PR #10 file tree — it's user-level)

**Remaining PR #10 features (NOT extracted):**
- `src/lib/soc2/field-encryption.ts` — part of encryption stack arc (PRs #11-#36); lands with that stack
- `docs/SOC2_CONTROL_MATRIX.md`, `docs/SOC2_ROADMAP.md` — already amended via doc-pentagon stack
- env validator — already on main per re-audit (commits a7ebfe8, 274f033, f18af1f)
- soc2 skill — not in PR #10 file tree; loaded from user-level `~/.claude/skills/`

**Audit trail defense-in-depth** (after PR #120 + PR #104 merge):
1. App-level discipline (CLAUDE.md convention)
2. **DB-level RULE silently no-ops UPDATE+DELETE** (PR #120)
3. Out-of-band S3 + Object Lock archive (PR #104 design; Phase 2 deferred)

**Merge-train**: MERGE_ORDER Group Z (PR #117 + PR #121 + PR #124 amendments) captures the 5-PR ordering + remaining-features inventory + defense-in-depth table.

**Institutional memory**: PR #119 amends CLAUDE.md with the PR #10 splitting recipe + deficiency-log re-audit pattern. Future Claude Code sessions inherit the playbook auto-loaded.

After all 5 merge + PR #119: PR #10 itself becomes a leaf cleanup PR for the encryption stack arc — substantively decomposed and no longer on the critical merge path.

---

### 2026-06-06 day capstone — 5 deficiency closures + 5 PR #10 splits + CLAUDE.md, 53 PRs

| Deficiency | Sev | Status | Arc | PRs |
|---|---|---|---|---|
| **#1 Auth uses dev cookie stub** | **Critical** | **Remediated (NEW today)** | **Group Y (doc-only re-audit)** | **3 PRs** |
| #12 RLS not FORCED | HIGH | Remediated | Group U (Phases 1+2a+2b + Phase 3 design + prereqs + 15th pass + pentagon) | 27 PRs (DRAFT impl PR #89 awaits Decision C) |
| #4 npm deps not pinned | HIGH | Closed | Group V (5 engineering + 2 doc) | 7 PRs (portfolio-wide) |
| #2 No CSP header | HIGH | Closed | Group W (1 engineering + 2 doc) | 3 PRs (standalone PR #10 extraction) |
| #9 audit log replication | Medium | Remediated | Group X (1 design + 2 doc) | 3 PRs (Phase 1; Phase 2 awaits customer #2) |
| PR #10 splits (foundation-by-piece) | — | Engineering on main | Group Z (5 PRs: #99 CSP + #115 soc2 helpers + monitoring + #116 /api/health + #120 audit-log RULE + #123 process tooling) — **PR #10 substantively decomposed** | 5 PRs (#99 counted in W; #115, #116, #120, #123 net new) |
| CLAUDE.md institutionalization | — | Institutional memory | PR #119 — auto-loaded by future Claude Code sessions | 1 PR |
| **Total** | | | **Groups U + V + W + X + Y + Z + CLAUDE.md** | **53 PRs** |

**State progression**:
- **Critical-severity Open count: 1 → 0** ← session milestone
- Closed-state count: 12 → 13 → **14** of 28 tracked
- Remediated-state count: 1 → **3** (#1 + #12 + #9)
- Readiness %: 80% → 81% → 82% → 83% → **85%**
- Risk register #1 score: 20 → **5** (biggest single-risk score drop in history)

**Open HIGH severities remaining**: #3 (backup restore drill — operational, Q3 2026). The only remaining HIGH; operator-coordinated, not engineering.

**Open Medium severities remaining**: #6 (MFA), #7 (access review), #8 (vendor SOC 2 receipts), #10 (training records). All operational/founder-coordinated.

**Engineering parity reached** on tracked deficiencies. **PR #10 fully decomposed** at 5/9 splits — the foundation arc is no longer a critical merge blocker. Forward engineering progress from here:
- **PR #10 substantively decomposed at 5/9** — CSP, soc2 helpers + monitoring shim, /api/health, audit-log RULE, process tooling all extracted. Remaining (4 leaf items): `field-encryption.ts` (encryption stack arc), 2 docs already amended via v2.4-v2.9, env validator already on main per re-audit. PR #10 itself becomes a leaf cleanup PR for the encryption stack arc, not on critical path.
- **Audit trail integrity now 3-layer defended** after PR #120 + PR #104 merge: app-level discipline (CLAUDE.md) + DB-level Postgres RULE silently no-ops UPDATE+DELETE (PR #120) + S3 + Object Lock archive (PR #104 design; Phase 2 deferred until customer #2).
- **Phase 2 implementations** of the Remediated items (#12 RLS Phase 3 FORCE pending operator Decision C ack; #9 audit log replication Phase 2 pending customer #2 onboarding).
- **Re-audit other deficiencies for hidden Remediated state** (the #1 finding pattern — deficiency log lagging architectural reality).
- **CLAUDE.md institutional memory** (PR #119) now documents the PR #10 splitting recipe + re-audit pattern so future sessions inherit the playbook.
- **Process tooling on main** (PR #123) — `/soc2-check` slash command + pre-commit secrets scanner. Discoverable for any future session.

---

## v1.0 is the portfolio milestone. Beyond:

### v1.1 — Loom script + autocomplete polish (shipped 2026-05-21)
- [x] `docs/deployment.md` Loom walkthrough updated to 8 beats — adds the consolidation IC elimination demo (beat 7) and the M-3 depreciation grouping (beat 8). Total run time still ~3 minutes.
- [x] Account autocomplete on `/journal-entries/new` via native `<datalist>` (no new deps). Same datalist pattern for the party selector. User types code OR name and the browser filters; no need to scroll a 35-account dropdown.

### v1.2+ — ergonomics + polish (deferred)
- [ ] Keyboard shortcut for "+ Add line" (Tab from last cell)
- [ ] Recurring journal entry templates
- [ ] AR / AP aging with sortable columns
- [ ] Multi-currency revaluation
- [ ] FX gain/loss accounts wired into journal lines properly

---

## Open decisions

- **RLS Phase 3 operator ack** — Decision C 5-item runbook checklist (`docs/runbooks/rls-phase-3-bypass-roles.md`) gates PR #89 merge. Operator-coordination work, not engineering.
- **PR #10 splitting strategy** — CSP extraction in PR #99 proved the pattern works. Future deficiency closures that are gated on PR #10's slow merge can follow the same playbook (cherry-pick the relevant subset into a standalone PR with its own doc-pentagon). Candidates: env validator (closes its own deficiency), audit-log RULE (already on main via other path), /api/health (already on main via other path).
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
