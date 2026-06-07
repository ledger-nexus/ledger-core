# NetSuite multi-subsidiary import — design

**Status:** Phase 1 design · **Author:** Claude (with Chris) · **Created:** 2026-06-06

## Problem

The v0.6 NetSuite mapper collapses every imported transaction into a **single** `LegalEntity` (the caller passes one `entityCode`). NetSuite is multi-subsidiary by design — a real NS export from a OneWorld-licensed customer has 5-50 subsidiaries arranged in a hierarchy, with elimination subs at the parent level and per-subsidiary currency.

Today's importer:

```typescript
await importFromNs(prisma, {
  entityCode: "ACME",          // ← everything lands in this one entity
  bookCode: "US_GAAP",
  export: nsExport,
});
```

Every transaction (Invoice 10001 sub=1, JE 50001 sub=2, …) hits the same ledger-core entity. Consolidation can't run because there's nothing to consolidate.

This proposal wires the NS importer through to the **multi-entity consolidation** infrastructure already shipped in v1.0 (`getConsolidatedTrialBalance` + IC elimination). The unlock is end-to-end:

> Drop in a real NS export with 3 subsidiaries → get a consolidated trial balance with intercompany eliminations in the UI, no manual entity setup.

## Goals

1. **Each NS Subsidiary becomes its own ledger-core LegalEntity.** Hierarchy preserved via `parentEntityId`.
2. **Transactions route to the correct entity.** Every `Invoice`, `VendorBill`, `JournalEntry`, etc. has a `subsidiary` field already; route accordingly.
3. **Elimination subs are marked.** NS `iselimination: true` subsidiaries get a flag the consolidation engine can recognize.
4. **Backward compat.** Existing callers passing `entityCode` (single-sub mode) still work.
5. **Roundtrip preserved.** `exportToNs` reconstructs the multi-sub structure from the entity hierarchy + lineage.

## Non-goals (deferred)

- **Multi-currency consolidation.** Each subsidiary may have its own functional currency in NS. The substrate has three-currency support but no FX revaluation engine yet. For Phase 1, all subs use the import-time `bookCode`'s currency. Multi-currency comes in a follow-up arc.
- **Per-subsidiary book overrides.** NS Accounting Books can mean different accounts per book per sub. Same deferral as multi-currency — that's the NS Accounting Books arc.
- **Eliminating elimination subs in our consolidation.** Currently `getConsolidatedTrialBalance` eliminates intercompany via account-subtype rules (DUE_FROM/DUE_TO_AFFILIATE, INTERCOMPANY_REV/EXP). NS-style elimination subs are a different pattern; treating them as a regular entity is fine for v0.7 and the existing IC subtype logic still catches IC accounts.

## Design

### Input shape

Add an optional `entityCodeMapping` discriminator to `ImportFromNsInput`:

```typescript
export type EntityResolution =
  | { mode: "single"; entityCode: string }
  | { mode: "multi"; entityCodePrefix: string };

export interface ImportFromNsInput {
  // Multi-subsidiary resolution. The caller picks how to derive ledger-core
  // entity codes from NS Subsidiary records.
  entityResolution?: EntityResolution;

  // BACKWARD COMPAT: passing entityCode is equivalent to:
  //   { mode: "single", entityCode }
  entityCode?: string;

  bookCode?: string;
  export: NsExport;
  mappingVersion?: string;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
}
```

Resolution algorithm:

| Mode | Subsidiary internalid | Resulting entityCode |
|---|---|---|
| `single` | (ignored) | `entityCode` (literal) |
| `multi`, prefix `"ACME"` | `1` | `ACME_NS1` |
| `multi`, prefix `"ACME"` | `2` | `ACME_NS2` |

Single mode collapses everything to one entity (current behavior). Multi mode honors the `subsidiary` field on each transaction.

### Schema

LegalEntity already has the fields we need: `parentEntityId`, `code`, `name`, `tenantId`. No migration required for the v0.7 cut.

A follow-up PR will add `isEliminationEntity Boolean @default(false)` so the consolidation engine can recognize NS-style elimination subs. For Phase 1 we tag elimination subs in `extensions JSONB` (`{"nsIsElimination": true}`) and defer the column.

### Orchestrator changes

`importFromNs` gains a new `setupSubsidiaries` step that runs first:

```
setupCustomFields →
setupSubsidiaries →            ← NEW
setupDimensions →
importAccounts →
importParties →
importItems →
importJournalEntries →
importInvoices → importVendorBills →
importCustomerPayments → importVendorPayments
```

`setupSubsidiaries` walks the `NsExport.Subsidiary[]` array, resolves each to a ledger-core entityCode, and upserts the LegalEntity (idempotent — re-running the importer is safe).

For each subsidiary, the orchestrator also computes the parent entity from `Subsidiary.parent.internalid` and sets `parentEntityId` after the parents exist. Two-pass: first pass creates all entities flat; second pass wires parent links.

### Per-transaction entity routing

Every `importInvoices` / `importVendorBills` / `importJournalEntries` / etc. step today reads a single `entity` resolved at the top of `importFromNs`. After this change, each step reads the transaction's `subsidiary` field, looks it up in the subsidiary-to-entity map built by `setupSubsidiaries`, and posts the JE to that entity.

Same lineage triple. Same `sourcePayload`. Same `bookCode` (until the NS Accounting Books arc lands). The only thing that changes is the `entityId` on each JE.

### Reverse export

`exportToNs` reconstructs the Subsidiary array from the entity hierarchy:

1. Find all `LegalEntity` rows where `extensions.nsIsImported === true` (set during import)
2. For each, emit a `Subsidiary` record with the original `internalid` (from `sourceRecordId`)
3. Each transaction lookup remembers which entity its JE landed in, restores `subsidiary` field accordingly

The existing roundtrip test pattern (`diffNsExports`) extends to cover multi-sub.

## Test plan

### Unit tests (this PR)

- `mapSubsidiary` (pure) — covers parent-ref handling, missing parent, elimination flag
- `setupSubsidiaries` (orchestrator step) against an in-memory mock prisma — covers two-pass parent wiring, idempotency

### Integration tests (follow-up PR)

- Expand the NS fixture to a 3-subsidiary group: parent + 2 children (one US, one UK)
- Add transactions across subs including an IC transfer (US sub bills UK sub)
- Run `importFromNs` in multi mode → assert 3 LegalEntity rows created with right hierarchy
- Run consolidation report at parent → assert IC accounts net to zero
- Run reverse export → assert roundtrip equivalence

## Demo story enabled by this arc

After Phase 1 + Phase 2 land:

> "We dropped a real OneWorld NS export from a 3-subsidiary group into ledger-core. With one importer call we got 3 entities, full hierarchy, all transactions routed correctly. The consolidated trial balance reconciles to NS's own consolidated view, including intercompany eliminations. No manual entity setup. No spreadsheets."

That's a 30-second sales clip.

## What ships in Phase 1 (this PR)

- This design doc
- `NsSubsidiary` type already exists (v0.6)
- `mapSubsidiary` pure mapper in `src/lib/mappers/netsuite/subsidiaries.ts`
- `setupSubsidiaries` orchestrator step (file-local for now, no public API yet)
- Backward-compat `entityResolution?` discriminator on `ImportFromNsInput`
- 8-10 unit tests covering mapper + orchestrator
- tsc clean

## What ships in Phase 2

- Fixture expansion (3-sub group with IC)
- Integration tests vs real Postgres
- Per-transaction routing through all import steps
- Reverse exporter handles multi-sub
- `/import/netsuite` UI gains an "entity resolution" toggle
- `isEliminationEntity` column migration (deferred behind a flag)

## Open questions

1. **Code collision risk** — `ACME_NS1` is fine, but if the operator already has a `ACME_NS1` entity for another reason, the importer would silently upsert into it. The composite `[tenantId, code]` unique constraint on LegalEntity catches genuine collisions at the schema level, but the upsert-on-match-by-code is intentional (so re-running the importer is idempotent). **Recommendation:** lean into upsert; document that operators choose `entityCodePrefix` to avoid collisions.
2. **Currency mismatch** — NS sub has `currency: "GBP"`, but the bookCode imports under `US_GAAP` (USD). For Phase 1, we ignore the sub's currency and post everything in the bookCode's currency. **Recommendation:** add a warning to import-result `warnings[]` array when a sub's currency ≠ bookCode's currency; defer real handling to the multi-currency arc.
3. **Parent missing in same export** — NS sometimes exports a subsidiary whose parent record isn't in the same JSON (partial export). **Recommendation:** treat as top-level (null `parentEntityId`); add to `warnings[]`.
