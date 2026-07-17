# Spec — Documents & Corrections Arc

**Status:** Draft / scoping. No code implied by this document.
**Date:** 2026-07-17
**Provenance:** External reviewer (Codex) proposed a "production GL productization"
roadmap; items #1 (native transaction documents) and #2 (correction/reversal
workflows) were scoped here against the actual code and the locked canon
(`docs/universal-schema.md`). Every claim below was verified in-tree before
being written — no reviewer assertion was taken on trust.

---

## TL;DR

The canon splits this arc in two, and the two halves belong in **different
layers of the portfolio**:

- **Corrections & reversals** operate on `JournalEntry` (Layer 1). They are
  substrate work and fit **ledger-core** cleanly. **Recommended to build.**
- **Native transaction documents** (invoice / bill / payment / credit memo)
  are **Layer 4**, which the locked build order assigns to **consumer repos —
  explicitly NOT the ledger-core substrate.** Building them in
  `ledger-core/schema.prisma` would violate a locked decision. **Blocked on a
  repo-placement decision from the owner.**

Do not treat Codex's items #1 + #2 as one buildable arc inside the engine.

---

## The canonical split (the load-bearing finding)

`docs/universal-schema.md` is declared LOCKED by `CLAUDE.md` ("do not
re-litigate, do not propose alternatives, do not soften"). Two clauses decide
where each half of this arc lives:

| Reviewer ask | Layer | Canon clause | Home |
|---|---|---|---|
| Invoices, bills, payments, credit memos, receipts | **Layer 4 (documents)** | Build order line 168: "Layer 4 document tables **← consumer repos**"; line 121: "A bill creates an AP open item; **it is not itself AP**" | **Consumer repo / app — NOT ledger-core** |
| Reverse/rebook, correcting entries, reclass, reopen-with-reason, correction lineage, "why did this balance change" | **Layer 1 (the ledger)** | Operates on `JournalEntry`; `src/app/actions/reverse-journal-entry.ts` already lives here | **ledger-core (in-canon)** |

The canon also draws the sub-ledger/document boundary explicitly
(lines 119–121): "AR / AP / Inventory are **sub-ledgers, not document
tables**." ledger-core already **owns the sub-ledgers** (`ArOpenItem` /
`ApOpenItem` + applications). It does **not** own the documents that feed them.

---

## What already exists (verified — do not rebuild)

- `enum EntryStatus { DRAFT, POSTED, VOID, REVERSED }` — `VOID` and `REVERSED`
  already modeled (`schema.prisma`).
- `JournalEntry.reversalOfId` self-link (`schema.prisma:686`) + working
  `reverse-journal-entry.ts`: sign-flips lines, posts via `postJournalEntry`,
  flips source `POSTED → REVERSED`, links `reversalOfId`, writes an audit row —
  all atomic inside `withTenantContext`.
- `postJournalEntry(db, input)` already accepts **both `documentDate` and
  `postingDate`** — effective-date / posting-date *controls* are UI + policy,
  not new plumbing. It also posts to ONE `(entity, book)`, enforces
  balance/atomicity/account-validity/book-scope/period-close, and dedupes on
  `(sourceSystem, sourceRecordType, sourceRecordId)`.
- `PeriodClose` (`schema.prisma:341`) + `src/app/actions/period-close.ts` —
  close/reopen exists, but see the gap noted in Workstream A3.
- `RecordEvent` append-only audit log — the data source for "why did this
  balance change".
- The document→settlement pattern is already demonstrated end-to-end in
  `src/app/actions/apply-ap-payment.ts`: inside `withTenantContext`, a
  tenant-scoped open-item lookup → `postJournalEntry(tx, …)` →
  `applyApPaymentInTx(tx, …)`, atomic. A *payment document* is this, persisted
  with a lifecycle.

---

## Half A — Corrections & reversals (ledger-core, in-canon)

Four workstreams. Mostly *productizing* primitives that already exist, plus two
small **additive** migrations. Effort is relative (S / M / L).

### A1 · Reverse-and-rebook (S · no schema change)
`reverse-journal-entry.ts` already reverses. Add an optional "rebook" that, in
the **same transaction**, posts a corrected replacement entry and links it back
to the source. Reuses the proven reverse path; no new columns.

### A2 · Correcting-entry + reclassification (M · one additive migration)
A guided Server Action that posts a balanced JE referencing the entry being
corrected (reclass = move an amount from account A to account B, same or next
period). Needs **one additive migration**: a nullable `correctionOfId` self-link
on `JournalEntry`, mirroring the existing `reversalOfId` pattern — consistent
with the locked schema, not a new anti-pattern. This is the **highest-frequency
real correction** and the recommended first slice (below).

### A3 · Reopen-period with reason + approval (M · one additive migration)
The gap: `PeriodClose` carries `@@unique([entityId, bookId, periodId])`, so
close is **binary** (row exists or not) with **no reason and no history** —
`closedAt` / `closedBy` only. Recommended fix: an **append-only
`PeriodReopenLog`** (entity, book, period, reason, approver, timestamp) rather
than mutating `PeriodClose`. This keeps the hot-path "is it closed?"
`findUnique` on the composite key untouched and matches the SOC 2 append-only
posture (`audit_log` DB-RULE precedent, migration 0015).

### A4 · "Why did this balance change?" lineage view (S–M · no schema change)
Read-only report that walks `reversalOfId` + `correctionOfId` (from A2) +
`RecordEvent` to show the full correction lineage of any account balance
movement. Pure read.

### Not in Half A: "void unposted documents"
Codex lists this under corrections, but `postJournalEntry` always writes
`status: "POSTED"` (never `DRAFT`), so there is **nothing unposted to void** at
the ledger layer. The concept only exists once documents carry a
draft → approved → posted lifecycle — which is Half B. This is independent
confirmation that the split is real, not cosmetic.

---

## Half B — Native transaction documents (Layer 4 → consumer repo)

The canon already specifies the shape, so this is well-defined **once placed**:

- Separate tables `invoice` / `bill` / `payment` / `credit_memo`, each sharing
  the **same first ~12 columns** (entity, book, doc_date, posting_date, party,
  currency, status, totals, FK to the GL entry) so a `document_v` union view
  works for cross-document reporting (canon lines 62–65).
- Each document **posts through `postJournalEntry`** and **creates** an AR/AP
  open item — it *is not itself* the open item (canon line 121). Settlement
  flows through `ArApplication` / `ApApplication`, exactly as
  `apply-ap-payment.ts` does today.
- Lifecycle draft → approved → posted → voided / reversed, preserving the
  "AI suggests, humans approve, the system posts" boundary (CLAUDE.md #3).

### The blocker is placement, not design
The canon assigns Layer-4 document tables to a **consumer** repo. Today the
`personal-books/app` checkout *mirrors* ledger-core's schema, so "documents for
personal books" is genuinely ambiguous:

- a **new app-layer consumer** that depends on ledger-core's `postJournalEntry`
  + AR/AP sub-ledger APIs, **or**
- **personal-books-the-app** has diverged into being that consumer.

This is a repo-topology intent that cannot be inferred from the code. Adding
document tables to `ledger-core/schema.prisma` is off the table (violates the
locked build order). **Half B does not start until this is decided. Half A does
not depend on it.**

---

## Recommended first slice

**A2 — correcting-entry + reclassification.** One small additive migration
(`correctionOfId`), one Server Action extending the proven reverse pattern, one
invariant test, one UI entry point. Highest-frequency real correction, fully
in-canon, stays inside `postJournalEntry`. Stop and evaluate before A3 or Half B.

---

## Guardrails any implementation must clear

(Standing rules from `CLAUDE.md` + `docs/universal-schema.md`.)

- All ledger writes go through `postJournalEntry` — no exceptions.
- `tenantId` on any new table + application-level `WHERE tenantId` scoping
  derived from session (`getCurrentScope()` / `requireCurrentTenant()`), never
  client input. RLS is Phase 1 only — do not assume policies enforce it.
- One audit row per privileged mutation (`auditPrivilegedAction`).
- New self-links on `JournalEntry` must respect the anti-patterns list;
  `correctionOfId` mirrors the sanctioned `reversalOfId` shape.
- Reversible migration **and** idempotent mirror DDL in
  `prisma/sql/migration-mirror.sql` (CI uses `prisma db push`, which skips
  migration SQL); refresh the schema fingerprint.
- New accounting logic gets an invariant test against real Postgres;
  self-healing `beforeAll` prefix scrub per the testing rules.
- Money math via `decimal.js` only.

---

## Open decisions (owner)

1. **Half B placement** — new app-layer consumer, or personal-books-the-app as
   the consumer that owns documents? (Unblocks Half B; Half A is independent.)
2. **First slice go/no-go** — build A2 (correcting-entry + reclass) as a single
   scoped slice, then re-evaluate?

## Related open threads (context)

Two verification threads from the review that preceded this scoping remain open
and should close before either half becomes code:

- Codex round-4 re-verify of `src/lib/assistant/read-only-db.ts` at `08a7a68`.
- An independent DB-mutating full-suite run on an isolated Postgres (this clone
  holds real books, so it cannot be run here; CI's ephemeral Postgres is green).
