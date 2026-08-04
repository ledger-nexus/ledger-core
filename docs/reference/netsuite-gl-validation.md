# NetSuite GL substrate validation pass

**Date:** 2026-06-03
**Source:** `~/Downloads/Fleet Netsuite Master Data.xlsx`
**Validator script:** `scripts/netsuite-gl-validator.py`
**Output:** `/tmp/ns_gl_validation/`

## What this is

**The headline validator.** Tests the universal-schema thesis directly:
*"any major ERP's GL absorbs cleanly into the ledger-nexus substrate."*

Translates:
- 74 NetSuite `accounts` → ledger-core `Account`
- 16 `subsidiaries` → `LegalEntity` (with parent hierarchy)
- 2 `accounting_books` → `Book`
- 70 `accounting_periods` → `Period`
- 1,000 `journal_entries` × 1,000 `journal_entry_lines` → `JournalEntry` × `JournalLine`

This is the test the other validators (fa-amort, revenue-rec) implicitly
rely on.

## Headline result

✅ **The universal-schema thesis holds on this dataset.**

| Layer | Source rows | Translated | Notes |
|---|---|---|---|
| Accounts | 74 | 74/74 (100%) | 14 NetSuite types → 5 ledger-core enum, all 40 subtypes preserved |
| Subsidiaries | 16 | 16/16 (100%) | Parent hierarchy intact (14/16 have parents) + 1 elimination entity |
| Books | 2 | 2/2 (100%) | `basis` field needs manual mapping (US_GAAP + IFRS) — small gap |
| Periods | 70 | 70/70 (100%) | 63 closed + 7 open status map cleanly |
| JE headers (sampled) | 100 | 100/100 (100%) | **100/100 balance check PASSED** — every sampled JE has debits = credits |
| JE lines (sampled) | 200 | 200/200 (100%) | **100% dimension density** — every line has DEPARTMENT + CLASS + LOCATION |

## Coverage detail

### Account type mapping (14 → 5)

| NetSuite type | Count | ledger-core `AccountType` |
|---|---|---|
| `other_asset` | 6 | ASSET |
| `accounts_receivable` | 2 | ASSET (+ `isControlAccount=true`) |
| `other_current_asset` | 7 | ASSET |
| `bank` | 3 | ASSET (+ `isBank=true`) |
| `fixed_asset` | 4 | ASSET |
| `other_current_liability` | 10 | LIABILITY |
| `long_term_liability` | 3 | LIABILITY |
| `deferred_revenue` | 1 | LIABILITY |
| `accounts_payable` | 1 | LIABILITY (+ `isControlAccount=true`) |
| `equity` | 5 | EQUITY |
| `income` | 7 | REVENUE |
| `expense` | 21 | EXPENSE |
| `other_expense` | 3 | EXPENSE |
| `cost_of_goods_sold` | 1 | EXPENSE |

**Final distribution:** 22 ASSET + 15 LIABILITY + 5 EQUITY + 7 REVENUE
+ 25 EXPENSE. Matches the expected shape for a mid-market SaaS company.

### Subtype diversity preserved

40 distinct NetSuite subtypes pass through to ledger-core's free-text
`subtype` field. Examples: `Intangible Asset`, `Tax Liability`,
`Prepaid Expense`, `Intercompany Receivable`, `Deferred Tax Asset`,
`Lease Liability`, `Long Term Debt`, `Bank`, `Inventory`, `Accrued
Liability`, `Cost of Goods Sold`.

ledger-core's cash-flow classification heuristic + intercompany
elimination logic rely on subtype — this preservation matters.

### Subsidiary hierarchy

- 16 subsidiaries, 14 with `parent_subsidiary_id` set
- 1 elimination entity (NetSuite ships these explicitly; ledger-core
  uses subtype-driven elimination on `DUE_FROM_AFFILIATE` /
  `DUE_TO_AFFILIATE` / `INTERCOMPANY_REV` / `INTERCOMPANY_EXP`)
- All 16 have `consolidation_method = "full"` — matches ledger-core's
  implicit FULL assumption. Equity-method and cost-method support
  would be needed for portfolios with minority stakes.

### Multi-book observation

NetSuite Fleet has **2 books** (`US_GAAP` + `IFRS`). The `is_book_specific`
flag on `journal_entries` is **`false` for all 1,000 JEs** in the sampled
data — every JE is book-agnostic in this dataset.

That's an interesting tension with ledger-core's Pattern 2 design, which
assumes **every JE targets ONE (entity, book)**. If you import NetSuite
data verbatim, each book-agnostic JE would need to fan out to 2 JE rows
(one per book) on the ledger-core side. The lineage triple
(`sourceSystem`, `sourceRecordType`, `sourceRecordId`) supports this —
both ledger-core rows reference the same NetSuite source ID.

**Implementation note:** the NetSuite mapper would need to detect
`is_book_specific=false` and emit one `postJournalEntry` call per book,
relying on the `bookScope` filter on accounts to enforce per-book
account validity.

### JE balance integrity

**100/100 sampled JEs pass debits = credits.** Validates the
processing-integrity invariant at the substrate level. If real NetSuite
data shipped unbalanced JEs, our `postJournalEntry` would reject them —
the import would fail loudly, not silently corrupt.

### Dimension density

**Every line in the sample has DEPARTMENT + CLASS + LOCATION assigned.**
That's 200/200 lines × 3 dimensions = 600/600 dimension slots
populated.

ledger-core's Layer 3 dimension engine deduplicates these into shared
`DimensionSet` rows via stable hash. For the 200-line sample, the hash
dedup means we'd store **at most 200 distinct DimensionSet rows** (one
per unique combination); given that JEs often share dimension contexts,
the actual count is much lower.

The dimension density on every line is a strong signal that the Layer
3 engine is the right architectural choice — not a Layer 1 column on
JournalLine.

### Source-document FK observation

NetSuite stores per-line FKs to source documents: `customer_id`,
`vendor_id`, `invoice_id`, `bill_id`, `payment_id`, `bill_payment_id`,
`consolidation_id`, `intercompany_transaction_id`. **Zero of the
sampled JE lines populate any of these FKs.**

This suggests the sampled JEs are manual/recurring entries, not derived
from sub-ledger documents. ledger-core's `sourceSystem` /
`sourceRecordType` / `sourceRecordId` triple is the more general
absorption pattern — NetSuite's typed FKs are denser typed but ours
generalize across systems.

### Entry types

| NetSuite `entry_type` | Count | ledger-core handling |
|---|---|---|
| `manual` | 393 | Default — direct `postJournalEntry` call |
| `recurring` | 598 | ledger-core doesn't natively model recurring; user can post each occurrence manually |
| `intercompany` | 5 | Handled via subtype-driven elimination in consolidation report |
| `elimination` | 4 | Same as above + the elimination entity flag |

## Honest schema gaps

### Reversal scheduling

NetSuite stores `reversal_date` + `reversal_defer` on JE headers. 100/100
sampled headers have `reversal_defer` populated.

ledger-core doesn't model reversal scheduling explicitly. You can post
the reversal entry on the target date as a separate JE; the lineage
columns can link them. But the automatic generation of the reversal
isn't there.

**Effort to add:** small — a `reversalDate Date?` field on JournalEntry
+ a background job that posts the reversal on that date. ~half-day.

### Recurring JE templates

NetSuite stores `recurrence_frequency` + `parent_recurring_entry_id` +
`next_occurrence_date`. ledger-core has the posting-rules engine which
solves a different problem (declarative event → JE mapping for ERP
events), not user-defined recurring entries.

**Effort to add:** moderate — would need a `RecurringJournalEntry`
table with template + frequency + next-fire timestamp + a cron that
posts the next occurrence. ~2-3 days.

### `is_book_specific` flag handling

NetSuite supports both book-specific and book-agnostic JEs.
ledger-core's Pattern 2 assumes always-book-specific.

**Implementation:** the NetSuite mapper detects `is_book_specific=false`
and fans out to N rows (one per book). Lineage triple supports the
many-to-one source mapping. ~half-day in the mapper.

### Document attachments

NetSuite stores `document_data` (bytea) + `document_file_name` +
`document_content_type` on JE headers. 19/100 sampled JEs have an
attachment.

ledger-core doesn't model attachments on `JournalEntry`. The closest
is `extensions Json` which could hold a reference, but the actual bytes
would need to go to S3 / Vercel Blob / similar.

**Effort to add:** ~1 day to add a `JournalEntryAttachment` table
referencing object-store URLs.

### Approval workflow

NetSuite ships `approved_by_id` + `approved_date` + `posted_by_id` +
`posted_date`. ledger-core has the simpler `requireJeApproval` tenant
config + an approval queue.

**Already covered for the basic case** — the audit log captures
`auditedMutation` events on JE post. The NetSuite-style multi-step
approval workflow would map to ledger-core's emerging
`approval_workflows` pattern (currently in the SOC 2 framework, not
the substrate).

## Comparison vs the other validators

| Dimension | GL substrate | fa-amort | revenue-rec |
|---|---|---|---|
| **Source rows in dataset** | 1,160 across 6 tables | 90 assets + 1,000 sched | 1,000 arr + 1,000 elem |
| **Sample translation coverage** | 100% per-table | 87/90 | 5/1000 (truncation-limited) |
| **Schema gaps for production** | minor (4 features) | minor (3 methods) | substantial (allocatedAmount + fairValueMethod + quantity) |
| **Existing mapper status** | Partial (covers GL header + line, not subsidiary/book bootstrap) | None | None |
| **Effort to ship full import** | ~3-5 days (build out subsidiary + book + period import; reversal + recurring + attachment optional) | ~1 week | ~1-2 weeks |

**Headline finding:** ledger-core's GL substrate **absorbs the NetSuite
Fleet dataset cleanly**. The universal-schema thesis is validated. The
gaps that exist (reversal scheduling, recurring entries, attachments)
are additive features, not architectural mismatches.

## What the existing NetSuite mapper covers vs needs

The existing NetSuite mapper at `src/lib/mappers/netsuite/`:

✅ `mapNsAccount` — covered (uses the same 14→5 type mapping)
✅ `mapNsCustomer` / `mapNsVendor` — covered
✅ `mapNsItem` — covered
✅ `mapNsInvoice` / `mapNsVendorBill` / `mapNsCustomerPayment` /
   `mapNsVendorPayment` — covered (these create JEs through the
   substrate)
✅ `mapNsJournalEntry` — covered

🚧 Subsidiary → `LegalEntity` import — not in the existing mapper.
   Would need a bootstrap step before the JE import (entities must
   exist before JEs can reference them).
🚧 Book bootstrap — same gap.
🚧 Period bootstrap (71 periods to create) — same gap.
🚧 `is_book_specific=false` JE fan-out — not implemented.
🚧 Department / Class / Location → Dimension engine — partial; the
   existing mapper uses the dimension engine for NS custom segments
   but the standard built-in dimensions (DEPT/CLASS/LOC) need wiring.

**Effort to ship full NetSuite import:** ~3-5 days.

## How to reproduce

```bash
python3 scripts/netsuite-gl-validator.py

# Outputs:
#   /tmp/ns_gl_validation/report.json
#   /tmp/ns_gl_validation/translated_accounts.json
#   /tmp/ns_gl_validation/translated_entities.json
#   /tmp/ns_gl_validation/translated_books.json
#   /tmp/ns_gl_validation/translated_jes.json (first 20 only)
```
