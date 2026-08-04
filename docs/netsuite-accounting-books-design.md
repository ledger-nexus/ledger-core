# NetSuite Accounting Books import — design

**Status:** Phase 1 design · **Author:** Claude (with Chris) · **Created:** 2026-06-08

## Problem

After v0.7 NS multi-sub + v0.8 ASC 830 FX translation landed, the NS importer handles one ERP axis — entities — through to consolidation. The other NS structural axis is **Accounting Books**: real OneWorld NS tenants carry multiple books per company (US_GAAP, US_TAX, IFRS, MGMT, etc.), and each book represents an independent GL view with potentially different numbers, rates, and classifications.

Today's importer:

```typescript
await importFromNs(prisma, {
  entityResolution: { mode: "multi", entityCodePrefix: "ACME" },
  bookCode: "US_GAAP",        // ← collapses everything into ONE book
  export: nsExport,
});
```

Every transaction lands in ONE ledger-core book. ledger-core's substrate already supports parallel-posting (Pattern 2 multi-book) — `postJournalEntry` posts to ONE `(entity, book)` at a time, callers ring it N times for N books. But the NS importer never exercises this: it hardcodes one `bookCode`.

For real NS exports with book-specific numbers, the consequence is silent data loss. A tax book that depreciates an asset over 5 years (MACRS) where GAAP uses 7 years (SL) — only one of those depreciation patterns lands. The Book-Tax-Difference report (already shipped) has nothing to compare against.

This proposal wires the NS importer through to the **multi-book parallel posting** infrastructure. The unlock:

> Drop in an NS OneWorld export with US_GAAP + US_TAX books → both ledger-core books populated with their own book-specific numbers → BTD report shows the divergence the operator's NS tenant already records.

## Goals

1. **Each NS AccountingBook maps to a ledger-core Book.** Operator can configure the mapping (NS "1" / "US GAAP" → ledger-core `US_GAAP`).
2. **Per-transaction book-specific data is read.** NS transactions carry a `bookspecific[]` array with per-book `exchangerate`, sometimes per-book amounts. The mapper passes these through.
3. **Each transaction posts to N books in parallel.** Same lineage triple `(sourceSystem, sourceRecordType, sourceRecordId)`, but per-book `(entityId, bookId)` — the lineage unique index respects book scope so per-book posting works without conflict.
4. **Backward compat.** Existing `bookCode: "US_GAAP"` (single-book mode) callers keep working. New `bookResolution` discriminator opts into multi-book.
5. **Roundtrip preserved.** `exportToNs` reads the per-book JEs back, reconstructs `bookspecific[]` per transaction.

## Non-goals (deferred to follow-up phases)

- **Book-specific account mappings.** NS sometimes lets the same GL account class map to different account codes per book (rare). Phase 1 assumes account codes are the same across books. Phase 4 polish if a real export requires it.
- **Adjustment-only books.** NS has "adjustment-only" books (e.g. a US_TAX_ADJ that only posts deltas vs US_TAX). Phase 1 treats `isadjustment` as metadata only; no special posting logic.
- **Per-book lines on a single JE.** Some NS exports flatten per-book differences into a single JE row with separate `bookspecific` line arrays. Phase 1 unflattens these into N separate JEs (one per book) — simpler architecture, matches ledger-core's "one JE per (entity, book)" rule.
- **NS Books with different reporting currencies.** Each book in NS can have its own functional currency. Phase 1 assumes all books share the entity's functional currency; multi-book multi-currency is a Phase 4+ topic.

## Design

### Phase 1 input shape

Add an optional `bookResolution` discriminator to `ImportFromNsInput`:

```typescript
export type BookResolution =
  | { mode: "single"; bookCode: string }
  | { mode: "multi"; bookMapping: Record<string, string> };
  //                          ^ NS internalid → ledger-core book code

export interface ImportFromNsInput {
  bookResolution?: BookResolution;
  /** BACKWARD COMPAT: passing bookCode is equivalent to {mode: "single", bookCode}. */
  bookCode?: string;
  // ... rest unchanged
}
```

Resolution behavior:

| Mode | NS book internalid | Resulting ledger-core book |
|---|---|---|
| `single` | (ignored) | `bookCode` (literal) |
| `multi`, mapping `{1: "US_GAAP", 2: "US_TAX"}` | `1` | `US_GAAP` |
| `multi`, missing mapping | `3` | warning + skip |

### Schema

ledger-core's `Book` model already has what we need: `code` (e.g. `US_GAAP`), `basis`, `reportingCurrencyId`, `isActive`. No migration required.

`JournalEntry` is already keyed by `(entityId, bookId)` and the lineage unique index is `(sourceSystem, sourceRecordType, sourceRecordId, tenantId)` only — so the same NS transaction CAN have two JEs (one per book) without conflict, as long as those JEs have different `bookId`. **Open question:** verify the lineage unique constraint scope in Phase 1 implementation — if it currently includes book, we need a migration to drop and re-add scoped to `(tenantId, bookId, sourceSystem, sourceRecordType, sourceRecordId)`.

### Orchestrator changes

`importFromNs` gains a new `setupBooks` step that runs first (right after `setupSubsidiaries`):

```
setupCustomFields →
setupSubsidiaries →           (v0.7)
setupBooks →                  ← NEW
setupDimensions →
importAccounts →
importParties →
importItems →
importJournalEntries →
importInvoices → importVendorBills →
importCustomerPayments → importVendorPayments
```

`setupBooks` walks the `NsExport.AccountingBook[]` array, resolves each to a ledger-core book code via the mapping, and verifies the target Book row exists. Throws `BookNotMappedError` if multi-mode + NS book has no mapping entry (operator-actionable: "add `bookMapping: { '3': 'IFRS' }` to your input").

### Per-transaction routing

Every postJournalEntry callsite today picks `bookCode` once. After this change:

- **Single mode** — call postJournalEntry ONCE per transaction with the named book (current behavior).
- **Multi mode** — for each NS book mapped to a ledger-core book, call postJournalEntry ONCE per (transaction, book) pair. Same lineage triple every time; per-book `bookCode` differs.

When a transaction's `bookspecific[]` array has per-book FX rates, the mapper plumbs the right `exchangerate` to each per-book post. When `bookspecific` is absent, all books use the same rate (the `exchangerate` on the transaction header).

### Reverse export

`exportToNs` reconstructs per-NS-book transactions from the ledger-core JEs. For each `sourceRecordId`, find ALL JEs sharing that lineage (across books), reconstruct `bookspecific[]` from the per-book frozen `sourcePayload`. The same byref-preservation pattern as v0.7 multi-sub.

## Test plan

### Unit tests (this PR)

- `mapNsBook` (pure) — name normalization, basis derivation
- `resolveBookCode` (pure) — single mode literal, multi mode mapping, missing-mapping handling
- `setupBooks` (orchestrator step) — happy path (all NS books mapped), missing mapping (warning), book row doesn't exist in ledger-core (fatal)

### Integration tests (Phase 2)

- Expand the multi-sub fixture to add `AccountingBook[]` + `bookspecific[]` on transactions
- Run `importFromNs` in multi-book mode → assert N×K JEs created (N transactions × K books)
- Verify BTD report on the imported entity shows divergence between US_GAAP and US_TAX

## Demo story enabled by this arc

After Phase 1-3 land:

> "We dropped a real NS OneWorld export with US_GAAP + US_TAX books from a 3-subsidiary group. With one importer call we got 3 entities × 2 books = 6 GL views. The Book-Tax-Difference report shows the depreciation divergence the operator's NS already records. Multi-entity × multi-book consolidation × multi-currency translation, all from one ERP export."

That's a 45-second sales clip.

## What ships in Phase 1 (this PR)

- This design doc
- `NsAccountingBook` + `NsBookSpecific` types in `src/lib/mappers/netsuite/types.ts`
- `mapNsBook` pure mapper
- `resolveBookCode` pure helper
- `BookResolution` discriminator
- `setupBooks` orchestrator step (file-local for now, no public API yet)
- 10+ unit tests covering mapper + orchestrator
- tsc clean

## What's deferred to Phase 2+

- Per-transaction book-specific routing through the importer
- Fixture expansion + integration tests
- Reverse exporter for multi-book
- UI book-mapping editor
- Adjustment-only book semantics
- Per-book account mappings

## Open questions

1. **Lineage unique index scope** — does the current `(sourceSystem, sourceRecordType, sourceRecordId)` index already include book scope, or does Phase 2 need a migration? Verify before Phase 2 lands.
2. **Adjustment-only books** — defer behavior to a future phase; mark `isadjustment` in `extensions` so the operator can filter on it.
3. **Book mapping configuration** — Phase 1 takes it as a hardcoded input field. Phase 4 polish: UI editor that learns from prior imports.
