# Design: ledger-core

A short design document covering the goals, key decisions, and known trade-offs of this project. Modeled on the Google-style "design doc" format. For the architectural canon (the locked decisions that drove this design), see [`universal-schema.md`](universal-schema.md).

---

## Problem

Accounting software lives on a spectrum. On one end: spreadsheets — flexible, but no enforced rules, so errors compound. On the other end: legacy ERPs — strict, but slow, expensive, and built before AI tooling existed. The middle is mostly QBO-grade ledgers under polished UIs — fine for small SaaS but unable to absorb a NetSuite, an Intacct, or a multi-book tax structure without rebuilding from scratch.

The interesting opportunity is a *correct-by-construction substrate*: a system where accounting invariants are enforced at the data layer, multi-book is first-class, sub-ledgers are owned natively (not delegated to specialty tools), and the schema can absorb the expressive ceiling of a tier-1 ERP without losing data.

This project is that substrate. The consumer projects in the `ledger-nexus` portfolio (`recon`, `revenue-rec`) sit on top of it.

## Goals

1. **Correctness over completeness.** Better to do less, but provably right, than more and shaky. Every invariant in `docs/accounting-notes.md` must be enforced at the schema or the posting function, then verified by tests.
2. **Universal schema, not QBO-grade.** A QBO mapping must be a strict subset, not a special case. A NetSuite mapping must work without schema changes — only new dimension values, new posting rules, and new master data.
3. **AI-friendly, AI-skeptical.** Anyone (or any model) writing to the ledger must go through `postJournalEntry`. The function is the audit boundary.
4. **Live demo in under 2 minutes.** Clone → install → seed → run. The demo is the multi-book trial balance + book-tax-difference report.
5. **Readable to an accountant.** A controller looking at the schema should recognize what they're looking at — `gl_entry_header`, `gl_entry_line`, `ar_open_item`, not invented abstractions.

## Non-goals

This project deliberately does *not* address:

- **Authentication and authorization.** Every user is treated as a single admin. Production would need RBAC at the `(entity, book, account-type, action)` grain per the spec.
- **Per-country statutory books.** US GAAP + US Federal Tax + IFRS only. Locked per `docs/universal-schema.md`.
- **Document tables (`invoice`, `bill`, `purchase_order`).** These belong in the consumer repos, not in the substrate. The substrate provides the GL posting, sub-ledger lifecycle, and lineage; the document detail is application-layer.
- **A general-purpose UI.** v0.5.
- **A general-purpose API for third-party callers.** When that's needed, it'll be Server Actions or tRPC at the consumer-repo level, not a REST surface here.

## Proposed design

### Six-layer architecture

The schema implements Layers 1, 2, 3 + native sub-ledgers + Layer 4 posting-rules table + Layer 5 custom-field metadata + Layer 6 lineage. Document tables (the rest of Layer 4) live in consumer repos.

See [`universal-schema.md`](universal-schema.md) for the layer breakdown and [`schema-erd.md`](schema-erd.md) for the visual map.

### The posting boundary

All writes go through `postJournalEntry`. It enforces:

- Debits = credits per entry (the headline invariant)
- At least 2 lines per entry
- No mixed debit+credit lines
- All accounts exist, are active, and are in scope for the target book
- The `(entity, book, period)` tuple is not closed
- Atomic write via DB transaction
- `entryNumber` is monotonically increasing per `(entity, book)` — format `ENTITY-BOOK-NNNNN`

Belt-and-suspenders enforcement at three layers: app code → DB CHECK constraints → invariant tests.

### Multi-book is Pattern 2 (full parallel)

Locked per `docs/universal-schema.md`. Single source event → N journal entries, one per relevant book. The future posting-rules engine (`PostingRule` table, no rules registered yet) automates the fan-out by looking up `(sourceEventType, bookId)` and applying a GL-line template. Today the seed does this explicitly via `postToBooks([US_GAAP, US_TAX, IFRS], base)`.

Pattern 1 (derive other books from a primary via summed adjustments at query time) was rejected — it breaks at scale and silently produces wrong period-end balances when adjustments aren't reversed cleanly.

### Sub-ledgers are owned, not delegated

Per the resolved scope: AR / AP / fixed assets / leases / revenue contracts are owned natively in this schema, not handed off to Sage FAS / LeaseQuery / Zuora. The "Own sub-ledgers natively" decision means a real tax provision, ASC 842 lease accounting, and ASC 606 revenue recognition can all run on this substrate without bolting on external data.

Each sub-ledger has the same shape:

| Master | Per-book attributes |
|---|---|
| `FixedAsset` (cost, dates, vendor) | `FixedAssetBookAttributes` (useful life, method, accum dep) |
| `Lease` (contract terms) | `LeaseBookAttributes` (ASC 842 classification, ROU, liability) |
| `RevenueContract` + `PerformanceObligation` | `RevenueContractBookAttributes` (accrual vs cash basis) |
| `ArOpenItem` / `ApOpenItem` (always per-book) | (none — open items themselves are per-book) |

This is the engine of book-tax differences. The `getBookTaxDifference` report is just a diff between two `(entity, book)`-scoped trial balances; the *sources* of the difference live in these tables.

### Reports as pure functions

`getTrialBalance`, `getIncomeStatement`, `getBalanceSheet`, and `getBookTaxDifference` read directly from `JournalLine` on every call. No materialized views, no caching at v0.3 portfolio scale (thousands of lines). A production version at millions of lines would introduce account-level rollups, but that's a scaling optimization, not a correctness one.

## Alternatives considered

### Single-book MVP, add multi-book later

**Considered:** Ship v0.2 as single-book, add multi-book as v1.0. Simpler invariants, smaller schema.
**Rejected because:** The universal-schema spec locked multi-book as Pattern 2 from the start. Retrofitting multi-book onto a single-book schema requires touching every row that records financial impact — see "anti-pattern: keep one ledger and derive other books." Single-book MVP would have been a Pattern 1 trap.

### Storing money as integer cents

**Considered:** Use `BigInt` and represent $1.23 as `123`.
**Rejected because:** Doesn't handle sub-cent precision common in FX, per-unit usage-billed SaaS, or revenue allocation. `Decimal(18,4)` with `decimal.js` is a small ergonomic loss for substantial flexibility.

### Storing each line as a signed amount

**Considered:** Drop debit/credit; use one signed `amount` column.
**Rejected because:** Loses information when an entry zeros out an account, and makes the debit/credit terminology — which accountants think in — invisible at the data layer. The three-currency view in v0.3 *does* use signed amounts (`transactionAmount`, `reportingAmount`), but the canonical functional-currency view stays in the XOR debit/credit pair.

### Event-sourcing pattern (transactions as immutable events, accounts as projections)

**Considered:** Model the whole thing as a stream of typed events with materialized account projections.
**Rejected because:** Adds significant complexity for the v0.3 scope. Accounting and event sourcing *are* a natural fit, and this would be the right pattern for v3+ at high scale. Filed as a follow-up.

### Closing the books at period end with explicit close entries

**Considered:** Post explicit close JEs (revenue/expense → retained earnings) at each year-end.
**Rejected because:** Computing retained earnings on the fly from all P&L activity is equivalent and simpler. A production version at scale (or one needing comparative quarterly statements) would need explicit closes; deferred to v0.6.

## Risks

1. **Computed retained earnings doesn't scale.** Each balance sheet request re-runs the full income statement for the `(entity, book)`. Fine at portfolio scale; needs materialization at production scale.
2. **No concurrency control on entryNumber sequencing.** Two simultaneous posts to the same `(entity, book)` could race. At single-user demo scale this isn't an issue; in production we'd use a Postgres sequence or a dedicated counter table.
3. **The lease and revenue-recognition runners are v0.3 stubs.** Full ASC 842 / ASC 606 mechanics arrive in v0.4 (or in the `revenue-rec` consumer repo).
4. **Sub-ledger lifecycle relies on caller discipline.** `openArItem` and `applyArPayment` aren't atomic with the JE that opens / applies them. A failure between the JE post and the sub-ledger update leaves the two out of sync. The fix (transaction-wrapping the pair) lands when the posting-rules engine arrives.
5. **PostingRule template schema isn't designed yet.** Empty table today. A real rule needs to express "use account 8000 in GAAP and 8001 in TAX, apply this expression to compute the amount, etc." TBD when the first rule is authored.

## Open questions

- Should the trial balance / income statement filter by `JournalSource`? E.g. "exclude AI_APPROVED entries to see what humans posted directly" — useful for audit. Lean yes for v0.5.
- Should `period_close` enforcement use a deferrable DB trigger (true belt-and-suspenders) or stay app-only? Trigger is more correct; app-only is enough for v0.3.
- Per-line currency vs. header currency: when a JE has lines in mixed currencies (intercompany), how does the FX gain/loss get computed? Probably via a separate `fx_revaluation` runner that compares functional-amount lines to current spot rates. v0.6.
