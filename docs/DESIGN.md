# Design: mini-ledger

A short design document covering the goals, key decisions, and known trade-offs of this project. Modeled on the Google-style "design doc" format.

---

## Problem

Accounting software lives on a spectrum. On one end: spreadsheets — flexible, but no enforced rules, so errors compound. On the other end: legacy ERPs — strict, but slow, expensive, and built before AI tooling existed.

The interesting opportunity is a *correct-by-construction* ledger: a system where the accounting invariants are enforced at the data layer, where the UI is fast and AI-aware, and where the building blocks compose into higher-level accounting workflows (rev rec, bank rec, close management).

This project is the foundation of that vision. It implements a minimal but correct double-entry general ledger. The rev-rec and bank-recon projects in the same portfolio sit on top of it.

## Goals

1. **Correctness over completeness.** Better to do less, but provably right, than more and shaky. Every invariant in `docs/accounting-notes.md` must be enforced and tested.
2. **AI-friendly, AI-skeptical.** Anyone (or any model) writing to the ledger must go through `postJournalEntry`. The function is the audit boundary.
3. **Live demo in under 2 minutes.** Clone → install → seed → run. Anything slower fails the portfolio test.
4. **Readable to an accountant.** A controller looking at the schema or the seed data should recognize what they're looking at without a CS background.

## Non-goals

This project deliberately does *not* address:

- **Authentication and authorization.** Every user is treated as a single admin. Production would need RBAC.
- **Multi-currency.** All amounts assumed USD. Adding FX is non-trivial — it's a worthy future project, not a checkbox.
- **Multi-entity consolidation.** One company, one ledger.
- **Period close ceremony.** No "lock the books for January" feature. We compute retained earnings dynamically instead.
- **Cash flow statement.** Genuinely hard; deferred to a follow-up project.
- **Audit-log immutability with cryptographic guarantees.** We rely on the "posted entries are immutable" rule at the app layer. A real production system would want append-only storage with hash chaining.

## Proposed design

### Core data model

Three tables: `Account`, `JournalEntry`, `JournalLine`. See `prisma/schema.prisma`.

The data model is intentionally smaller than typical ERP schemas. Customers, vendors, products, etc. live in the higher-level projects (bank-recon, rev-rec-606); the ledger doesn't know about them. It only knows about debits and credits hitting accounts.

### The posting boundary

All writes go through `postJournalEntry`. It's the only function with the privilege of mutating the ledger. It enforces:

- Debits = credits per entry
- At least 2 lines per entry
- No mixed debit+credit lines
- All accounts exist and are active
- Atomic write (via DB transaction)

Belt and suspenders: the DB also has CHECK constraints (`prisma/migrations/0001_constraints/migration.sql`) so even bypassing the function won't get you an invalid line.

### Reports as pure functions

`getTrialBalance`, `getIncomeStatement`, and `getBalanceSheet` read from `JournalLine` on every call. No materialized views, no caching. This is fine at portfolio scale (thousands of lines) and dramatically simpler to reason about.

A production version with millions of lines would introduce account-level rollups updated on entry post, but that's a scaling optimization, not a correctness one.

## Alternatives considered

### Storing money as integer cents

**Considered:** Use `BigInt` columns and represent $1.23 as `123`.  
**Rejected because:** Doesn't handle fractional-cent pricing common in usage-billed SaaS or FX. `Decimal(18,4)` with `decimal.js` is a small ergonomic loss for substantial flexibility.

### Storing each line as a signed number (positive = debit, negative = credit)

**Considered:** Drop the debit/credit columns; use one signed `amount` column.  
**Rejected because:** Loses information when an entry zeros out an account. Also makes the debit/credit terminology — which accountants think in — invisible in the data model.

### Using an event-sourcing pattern (transactions as immutable events, accounts as projections)

**Considered:** Model the whole thing as a stream of typed events with materialized account projections.  
**Rejected because:** Adds significant complexity for a portfolio MVP. *However*, accounting and event sourcing are extremely natural fits, and this is the right architecture for a v2. Noted as a follow-up.

### Closing the books at period end with explicit close entries

**Considered:** Post explicit "close revenue/expense → retained earnings" entries at each period end.  
**Rejected because:** For an MVP, computing retained earnings on the fly from all P&L history is equivalent and simpler. A production version would need explicit closes to support comparative statements ("Q3 2025 vs. Q3 2024" requires knowing what the books looked like at end of Q3 2024).

## Risks

1. **The "computed retained earnings" approach gets slow at scale.** Each balance sheet request re-runs the full income statement. Fine at portfolio scale; would need materialization at production scale.
2. **No concurrency control on entry-number sequencing.** Two simultaneous posts could race for the same `entryNumber`. At single-user demo scale, not an issue; in production we'd use a Postgres sequence.
3. **`Decimal` to `Prisma.Decimal` conversion is verbose.** The code does `new Decimal(line.debit.toString())` in several places, which is awkward. A wrapper utility would clean this up.
4. **The chart of accounts is hard-coded in `chart-of-accounts.ts`.** A real ledger would have user-managed accounts via UI. Out of scope for the MVP but worth flagging.

## Open questions

- Should reports support filtering by source (e.g. "show me the trial balance excluding AI_APPROVED entries" for audit purposes)?
- Should we add a `lockedAt` timestamp on entries to support a "close the period" workflow even without full close-entry semantics?

These will be revisited if/when this project graduates from MVP to v1.
