# NetSuite Accounting Books — sub-ledger multi-book (Phase 3.5) design

**Status:** Phase 3.5 design · **Author:** Claude (with Chris) · **Created:** 2026-06-08

## Problem

The v0.9 NS Accounting Books arc shipped multi-book parallel posting for **journal entries** (Phase 3) plus reverse-export roundtrip preservation (Phase 4 + Phase 4.5) and the UI book-mapping editor (Phase 5). But the four sub-ledger paths in the NS importer (Invoice, VendorBill, CustomerPayment, VendorPayment) still hardcode `primaryBookCode`:

```typescript
// src/lib/mappers/netsuite/import.ts — current state (post-Phase 3)
const primaryBookCode = bookCodesToQuery[0]!; // first mapped book

// 4 sub-ledger paths use primaryBookCode only:
await openArItem(prisma, {
  bookCode: primaryBookCode,  // ← non-primary books lose AR detail
  ...
});
```

When an operator declares `bookMapping: { "1": "US_GAAP", "2": "US_TAX" }`:
- ✅ Phase 3 wires JEs through: each NS JournalEntry posts to BOTH books (two ledger-core JEs, both lineage-tracked).
- ❌ Phase 3.5 gap: each NS Invoice creates ONE `ArOpenItem` on `US_GAAP` only. The `US_TAX` book has no AR detail — but the JE that posted the AR debit to `US_TAX` is there, dangling. The aging report on `US_TAX` shows zero AR; the GL on `US_TAX` shows full AR.

Sub-ledger lifecycle drives the AR/AP open-items + applications stream that the aging reports, payment-application Server Actions, and dashboard AR/AP cards consume. None of those readers are book-aware today either, because the substrate hasn't required it.

This design captures the **bounded but not small** lift to close the gap:

> Drop in an NS OneWorld export with US_GAAP + US_TAX → both books carry their own ArOpenItem/ApOpenItem rows → aging reports on US_TAX show the same AR detail as US_GAAP → BTD report stays balanced through to sub-ledger level.

## Goals

1. **Each sub-ledger row scopes to `(entity, book)`.** AR/AP open items and applications are book-aware, mirroring how `FixedAsset` already splits into `FixedAssetBookAttributes` (per-book row).
2. **NS importer writes per-book sub-ledger rows.** When the operator declares `bookMapping` with N books, each NS Invoice creates N `ArOpenItem` rows (one per book), same lineage triple, distinct `(entity, book)` scope.
3. **Application logic respects book scope.** When a payment applies to an invoice, the application happens on the BOOK that the payment posted to; cross-book application is a contract error.
4. **Aging readers filter by book.** `arAging()` and `apAging()` accept `bookCode` (or derive from the active scope cookie). The current shape stays for callers that don't pass it (defaults to the cookie scope).
5. **Backward compat.** Existing single-book imports continue to write exactly ONE row per Invoice/Bill — no schema-level surprise. Pre-Phase-3.5 rows backfill to the primary book during migration.

## Non-goals (deferred to follow-up phases)

- **Book-specific payment splits.** When an NS payment partially applies on one book and fully applies on another (rare — usually books agree on settlement), Phase 3.5 routes the application to ALL mapped books symmetrically. Asymmetric application is a Phase 4+ topic.
- **Cross-book offsets.** A payment that settles a `US_GAAP` invoice with a `US_TAX` credit memo is a contract error in this design.
- **Book-specific aging buckets.** The 30/60/90 bucketing logic is global. Per-book bucketing (different overdue thresholds per book) is operator preference, not architectural.
- **Sub-ledger reverse export.** The current `exportToNs` doesn't include sub-ledger detail (it emits Account/Party/Item/JE + dimensions). Sub-ledger reverse export is a separate arc.

## Design

### Schema additions

Two new columns + one migration. Mirrors how `FixedAssetBookAttributes` works today (the lease + revenue contract path also has a per-book attributes table — sub-ledger is just AR/AP doing the same thing).

```prisma
model ArOpenItem {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId        String
  entityId        String
  // NEW: book scope. Required after migration. Backfilled from
  // the primary book of the (entity, sourceSystem) bucket.
  bookId          String
  book            Book     @relation(fields: [bookId], references: [id], onDelete: Restrict)

  customerId      String?
  invoiceNumber   String
  ...

  // Per-(tenant, entity, book, invoiceNumber) — the unique key
  // expands to include bookId. Same NS invoice on two books =
  // two rows, both pointing at the same source lineage triple.
  @@unique([tenantId, entityId, bookId, invoiceNumber])
}

model ApOpenItem {
  // Same shape: + bookId, + book relation, + unique key expansion.
  ...
}
```

The `ArApplication` and `ApApplication` tables don't need direct book columns — applications point at OpenItem rows, which already carry book scope. But the application **logic** must enforce that the AR application's payment-side JE posted to the same book as the open item it's applying to.

> **Port note (2026-06-11):** this design predates the merge train. Migration numbers below are chain-era labels — main's sequence is at 0017 (`ns_iselimination_entity_column`), so Phase 3.5's migration will take the next free number at implementation time. The per-book JE idempotency this design assumes is ALREADY on main (landed with Phase 3 #156: tenant-scoped `importedBookCodes`, per-book resume); only the sub-ledger half remains open.

### Migration 0011 (proposed; will renumber at implementation)

Idempotent SQL that:

1. Adds `bookId` as nullable column (so existing rows survive the migration).
2. Backfills: for each existing row, derive the primary book from:
   - Same-tenant `Book.code = "US_GAAP"` if present (the legacy default).
   - Otherwise the entity's primary book per `LegalEntity.extensions.nsPrimaryBookCode` (currently unused — see migration backfill spec).
   - Otherwise the first active `Book` row for the tenant.
3. Enforces NOT NULL after backfill.
4. Drops the old `(tenantId, entityId, invoiceNumber)` unique constraint.
5. Creates the new `(tenantId, entityId, bookId, invoiceNumber)` unique constraint.

The backfill is the riskiest step. Two safety guards:

- **Operator must declare an explicit primary book** when running the migration on a production database with existing ArOpenItem rows. The migration refuses to NOT-NULL the column without that declaration (via a CHECK constraint pre-flight or a `DO $$ DECLARE missing INT$$` block that aborts).
- **Cross-tenant collision check**: before enforcing NOT NULL, verify no `(tenantId, entityId, invoiceNumber)` group has rows with different inferred book IDs. Such a group is a data integrity bug pre-existing the migration and must be resolved by the operator.

### Importer changes (`src/lib/mappers/netsuite/import.ts`)

The 4 sub-ledger paths become per-book loops, matching the JE path that already does this in Phase 3:

```typescript
// CURRENT (post-Phase 3):
const primaryBookCode = bookCodesToQuery[0]!;
for (const inv of invoices) {
  await openArItem(prisma, {
    bookCode: primaryBookCode,  // ← drops non-primary books
    ...
  });
}

// AFTER (Phase 3.5):
for (const inv of invoices) {
  for (const perBookCode of bookCodesToQuery) {
    await openArItem(prisma, {
      bookCode: perBookCode,  // ← per-book row
      // Same lineage triple — distinct (entity, book) scope makes
      // the row unique within the new constraint.
      sourceSystem: "NETSUITE",
      sourceRecordType: "Invoice",
      sourceRecordId: inv.internalid,
      ...
    });
  }
}
```

Same pattern for `VendorBill`, `CustomerPayment`, `VendorPayment`. The lineage triple stays the same (one NS Invoice = one source record); the `(entity, book)` scope changes per loop iteration.

`postJournalEntry` is already book-aware. The lineage-uniq index added in Phase 2 (PR #155) already scopes `(tenantId, bookId, sourceSystem, sourceRecordType, sourceRecordId)` correctly, so per-book sub-ledger writes match the per-book JE writes that already work.

### Reader changes

**Aging reports** (`arAging`, `apAging`):
- Add optional `bookCode?: string` parameter. When absent, derive from the active scope cookie (Server Component reads the cookie via `getScope()` and forwards).
- The `where` clause adds `book: { code: bookCode }` to the OpenItem query.
- CSV exports include the book code in the filename.

**Payment-application Server Actions** (`applyArPayment`, `applyApPayment`):
- Add a runtime check: the payment-side JE's `bookId` must match the OpenItem's `bookId`. Throw a typed error on mismatch (`CrossBookApplicationError`) — the application UI surfaces it as an operator-actionable message.
- For multi-book payments (one NS payment mapped to N books), the Server Action iterates per book — same lineage, same applied-amount, distinct `(entity, book)` scope.

**Dashboard cards**:
- AR/AP card components read from the active scope cookie's book code. Already filter by entity; the new filter is `(entity, book)`.

### Discovery + warning surface

When the operator imports a multi-book NS export:
- If `bookspecific[].sublederaccount` differs per book on the SAME invoice, the importer surfaces a warning. (Real exports rarely do this — usually the AR control account is the same across books.) The warning lists the affected lineage IDs so the operator can investigate.
- Existing sub-ledger rows that pre-dated Phase 3.5 (pre-migration) have their `bookId` backfilled to the primary book at migration time. The importer doesn't re-derive on re-import; the lineage triple's first write wins.

## Phasing

### Phase 3.5.A — schema + migration (1 PR)

- Prisma schema changes: `ArOpenItem.bookId`, `ApOpenItem.bookId`, plus relations + unique constraint updates.
- Migration `0011_ns_books_sub_ledger_book_scope/migration.sql` with idempotent SQL.
- Pre-flight validation script in `prisma/migrations/0011_*/precheck.sql` that aborts cleanly if cross-tenant collisions exist.
- Unit test that verifies the migration is idempotent + the backfill picks the right book.

### Phase 3.5.B — importer per-book sub-ledger loop (1 PR)

- 4 sub-ledger paths in `import.ts` wrap their `openArItem` / `openApItem` / `applyArPayment` / `applyApPayment` calls in the per-book loop, mirroring the JE path from Phase 3.
- Integration test mirroring `netsuite-accounting-books-routing.test.ts`: multi-book NS Invoice produces N ArOpenItem rows; idempotent re-runs don't duplicate.

### Phase 3.5.C — aging reader book-aware (1 PR)

- `arAging` + `apAging` accept `bookCode?` parameter.
- `/reports/ar-aging` + `/reports/ap-aging` pages read from scope cookie's book code.
- CSV exports include book code in filename.
- Aging test verifies a multi-book fixture produces per-book aging numbers.

### Phase 3.5.D — payment-application book-scope guard (1 PR)

- `CrossBookApplicationError` typed error.
- `applyArPayment` + `applyApPayment` runtime check.
- Server Action surfaces the error in the apply form.
- Test: cross-book application attempt fails with the typed error.

### Phase 3.5.E — dashboard + UI book-aware (1 PR)

- `/dashboard` AR/AP cards filter by `(entity, book)`.
- `/ar` + `/ap` apply-payment forms surface the book they're operating on.

## Test plan summary

Each phase ships its own integration test. The end-to-end proof is:

1. Import a 2-entity, 2-book NS export with 5 invoices.
2. Assert `ArOpenItem.count == 10` (5 invoices × 2 books).
3. Assert `arAging({ bookCode: "US_GAAP" })` and `arAging({ bookCode: "US_TAX" })` both return 5 rows.
4. Apply a US_GAAP payment to a US_GAAP invoice — succeeds.
5. Apply a US_TAX payment to a US_GAAP invoice — fails with `CrossBookApplicationError`.
6. Assert the BTD report between US_GAAP and US_TAX has zero AR difference (the open items match up).

## Backward-compat matrix

| Caller shape | Behavior pre-Phase 3.5 | Behavior post-Phase 3.5 |
|---|---|---|
| `bookCode: "US_GAAP"` (single mode) | ArOpenItem on US_GAAP | ArOpenItem on US_GAAP (unchanged) |
| `bookResolution: { mode: "multi", bookMapping: {1: "US_GAAP"} }` | ArOpenItem on US_GAAP only (gap) | ArOpenItem on US_GAAP (one book, one row — unchanged) |
| `bookResolution: { mode: "multi", bookMapping: {1: "US_GAAP", 2: "US_TAX"} }` | ArOpenItem on US_GAAP only (gap, silent data loss) | **ArOpenItem on BOTH books** (Phase 3.5 gap closed) |

The migration backfills existing rows to the primary book of the tenant. No caller needs to change behavior — single-book mode is unchanged, multi-book mode picks up the new rows automatically.

## Risk + open questions

- **Migration backfill correctness**. The primary-book derivation rule above (`US_GAAP` → entity extension → first active book) needs operator verification per tenant. The migration's CHECK + cross-tenant collision detection guards against silent corruption.
- **Reader sweep completeness**. The substrate has many readers of `ArOpenItem` (aging report, dashboard card, apply form, audit log). The phasing splits the reader work across PRs to keep diffs manageable, but the test strategy must verify every reader handles the new scope correctly. A grep audit (`grep -rn "ArOpenItem" src/`) before Phase 3.5.C drives that completeness check.
- **Cross-book settlement contract**. Section 4 of the design proposes throwing `CrossBookApplicationError` on cross-book application. If real NS exports do encode cross-book settlement (an exotic pattern), the error becomes operator-blocking. Mitigation: surface the lineage IDs in the error message so the operator can re-classify the source data.

## Related arcs

- **v0.7 NS multi-subsidiary**: the entity axis. This arc mirrors the same shape on the book axis for sub-ledgers.
- **v0.9 NS Accounting Books (Phase 1-5)**: the JE-axis multi-book work. Phase 3.5 is the sub-ledger extension that's been deferred since Phase 3 shipped.
- **fa-amort `FixedAssetBookAttributes`**: the precedent for per-book sub-ledger attributes. The shape pattern is the same — one physical asset, N per-book rows scoped by `(entity, book)`.
