# Project Status

Running log of where this project is, what's next, and key decisions. Updated at the end of each working session so the next session (whether by me or by Claude Code) can pick up without re-explaining context.

---

## Where we are

**Last updated:** 2026-05-21

**Current state:** v0.5 just landed. QuickBooks Online mapper — the "validate by mapping" milestone from `docs/universal-schema.md`. End-to-end QBO import (Accounts, Customers, Vendors, Invoices, Bills, Payments, BillPayments, JournalEntries) with full Layer 6 lineage on every row, idempotent re-runs, paired AR/AP open-item lifecycle, AND a reverse exporter that reconstructs the original QBO JSON for roundtrip equivalence. Plus allowance-method bad debt to complete the bad-debt story.

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

---

## What's next

### v0.6 — UI + live demo
- [ ] Initialize shadcn/ui in the repo
- [ ] Pages: dashboard, chart of accounts, journal entries list + entry detail, all three reports + book-tax-diff
- [ ] Multi-book switcher in the top nav
- [ ] Deploy to Vercel + Neon (free tier)
- [ ] Loom walkthrough + screenshots for the README

### v1.0 — NetSuite mapping + consolidation
- [ ] NetSuite mapping example (stresses dimension engine, multi-book posting rules, custom fields)
- [ ] Multi-entity consolidation report with intercompany eliminations
- [ ] M-1 / M-3 detail report (sub-classifying BTD by IRS form line)

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

---

## Notes for the next session

- Architecture canon: `docs/universal-schema.md`. Schema visual: `docs/schema-erd.md`. Both are kept in sync with the actual schema.
- Headline test command: `pnpm test` (runs invariants + sub-ledgers + seeded-company suites). Tests need a live Postgres at `DATABASE_URL`.
- Seed data dependencies: `pnpm db:push && pnpm db:seed` in that order. The seed expects a freshly pushed schema; reset with `pnpm db:reset`.
- The posting-rules engine is the v0.4 unlock. Once that lands, the seed can stop hardcoding `postToBooks([...])` and let the rules table drive divergence.
