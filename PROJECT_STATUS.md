# Project Status

Running log of where this project is, what's next, and key decisions. Updated at the end of each working session so the next session (whether by me or by Claude Code) can pick up without re-explaining context.

---

## Where we are

**Last updated:** 2026-05-21

**Current state:** v0.3 just landed. Sub-ledgers (AR / AP / Fixed Assets / Leases / Revenue Contracts) now exist as native tables with book-aware attribute joins. Northwind seed posts to all three books in parallel (Pattern 2). Book-tax-difference report is wired. ~30 invariant tests cover the multi-book divergence.

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

---

## What's next

### v0.4 — Posting-rules engine + full ASC 842
- [ ] Posting-rules engine implementation: lookup `(sourceEventType, bookId)` in `PostingRule`, apply template at posting time, replace explicit `postToBooks` fanout
- [ ] Full ASC 842 ROU asset + lease liability roll-forward (replace the v0.3 straight-line stub)
- [ ] Disposal flow for fixed assets (gain/loss on disposal, write off accum dep)
- [ ] Bad debt write-off flow for AR (`writeOffArItem` is wired; needs paired allowance JE)
- [ ] Property-based tests using `fast-check` against the posting boundary

### v0.5 — UI + live demo
- [ ] Initialize shadcn/ui in the repo
- [ ] Pages: dashboard, chart of accounts, journal entries list + entry detail, all three reports + book-tax-diff
- [ ] Multi-book switcher in the top nav
- [ ] Deploy to Vercel + Neon (free tier)
- [ ] Loom walkthrough + screenshots for the README

### v1.0 — ERP mapping demonstrations
- [ ] QBO mapping example: ingest a QBO export, map to ledger-core schema with lineage populated, prove zero-loss round-trip
- [ ] NetSuite mapping example: same but with 8 dimensions, multi-entity, and divergent posting rules
- [ ] M-1 / M-3 detail report (sub-classifying BTD by IRS form line)
- [ ] Consolidation report across multiple legal entities

---

## Open decisions

- **PostingRule template schema** — TBD when authoring the first rule. Likely JSON shape `{ lines: [{ accountCodeFn, debitFn, creditFn, dimensionRefs }] }` with simple expressions.
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

---

## Notes for the next session

- Architecture canon: `docs/universal-schema.md`. Schema visual: `docs/schema-erd.md`. Both are kept in sync with the actual schema.
- Headline test command: `pnpm test` (runs invariants + sub-ledgers + seeded-company suites). Tests need a live Postgres at `DATABASE_URL`.
- Seed data dependencies: `pnpm db:push && pnpm db:seed` in that order. The seed expects a freshly pushed schema; reset with `pnpm db:reset`.
- The posting-rules engine is the v0.4 unlock. Once that lands, the seed can stop hardcoding `postToBooks([...])` and let the rules table drive divergence.
