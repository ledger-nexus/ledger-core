# Universal Accounting Schema — Project Context

## Goal
Design one universal database schema that can losslessly represent the data of
all major ERP / accounting systems (QuickBooks Online, QuickBooks Desktop,
Xero, Sage Intacct, Sage 50, Sage X3, NetSuite, Dynamics 365 BC/F&O, SAP
S/4HANA, Oracle Fusion, Workday, Acumatica, Odoo, Zoho Books, etc.). The schema
must normalize cleanly while still mapping every system's functionality,
including customizations and custom fields. This file captures the
architectural decisions already made so they are not re-litigated.

## Core Architectural Principle
Every accounting system, regardless of UI or workflow, ultimately collapses to
**double-entry journal entries against a chart of accounts**. That posting layer
is the universal substrate. All documents (invoices, bills, POs, sales orders,
payroll runs) are pre-built templates that auto-generate journal entries. Build
the posting layer first; everything else maps onto it.

The validation test for any source-system mapping: can an ERP transaction be
expressed in the posting layer (Layer 1) with zero loss? If yes, the mapping
succeeds.

## The Six-Layer Architecture
Concentric layers. Inner layers are required by all outer layers. Outer layers
hold system-specific richness.

### Layer 1 — Posting Substrate (identical for every system)
- `gl_entry_header` — one row per posted document. Fields: entity_id, book_id,
  period_id, document_date, posting_date, source_type (enum), source_document_id,
  currency_id, fx_rate, status (draft/posted/void/reversed), reversal_of_id,
  audit fields.
- `gl_entry_line` — one row per debit/credit **per book**. Fields: header_id,
  line_no, account_id, party_id (nullable), item_id (nullable), debit_amount,
  credit_amount, transaction_currency_amount, functional_currency_amount,
  reporting_currency_amount, memo, dimension_set_id, tax_code_id, sub-ledger keys.

### Layer 2 — Master Data
- `party` — unified Customer/Vendor/Employee/Other. One row per person/org. A
  `party_role` join table lets one party be Customer + Vendor + Employee at once.
- `account` — chart of accounts. parent_account_id (hierarchy), account_type
  (asset/liability/equity/revenue/expense + normal balance), account_subtype,
  is_control_account, is_bank, book_scope.
- `item` — products + services. item_type (inventory/non-inventory/service/kit/
  assembly/fixed_asset), costing_method, default income/expense/inventory accounts.
- `book` — one row per ledger an entity keeps (US GAAP, US Tax, IFRS, Management).
- `legal_entity` — companies/subsidiaries.
- `period` / `fiscal_calendar` — periods keyed per (entity, book).
- `currency`, `fx_rate` — multiple rate types.

### Layer 3 — Dimension Engine (do NOT use fixed dimension columns)
- `dimension` — defines a kind of dimension (Department, Class, Location, Project,
  user-defined). Fields: code, name, is_required, applies_to_account_types.
- `dimension_value` — values for each dimension.
- `dimension_set` — a deduplicated combination of dimension values; each posting
  line references one dimension_set_id.
- `dimension_set_value` — bridge linking dimension_set_id to (dimension_id,
  dimension_value_id) pairs.
This handles 2 dimensions (QBO) or 20 (custom Intacct) with one schema.

### Layer 4 — Document Layer (specialized tables, "Option B")
Separate tables: `invoice`, `bill`, `payment`, `purchase_order`, `sales_order`,
`inventory_adjustment`, etc. **Discipline:** every document table shares the same
first ~12 columns (entity_id, book_id, doc_date, posting_date, party_id, currency,
status, totals, FK to gl_entry_header) so a `document_v` union view works for
cross-document reporting.

### Layer 5 — Custom Fields & Custom Records
- Storage: `extensions JSONB` column on every entity (party, account, item, all
  document tables). Indexable via GIN in Postgres.
- Metadata: `custom_field_definition` table (label, type, validation, default,
  source ERP field code) describes what's in the JSON.
- Custom record types: `entity_type` registry + generic `custom_record` /
  `custom_record_value` pair, referencing the dimension and posting layers as
  first-class entities.

### Layer 6 — Lineage & Source Mapping (non-negotiable)
Every imported row carries: source_system, source_record_type, source_record_id,
source_payload JSONB (frozen raw original), mapping_version. Enables roundtrip
proofs, debugging, and re-running mappings without re-extraction.

## Multi-Book Architecture — LOCKED DECISION
Multi-book is committed for scalability. Rationale: GAAP accounting and Tax
accounting become distinct organizational divisions pulling against the same
underlying data, with divergent timing, master data, workflow, and deliverables.

Implementation rules:
- `book_id` on `gl_entry_line` and on every master record that diverges across
  books. Single-book sources default to `book_id = 'PRIMARY'`.
- Use **Pattern 2 (full parallel ledgers)**: post in full to every relevant book.
  Do NOT derive alternate books from a primary at query time (Pattern 1 trap).
- Books are **peers** — no privileged "primary" book at the data layer. "Primary"
  is only a UI/reporting default. Each book has full, independent posting authority.
- Master data extensions are book-aware: e.g., `fixed_asset_book_attributes` keyed
  by (asset_id, book_id) holding useful_life, depreciation_method, in_service_date,
  salvage_value, accumulated_depreciation. Same pattern for leases, revenue
  contracts, inventory layers, intangibles.
- A single source event maps to N sets of GL lines via a **posting rules engine**:
  `posting_rule` table keyed by (source_event_type, book_id) producing a GL-line
  template. (NetSuite "Accounting Rules"; SAP "account determination".)
- Period close locks are per (entity_id, book_id, period_id) — GAAP April can be
  closed while Tax April stays open.
- Permissions/audit are book-aware, grained at (entity, book, account-type, action).
- Design for N books, not 2. A third "Management" book always emerges; large
  shops run 6+ (US GAAP, US Tax, State Tax, IFRS, Statutory, Management).
- Book-tax differences (ASC 740 / M-1 / M-3) are a **report** that diffs two books
  and classifies deltas as permanent vs. temporary — not a separate book. Requires
  consistent account mapping across books, or a "tax sensitivity" attribute on
  accounts.

## Design Principles
- Normalize aggressively at Layers 1–3 (3NF). Denormalize selectively at Layer 4+.
- Custom fields go in JSONB, not strict-typed EAV.
- Surrogate keys are generated UUIDs. Source-system IDs live only in the lineage
  layer (source IDs collide across systems).
- Periods, books, and legal entities are first-class everywhere — even in
  single-system, single-book datasets.
- Always store three currency amounts: transaction, functional, reporting — plus
  the FX rate used.
- AR / AP / Inventory are sub-ledgers, not document tables. Model `ar_open_item`
  and `ap_open_item` with their own lifecycle (open → applied → written-off →
  reopened). A bill creates an AP open item; it is not itself AP.
- Customer:Job / Project / WBS / Sage Job all collapse into one `project` entity
  with parent_party_id. Do not model jobs as a kind of customer.
- The universal `item` / `party` tables hold ~30 universal fields only. System-
  specific fields (e.g., SAP material master MRP/valuation fields) go in
  `extensions JSONB` with registered definitions. Do not build superset megatables.

## Anti-Patterns — Do NOT
- Do NOT put class_id / location_id / department_id / project_id as fixed columns
  on gl_entry_line. Use the dimension engine.
- Do NOT keep one ledger and derive other books via summed adjustments at query
  time (delta accounting) — breaks at scale.
- Do NOT model Customers, Vendors, Employees as three separate tables. Use unified
  `party` + `party_role`.
- Do NOT use strict-typed EAV for custom fields — joins explode, types are stringly.
- Do NOT reuse source-system primary keys as schema keys.
- Do NOT widen `item` / `party` into 400-column sparse supersets of every ERP.

## ERP Coverage & Mapping Targets
- Expressive ceiling (drives max capability): Sage Intacct, NetSuite, SAP S/4HANA,
  Dynamics F&O — multi-entity, multi-currency, multi-book, 8+ dimensions, deep
  custom fields/records.
- Minimum viable surface (drives the floor): QuickBooks Online, Xero — single-book,
  2 dimensions max, limited custom fields.
- Key separators across systems: unified Party vs. split tables; number of
  dimensions; native multi-book vs. single-book; custom-field/custom-record depth.
- Tax-prep tools (Lacerte, ProSeries, Drake, UltraTax) are NOT ERPs — they are
  trial-balance consumers. If tax-workpaper integration is needed, model it as a
  Tax book + a `tax_adjustment` document type, not as a source ERP.

## Resolved scope (this repo)
1. **Geography** — US + IFRS only. Per-country statutory books deferred.
2. **Sub-ledger ownership** — this schema owns AR/AP/fixed assets/leases/revenue
   contracts natively. Specialty tools (Sage FAS, LeaseQuery) feed GL impact for
   the things this schema doesn't model itself.
3. **Tax view** — quarter-end batch only; real-time tax provision deferred.
4. **Target mix** — QBO-floor, NetSuite-ceiling. Validate end-to-end on QBO data
   first; design ceiling for NetSuite/Intacct.

## Suggested Build Order
1. Layer 1 posting substrate + `book` + `legal_entity` + `period`.  ← THIS COMMIT
2. Layer 2 master data (party, account, item, currency).             ← THIS COMMIT
3. Layer 3 dimension engine (tables; values when needed).            ← THIS COMMIT
4. Native sub-ledgers (AR/AP open items, fixed assets, leases, revenue contracts)
   with book-aware attribute tables.                                  ← next batch
5. Posting rules engine + multi-book parallel posting in seed.       ← next batch
6. Book-tax difference report + ASC 740 surface.                     ← next batch
7. Layer 4 document tables.                                          ← consumer repos
8. Validate by mapping one full source system end-to-end —
   start with QuickBooks Online (easiest), then stress-test with NetSuite (hardest).

## Glossary
- **Book / Ledger** — an accounting basis (US GAAP, Tax, IFRS, Management). One
  transaction can post differently to each.
- **Dimension** — a reporting axis (Department, Class, Location, Project). Called
  segments in Intacct, financial dimensions in Dynamics, cost/profit centers in SAP.
- **Party** — unified umbrella over Customer, Vendor, Employee.
- **Posting rule** — per (source_event_type, book) logic that turns a document
  into journal lines.
- **Sub-ledger** — detail ledger (AR, AP, inventory, fixed assets) that rolls up
  to a GL control account.
- **Book-tax difference** — divergence between GAAP and Tax books; permanent or
  temporary; feeds ASC 740 deferred tax.
