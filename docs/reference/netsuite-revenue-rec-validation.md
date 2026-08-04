# NetSuite revenue-rec validation pass

**Date:** 2026-06-03
**Source:** `~/Downloads/Fleet Netsuite Master Data.xlsx` (sheets: `revenue_arrangements`, `revenue_elements`, `revenue_rules`, `revenue_plans`, `revenue_plan_lines`)
**Validator script:** `scripts/netsuite-revenue-validator.py`
**Output:** `/tmp/ns_revenue_validation/{report.json, translated_contracts.json}`

## What this is

A structural validation: take the NetSuite Fleet revenue data, run it
through a Python translator that converts to the JSON shape that
revenue-rec's `RevenueContract` / `PerformanceObligation` /
`RecognitionSchedule` would accept. Report what mapped cleanly + what
didn't.

This is the **realistic absorption test** for revenue-rec's universal
schema claim: "can we ingest a real NetSuite revenue dataset?"

## Sample bounds

The Excel export truncates each sheet at 1,000 rows. NetSuite primary
keys are dense integers (1..N) within each table, but FKs span the
full ID range (e.g., `revenue_elements.arrangement_id` runs 62 to
123,701).

| Sheet | Rows | ID range |
|---|---|---|
| `revenue_arrangements` | 1,000 | 1 to 1,000 |
| `revenue_elements` | 1,000 | (arrangement_id) 62 to 123,701 |
| `revenue_plans` | 1,000 | (revenue_element_id) ? to ? |
| `revenue_plan_lines` | 1,000 | (plan_id) ? to ? |

**Overlap:** only **5 arrangements** have at least one element in the
truncated dataset. The full-dataset validation would require an
un-truncated export.

## Coverage outcome (on the 5-arrangement sample)

- ✅ **5/5 contracts translated** with no structural failures
- ✅ **5/5 performance obligations** got resolved recognition patterns
  (NetSuite's `satisfaction_method` `over_time` → `OVER_TIME_STRAIGHT`,
  `point_in_time` → `POINT_IN_TIME`)
- ❌ **0/5 POs got resolved revenue/deferred account codes** — the 5
  elements have `recognition_rule_id = null`, so the account resolution
  fell to the item table; items are truncated and didn't include the
  needed IDs
- ❌ **0 recognition schedule entries carried over** — the same
  truncation disjointness affected the plan + plan_line joins

## Recognition pattern coverage (full-dataset signal)

From the 1,000-row truncated plan/element tables we can see the
distribution of methods in the broader dataset:

| NetSuite method | Count in 1,000-row sample | revenue-rec mapping |
|---|---|---|
| `straight_line` (recognition_method on plans) | 601 | ✅ `OVER_TIME_STRAIGHT` |
| `point_in_time` (recognition_method on plans) | 399 | ✅ `POINT_IN_TIME` |
| `over_time` (satisfaction_method on elements) | 591 | ✅ `OVER_TIME_STRAIGHT` |
| `point_in_time` (satisfaction_method on elements) | 409 | ✅ `POINT_IN_TIME` |

**Coverage: 100% on the dominant 2 methods.** Methods not seen in this
1,000-row sample but documented in NetSuite (`percentage_completion`,
`milestone`, `usage`) would need:
- `percentage_completion` → requires a new revenue-rec pattern OR
  cost-to-cost driver (NOT in v0.2 schema)
- `milestone` → maps to existing `OVER_TIME_MILESTONE` (revenue-rec
  errors today: v0.2 says "v0.3 work")
- `usage` → maps to existing `OVER_TIME_USAGE` (same v0.3 trigger)

## Allocation method coverage (full-dataset signal)

NetSuite's `fair_value_method` on the arrangement tracks HOW the
allocation was computed:

| Method | Count in 1,000-row sample | Meaning |
|---|---|---|
| `ESP` | 494 | Estimated Selling Price (best estimate when SSP unknown) |
| `VSOE` | 173 | Vendor-Specific Objective Evidence (price observed in standalone sales) |
| `TPE` | 167 | Third-Party Evidence (price observed for competitors) |
| `residual` | 166 | Residual method (allocate to highest-priority POs first) |

**Gap in revenue-rec:** the `PerformanceObligation.ssp` field doesn't
distinguish between these. ASC 606 requires the company to disclose
which method was used. Today revenue-rec stores SSP without provenance.

**Impact:** a real NetSuite customer importing into revenue-rec would
lose the SSP-source signal. Not blocking for first-customer onboarding
but is a known audit-trail gap.

## Fields NetSuite stores that revenue-rec doesn't model

Per the 5-arrangement sample:

| NetSuite field | What it stores | revenue-rec status |
|---|---|---|
| `arrangement.allocated_amount` | Sum of element allocations (denormalized) | Computed on read in revenue-rec; would need a backfill |
| `arrangement.recognized_amount` | Cumulative recognized across all elements (denormalized) | Computed from `PerformanceObligation.recognizedToDate` aggregation |
| `arrangement.deferred_amount` | Cumulative deferred (denormalized) | Computed |
| `arrangement.accounting_standard` (`ASC_606`) | Which standard applies | revenue-rec assumes single standard; multi-book Pattern 2 in ledger-core handles divergence per-book |
| `arrangement.fair_value_method` | ESP / VSOE / TPE / residual | NOT modeled — see "Allocation method coverage" gap |
| `element.allocated_amount` | The actual allocated amount (vs SSP) | NOT modeled — revenue-rec uses SSP as the allocated amount, which is incorrect for non-uniform allocations |
| `element.quantity` | Item quantity | NOT modeled — revenue-rec assumes quantity=1 (SSP is the line value) |
| `element.deferred_amount` | Element-level deferred (denormalized) | Computed |

## Honest "would it work for production NetSuite import" assessment

**Today, no.** The structural reasons:

1. **No NetSuite import endpoint** — revenue-rec ships an AI-based
   contract extractor (`extractContractAction`) but no NetSuite-shaped
   JSON ingestion. The existing universal NetSuite mapper at
   `ledger-core/src/lib/mappers/netsuite/` covers GL + AR + AP basics,
   not revenue arrangements.
2. **`PerformanceObligation` missing `allocatedAmount`** — revenue-rec
   currently treats SSP as the allocated amount, which is only correct
   when allocation is proportional-to-SSP (the default case but not
   the only case). Non-proportional allocations (e.g., residual method)
   require a separate `allocatedAmount` field.
3. **No `fair_value_method` tracking** — ASC 606 audit trail gap.
4. **No `quantity` on PO** — minor; can be embedded in description or
   added.

## What WOULD work right now

Given a hand-crafted bridge:

1. **Recognition pattern translation** — 100% of the dominant cases
2. **Contract creation + customer linking** (assuming customer party
   resolution works via the existing NetSuite mapper's `mapNsCustomer`)
3. **OVER_TIME_STRAIGHT + POINT_IN_TIME schedule generation** —
   revenue-rec already computes these in
   `src/lib/accounting/schedule.ts`
4. **Source lineage** via `sourceSystem` / `sourceRecordType` /
   `sourceRecordId` columns on `RevenueContract`

## Recommended next steps (when revenue-rec needs NetSuite support)

| Priority | Work item | Effort |
|---|---|---|
| 1 | Add `allocatedAmount` + `allocationMethod` (enum: PROPORTIONAL/RESIDUAL/MANUAL) to `PerformanceObligation` | ~1 day (schema migration + recognition engine update) |
| 2 | Build NetSuite revenue mapper at `revenue-rec/src/lib/mappers/netsuite/` mirroring the ledger-core pattern (`types.ts` / `mappers.ts` / `import.ts` / `export.ts`) | ~3 days |
| 3 | Add `fair_value_method` field for ASC 606 audit-trail | ~2 hours |
| 4 | Implement `OVER_TIME_USAGE` + `OVER_TIME_MILESTONE` patterns (currently throw with v0.3 pointer) | ~2 days each |
| 5 | Extend tests to assert end-to-end import of `prisma/fixtures/netsuite-revenue-sample.json` | ~1 day |

Total to ship NetSuite revenue-arrangement import: ~1-2 weeks of focused work.

## Coverage scorecard

| Area | Today | Mid-effort gap-close |
|---|---|---|
| Recognition pattern translation | ✅ 100% on dominant 2 patterns | — |
| Account resolution | 🟡 Falls to item.income_account; tenant-default needed | ~2 hours |
| Schedule generation (OVER_TIME_STRAIGHT / POINT_IN_TIME) | ✅ via existing `src/lib/accounting/schedule.ts` | — |
| Schedule generation (USAGE / MILESTONE) | ❌ throws v0.3 pointer | ~2-4 days |
| Allocation method preservation | ❌ no field | ~1 day |
| Multi-currency arrangements | ⚠️ NetSuite stores per-currency; revenue-rec inherits from customer.currency | OK for most cases |
| Multi-subsidiary (one arrangement per subsidiary) | ✅ via `entityCode` lineage | — |
| Quantity tracking | ❌ no field | ~1 hour |
| `accounting_standard` (ASC 606 vs IFRS 15) | ✅ via Pattern 2 multi-book (per-book recognition) | — |

## How to reproduce

```bash
# Regenerate from the source XLSX
python3 scripts/netsuite-revenue-validator.py

# Outputs:
#   /tmp/ns_revenue_validation/report.json
#   /tmp/ns_revenue_validation/translated_contracts.json
```

Source XLSX lives at `~/Downloads/Fleet Netsuite Master Data.xlsx`
(per `docs/reference/netsuite-fleet-master-data.md`).
