# NetSuite Mapping

The **ceiling test** companion to [`qbo-mapping.md`](qbo-mapping.md). If QBO mapping proved the floor (single-book, two dimensions max, limited custom fields), NetSuite proves the ceiling — multi-book-ready, **8+ dimensions** modeled via the dimension engine, custom fields on every record, multi-subsidiary aware.

The universal-schema spec set this bar:

> Expressive ceiling (drives max capability): Sage Intacct, NetSuite, SAP S/4HANA, Dynamics F&O — multi-entity, multi-currency, multi-book, 8+ dimensions, deep custom fields/records.

v0.6 makes that bar load-bearing on real-shaped data.

---

## What's covered

| NetSuite record | ledger-core target | Notes |
|---|---|---|
| `Account` | `Account` (entity-scoped, code = `NS<internalid>`) | Type mapping from NS `accttype` |
| `Class` | `Dimension(code="CLASS")` + `DimensionValue` | Built-in NS dimension |
| `Department` | `Dimension(code="DEPARTMENT")` + `DimensionValue` | Built-in |
| `Location` | `Dimension(code="LOCATION")` + `DimensionValue` | Built-in |
| `CustomSegment` | `Dimension(code=<uppercase internalid>)` + values | E.g. `custcol_region` → `CUSTCOL_REGION` |
| `Customer` | `Party` + `PartyRole(CUSTOMER)` | custentity_* → `extensions Json` |
| `Vendor` | `Party` + `PartyRole(VENDOR)` | custentity_* → `extensions Json` |
| `Item` | `Item` | itemtype → ledger-core ItemType |
| `Invoice` | `JournalEntry` + `ArOpenItem` + `DimensionSet` per line | Class/Dept/Loc/custom segments on each line |
| `VendorBill` | `JournalEntry` + `ApOpenItem` + `DimensionSet` per line | |
| `CustomerPayment` | `JournalEntry` + `ArApplication`(s) | Applies to invoices in the `apply[]` array |
| `VendorPayment` | `JournalEntry` + `ApApplication`(s) | Applies to bills |
| `JournalEntry` | `JournalEntry` direct | Line dimensions same as transactions |
| `CustomFieldDefinition` | `CustomFieldDefinition` registry | Marks fields that show up in `extensions Json` |

What's deferred to v0.7+: multi-subsidiary import (Subsidiary records are in the fixture but not imported as multi-entity yet), Item-Based vs Account-Based expense lines on bills, multi-book parallel posting from a single NS transaction (NS Accounting Books).

---

## The dimension engine, finally exercised

`Dimension` / `DimensionValue` / `DimensionSet` / `DimensionSetValue` have been sitting empty since v0.2. NetSuite is what fills them.

Three built-in dimensions (`CLASS`, `DEPARTMENT`, `LOCATION`) get their `Dimension` rows, with one `DimensionValue` per NS internalid. Custom segments (`custcol_region`, etc.) get their own `Dimension` rows keyed by the uppercased internalid.

For each transaction line, the orchestrator:

1. Extracts the assignments — e.g. `{CLASS: "10", DEPARTMENT: "20", LOCATION: "30", CUSTCOL_REGION: "100"}`.
2. Computes a stable hash from the sorted `(dimensionCode, valueCode)` pairs.
3. Looks up `DimensionSet` by hash. If present, reuses it. If not, creates a new `DimensionSet` + `DimensionSetValue` bridge rows for each assignment.
4. Attaches the `dimensionSetId` to the `JournalLine`.

This is **dedup at line scope**: every line in the ledger with identical Class+Dept+Loc+Region shares one `DimensionSet` row. With 100k transactions and ~50 distinct dimension combinations, you have 100k JournalLines pointing at 50 DimensionSets. Aggregating revenue by Department becomes a join through the engine, not a full table scan.

The hash is deterministic and order-insensitive — `dimensionSetHash([CLASS:10, DEPT:20])` equals `dimensionSetHash([DEPT:20, CLASS:10])` — so the dedup works regardless of which order the mapper encounters the assignments.

---

## Custom fields land in `extensions JSONB`

NetSuite supports arbitrary custom fields prefixed `custbody_` (on transactions), `custcol_` (on transaction lines), `custentity_` (on customers/vendors), `custrecord_` (on custom records). The NS mapper:

- Registers each `CustomFieldDefinition` in the `custom_field_definition` table (Layer 5 metadata).
- For each imported record, extracts fields matching the appropriate prefix and stores them as a JSON blob on `extensions`.

Example: customer 5000 has `custentity_industry: "Manufacturing"` in the NS export. After import, the ledger-core `Party` row has `extensions = { "custentity_industry": "Manufacturing" }` and the `CustomFieldDefinition` table has one row describing that field's type and label.

GIN indexes on `extensions` (set up in the v0.2 migration) make `WHERE extensions->>'custentity_industry' = 'Manufacturing'` queries cheap at scale.

---

## Lineage-replay roundtrip works exactly like QBO

`importFromNs` populates `sourcePayload` with the verbatim NS JSON for every record. `exportToNs` reads those payloads back and reassembles the export structure. The dimension engine doesn't break this: the dimensions are reconstructed from the engine tables (which the orchestrator built from the NS Class/Department/Location/CustomSegment arrays), and the per-line dimension assignments are already preserved in each line's `sourcePayload` (the line object itself, with `class`, `department`, `location`, `custcol_*` fields).

```typescript
const original = JSON.parse(readFileSync("./netsuite-export.json", "utf-8"));
await importFromNs(prisma, { entityCode: "NS_DEMO", export: original });
const roundTripped = await exportToNs(prisma, { entityCode: "NS_DEMO" });
const diff = diffNsExports(original, roundTripped);
expect(diff).toBe(null);
```

---

## What this validates

The universal-schema spec says the test for any source-system mapping is whether transactions can be expressed in Layer 1 with zero loss. QBO answered yes for the floor. NetSuite answers yes for the ceiling: even with 4 dimensions per line + 1-2 custom fields per record + the full ASC 606 / sub-ledger lifecycle, the roundtrip is lossless.

What's left for v1.0: NS Accounting Books (multi-book parallel posting from a single NS transaction), and consolidation across multiple NS subsidiaries.

---

## End-to-end usage

```typescript
import { importFromNs, exportToNs } from "@/lib/mappers/netsuite";

// 1. Create a ledger-core entity for the NS company.
await prisma.legalEntity.create({
  data: { code: "MYNS", name: "My NS Co.", functionalCurrencyId: "USD" }
});

// 2. Drop in a NetSuite export (typical SuiteAnalytics or SuiteScript JSON).
const nsExport = JSON.parse(readFileSync("./ns-export.json", "utf-8"));

// 3. Run the import.
const result = await importFromNs(prisma, {
  entityCode: "MYNS",
  bookCode: "US_GAAP",
  export: nsExport,
});

console.log(`Imported ${result.journalEntriesImported} JEs across ${result.dimensionsCreated} dimensions`);
console.log(`${result.dimensionSetsCreated} unique dimension combinations`);

// 4. Now you can run dimensional reports against ledger-core's normal API.
const revenueByDept = await prisma.journalLine.groupBy({
  by: ["accountId"],
  where: {
    account: { code: "NS4000" },
    dimensionSet: { values: { some: { dimension: { code: "DEPARTMENT" } } } },
  },
  _sum: { credit: true, debit: true },
});

// 5. Reverse export for audit / migration.
const reExported = await exportToNs(prisma, { entityCode: "MYNS" });
```

---

## Account code convention recap

| Prefix | Source |
|---|---|
| `1000`, `2000`, ... | Native chart (Northwind seed) |
| `Q<id>` | QBO import |
| `NS<internalid>` | NetSuite import |

Original system Ids preserved in `sourceRecordId`. Mappers from new ERPs follow the same `<2-3 char prefix><id>` pattern. Reclassification to a unified chart is a manual MANUAL-source JE flow — not part of the automatic import.
