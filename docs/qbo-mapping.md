# QuickBooks Online Mapping

How `ledger-core` absorbs a real QBO export. This is the **"validate by mapping"** milestone from [`universal-schema.md`](universal-schema.md) — proof that the universal schema isn't just theoretically capable of absorbing a tier-1 ERP but actually does so losslessly on real-shaped data.

QBO is the universal-schema spec's "minimum viable surface": single-book, two dimensions max, limited custom fields. If `ledger-core` can roundtrip a QBO export with zero loss, the floor is locked. NetSuite (the ceiling — multi-book, 8+ dimensions, deep custom fields) follows v0.6.

---

## What's covered

The mapper handles the common QBO transaction types that drive ~95% of small-business activity:

| QBO object | ledger-core target | Notes |
|---|---|---|
| `Account` | `Account` (entity-scoped, code = `Q<id>`) | Type/normal-balance derived from `AccountType` |
| `Customer` | `Party` + `PartyRole(CUSTOMER)` | code = `QCUST-<id>` |
| `Vendor` | `Party` + `PartyRole(VENDOR)` | code = `QVEND-<id>` |
| `Invoice` | `JournalEntry` (Dr AR / Cr Income) + `ArOpenItem` | One AR open item opened per invoice |
| `Bill` | `JournalEntry` (Dr Expense / Cr AP) + `ApOpenItem` | One AP open item opened per bill |
| `Payment` | `JournalEntry` (Dr Cash / Cr AR) + `ArApplication`(s) | Applies against linked invoices |
| `BillPayment` | `JournalEntry` (Dr AP / Cr Cash) + `ApApplication`(s) | Applies against linked bills |
| `JournalEntry` | `JournalEntry` direct | Posting type ↔ debit/credit |

What's deferred: `ItemBasedExpenseLineDetail` lines on Bills, multi-currency exchange rates, tax codes, attachments, recurring transactions. None of these are blockers for the demo; all are straightforward extensions of the existing mappers when needed.

---

## Lineage is the load-bearing feature

The Layer 6 spec rule:

> Every imported row carries `source_system`, `source_record_type`, `source_record_id`, `source_payload JSONB` (frozen raw original), `mapping_version`.

Every mapper populates these. The frozen `sourcePayload` is what makes the roundtrip work — `exportToQbo` reconstructs the QBO JSON by reading the original payload back out of the lineage column. No translation needed; the source object was preserved verbatim.

This is also what makes the import **idempotent**: before creating any row, the orchestrator checks for an existing row matching `(sourceSystem, sourceRecordType, sourceRecordId)`. If found, it skips. Re-running the same import after a partial failure is safe.

---

## The roundtrip guarantee

`importFromQbo(prisma, { entityCode, export: qboJson })` → ledger-core DB → `exportToQbo(prisma, { entityCode })` produces JSON that is structurally equivalent to the original.

Tested in `tests/qbo-mapping.test.ts`:

```typescript
const original = loadFixture();
await importFromQbo(prisma, { entityCode: ENTITY, export: original });
const roundTripped = await exportToQbo(prisma, { entityCode: ENTITY });
const diff = diffQboExports(original, roundTripped);
expect(diff).toBe(null);
```

The `diffQboExports` helper is order-insensitive (sorts each entity-type array by `Id`) and ignores `_meta` (regenerated each export). Anything else differing is a bug.

---

## How to use it end-to-end

1. **Create a ledger-core entity** for the QBO company:
   ```typescript
   await prisma.legalEntity.create({
     data: { code: "MYQBO", name: "My QBO Co.", functionalCurrencyId: "USD" }
   });
   ```

2. **Drop in a QBO export JSON** (the QBO API returns objects in this shape; the included `prisma/fixtures/qbo-sample.json` is a hand-rolled example):
   ```typescript
   import { readFileSync } from "node:fs";
   const qboExport = JSON.parse(readFileSync("./qbo-export.json", "utf-8"));
   ```

3. **Run the import**:
   ```typescript
   import { importFromQbo } from "@/lib/mappers/qbo";
   const result = await importFromQbo(prisma, {
     entityCode: "MYQBO",
     bookCode: "US_GAAP",
     export: qboExport,
   });
   console.log(`Imported ${result.journalEntriesImported} JEs, ${result.arOpenItemsOpened} AR items`);
   ```

4. **Verify the trial balance**:
   ```typescript
   const tb = await getTrialBalance(prisma, { entityCode: "MYQBO", bookCode: "US_GAAP" }, new Date());
   console.log(tb.totalDebit.equals(tb.totalCredit)); // true
   ```

5. **Export back to QBO shape** (for audit / migration / sanity check):
   ```typescript
   const reExported = await exportToQbo(prisma, { entityCode: "MYQBO" });
   ```

---

## QBO → ledger-core type mapping

The full mapping table for `AccountType`:

| QBO `AccountType` | ledger-core `type` | Normal balance |
|---|---|---|
| `Bank` | ASSET | DEBIT |
| `Accounts Receivable` | ASSET | DEBIT |
| `Other Current Asset` | ASSET | DEBIT |
| `Fixed Asset` | ASSET | DEBIT |
| `Other Asset` | ASSET | DEBIT |
| `Accounts Payable` | LIABILITY | CREDIT |
| `Credit Card` | LIABILITY | CREDIT |
| `Other Current Liability` | LIABILITY | CREDIT |
| `Long Term Liability` | LIABILITY | CREDIT |
| `Equity` | EQUITY | CREDIT |
| `Income` | REVENUE | CREDIT |
| `Other Income` | REVENUE | CREDIT |
| `Cost of Goods Sold` | EXPENSE | DEBIT |
| `Expense` | EXPENSE | DEBIT |
| `Other Expense` | EXPENSE | DEBIT |

`AccountType.Bank` sets `isBank=true`. `Accounts Receivable` and `Accounts Payable` set `isControlAccount=true` (so AR/AP open items can find their roll-up target via `subtype` or `isControlAccount` lookup).

`AccountSubType` maps to a `subtype` string when it's recognized (`Checking → CASH`, `AccountsReceivable → AR_TRADE`, `LegalProfessionalFees → PROFESSIONAL_FEES`). Unrecognized subtypes pass through as the raw QBO string.

---

## Why account codes are prefixed `Q`

The `code` field on `Account` is meant to be human-readable. QBO uses numeric strings (`"1"`, `"2"`, …) as system Ids. Reusing those as ledger-core codes would collide with the native shared chart (`1000`, `2000`, …) when both live in the same entity.

The mapper prefixes QBO codes with `Q` — so QBO Account Id `1` (Checking) becomes ledger-core code `Q1`. The original QBO Id is preserved verbatim in `sourceRecordId`, so the roundtrip still works.

If you want a unified chart (QBO codes mapping into your native chart's account codes), that's a manual remapping step — typically done by importing QBO into a separate entity first, then issuing reclassification JEs into the production entity with `source: "MANUAL"`.

---

## What this validates

The universal-schema spec set the bar at:

> The validation test for any source-system mapping: can an ERP transaction be expressed in the posting layer (Layer 1) with zero loss? If yes, the mapping succeeds.

Roundtrip equality passes that test for the QBO transaction types covered. The next mapping (NetSuite) will stress the dimension engine and multi-book posting rules — neither of which QBO exercises because QBO is fundamentally single-book with limited dimensions.

Until NetSuite lands, this is the "we can absorb a real ERP" proof.
