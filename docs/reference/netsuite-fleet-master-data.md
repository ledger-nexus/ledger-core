# Reference — Fleet NetSuite Master Data

**Source file:** `~/Downloads/Fleet Netsuite Master Data.xlsx` (5.9 MB)
**Captured:** 2026-06-03
**Purpose:** Study reference for the ledger-nexus universal-schema work.
A real (sample) NetSuite instance against which to validate our
schema absorption + mapper coverage.

## Top-level stats

- **174 sheets** · **77,170 rows** · **2,393 columns**
- **58 sheets truncated at 1,000 rows** (export limit)
- Single fictional company group (multi-subsidiary)

## 17 functional groups

### Master Data — entities (12 sheets · 1,006 rows)
`customers` (505 × 31), `vendors` (201 × 27), `employees` (201 × 24),
`items` (11 × 23), `subsidiaries` (17 × 22), `departments` (11 × 8),
`locations` (5 × 10), `Classes` (6 × 8), `segments` (6 × 5),
`segment_assignments` (17 × 4), `currencies` (14 × 11),
`currency_exchange_rates` (12 × 9)

### Master Data — accounting structure (10 sheets · 1,053 rows)
`accounts` (75 × 24), `accounting_books` (3 × 11),
`accounting_periods` (71 × 22), `tax_periods` (181 × 12),
`tax_codes` (35 × 16), `tax_code_subsidiaries` (511 × 3),
`payment_terms` (6 × 9), `payment_term_subsidiaries` (4 × 3),
`company_preferences` (6 × 6), `item_subsidiaries` (161 × 3)

### GL core (5 sheets · 4,025 rows; 4 truncated)
`journal_entries` (1,001 × 30 truncated),
`journal_entry_lines` (1,001 × 29 truncated),
`audit_trail_entries` (1,001 × 13 truncated),
`elimination_entries` (1,001 × 12 truncated),
`reclassification_journal_entrie` (21 × 10)

### AR — order to cash (18 sheets · 15,275 rows; 14 truncated)
`estimates`/`estimate_lines`, `sales_orders`/`sales_order_lines`,
`sales_order_billing_schedules`, `invoices`/`invoice_lines`,
`credit_memos`/`credit_memo_applications`,
`cash_sales`/`cash_sale_lines`, `cash_refunds`/`cash_refund_lines`,
`customer_refunds`, `customer_disputes`, `collection_activities`,
`return_authorizations`/`return_authorization_lines`

### AP — procure to pay (20 sheets · 13,593 rows; 8 truncated)
`requisitions`/`requisition_lines`,
`requests_for_quote`/`request_for_quote_lines`,
`vendor_quotes`/`vendor_quote_lines`,
`purchase_orders`/`purchase_order_lines`,
`purchase_contracts`/`purchase_contract_lines`,
`item_receipts`/`item_receipt_lines`, `bills`/`bill_lines`,
`bill_variances`, `vendor_credits`/`vendor_credit_applications`,
`vendor_return_authorizations`/`vendor_return_authorization_lin`,
`vendor_prepayments`

### Cash + bank (11 sheets · 6,696 rows; 4 truncated)
`bank_accounts` (11 × 15), `bank_statements` (317 × 7),
`bank_statement_lines` (1,001 × 10 truncated), `bank_transfers`,
`deposits`, `reconciliations` (451 × 12),
`reconciliation_lines` (1,001 × 11 truncated),
`payments`/`payment_applications`,
`bill_payments`/`bill_payment_applications`

### Revenue recognition — ASC 606 (13 sheets · 6,923 rows; 7 truncated)
`revenue_arrangements`/`revenue_elements`,
`revenue_plans`/`revenue_plan_lines`,
`revenue_rules`/`revenue_rule_subsidiaries`,
`revenue_recognition_journals`,
`revenue_forecasts`/`revenue_forecast_lines`,
`deferred_revenue_reclassificati`,
`billing_schedules`/`billing_schedule_milestones`,
`billing_accounts`

### Subscription + billing (14 sheets · 5,217 rows; 4 truncated)
`subscription_plans`/`subscription_plan_lines`,
`subscriptions`/`subscription_lines`, `price_books`, `price_plans`,
`price_plan_tiers`, `pricing_tiers`, `charges`, `rating_runs`,
`usage_records`, `commit_plus_overages`, `prepaid_drawdowns`,
`prepaid_usages`

### Fixed assets + leases (10 sheets · 3,436 rows; 2 truncated)
`fixed_assets` (91 × 25), `depreciation_schedules` (truncated),
`construction_in_progress` (15 × 18), `cip_cost_entries`,
`capital_appropriation_requests`, `lease_contracts` (41 × 15),
`lease_liabilities` (truncated), `lease_modifications`,
`lease_payment_schedules` (truncated), `right_of_use_assets` (41 × 13)

### Projects (11 sheets · 6,474 rows; 6 truncated)
`projects` (251 × 15), `project_tasks`, `project_teams`,
`time_entries`, `charges`, `change_orders`/`change_order_lines`,
`fulfillment_requests`/`fulfillment_request_lines`,
`fulfillment_lines`, `item_fulfillments`

### Payroll + HR (5 sheets · 3,117 rows; 3 truncated)
`payroll_runs`, `payroll_lines`, `payroll_tax_filings`,
`expense_reports`, `expense_report_lines`

### Tax (4 sheets · 2,087 rows; 2 truncated)
`tax_provisions`, `deferred_tax_items`,
`uncertain_tax_positions`, `return_to_provision_true_ups`

### Debt + equity (9 sheets · 1,210 rows)
`Debt_instruments` (14 × 24), `debt_amortization_schedules`,
`covenant_tests`, `equity_grants` (86 × 17),
`equity_rollforward`, `option_exercises`, `vesting_events`,
`investment_positions`, `fx_hedges`

### Intercompany + consolidation (4 sheets · 2,864 rows; 1 truncated)
`intercompany_transactions` (1,001 truncated),
`consolidation_processes` (61 × 15),
`consolidation_subsidiaries` (901 × 7),
`consolidation_translations` (901 × 7)

### Planning + reporting (14 sheets · 1,716 rows; 1 truncated)
`budgets`, `budget_lines`, `forecasts`, `forecast_lines`,
`scenarios`, `scenario_assumptions`, `financial_reports`,
`report_snapshots`, `kpis`, `kpi_widget`, `dashboards`,
`dashboard_widgets`, `dashboard_roles`, `saved_searches`

### Period close + controls (10 sheets · 2,602 rows; 2 truncated)
`period_close_tasks`, `period_state_transitions`,
`approval_workflows`, `approval_steps`, `approval_requests`,
`approval_authorities`, `approval_delegations`,
`compliance_controls`, `compliance_tests`, `bad_debt_writeoffs`

### Users + roles (5 sheets · 877 rows)
`user_roles`, `user_roles_mapping`, `user_subsidiaries`,
`user_role_subsidiaries`, `user&roles`

---

## Mapping to the ledger-nexus portfolio

The columns observed in the high-value tables map cleanly onto our
universal schema. Reference:

| NetSuite | ledger-nexus equivalent | Notes |
|---|---|---|
| `journal_entries` (`id`, `entry_number`, `subsidiary_id`, `accounting_book_id`, `is_book_specific`, `posting_period_id`, `entry_type`, `recurrence_frequency`) | `JournalEntry` (ledger-core) | NetSuite has explicit `is_book_specific` flag; ledger-nexus Pattern 2 is "always book-specific". `entry_type` covers recurring + standard. |
| `journal_entry_lines` (`debit`, `credit` separate; `entity`, `department_id`, `class_id`, `location_id`, `tax_code_id`, `customer_id`, `vendor_id`, `invoice_id`, `bill_id`, `consolidation_id`, `intercompany_transaction_id`) | `JournalLine` (ledger-core) + dimension engine | NetSuite encodes line-level source-document FKs directly. ledger-nexus uses `sourceSystem`/`sourceRecordType`/`sourceRecordId`/`sourcePayload`. Dimension columns (CLASS/DEPT/LOCATION/custom) map to our Layer 3 dimension engine. |
| `accounts` (`account_number`, `type`, `subtype`, `parent_account_id`, `restrict_to_*`, `eliminate_intercompany`, `revalue`) | `Account` (ledger-core) | NetSuite's `restrict_to_*` + `eliminate_intercompany` + `revalue` flags map to our subtype-driven heuristics (cash-flow classification, intercompany subtypes DUE_FROM/DUE_TO_AFFILIATE/INTERCOMPANY_REV/EXP). |
| `subsidiaries` (`country`, `state`, `base_currency`, `fiscal_calendar`, `parent_subsidiary_id`, `is_elimination`, `accounting_standard`, `consolidation_method`) | `LegalEntity` (ledger-core) | The `parent_subsidiary_id` is exactly our `parentEntityId` for consolidation hierarchy. `is_elimination` is a flag pattern we should consider. `consolidation_method` (FULL/EQUITY/COST) is richer than our current model. |
| `accounting_books` (3 rows × 11 cols) | `Book` (ledger-core) | Confirms 3-book setup (likely US_GAAP + US_TAX + IFRS or similar). Worth examining the actual rows. |
| `fixed_assets` (`asset_number`, `acquisition_date`, `placed_in_service_date`, `original_cost`, `residual_value`, `useful_life_months`, `depreciation_method`, `accumulated_depreciation`, `current_book_value`, `disposal_date`, `disposal_amount`, `gain_loss`) | `FixedAsset` + `FixedAssetBookAttributes` (fa-amort) | All fields present in our schema. NetSuite stores `current_book_value` denormalized — we compute on read. |
| `lease_contracts` + `right_of_use_assets` + `lease_liabilities` + `lease_payment_schedules` + `lease_modifications` | ASC 842 engine in ledger-core | NetSuite splits into 5 tables; ledger-core has `Lease` + `LeaseBookAttributes` with `runLeaseAccounting` orchestrating commencement/amortization/payment. |
| `revenue_arrangements` (`arrangement_number`, `customer_id`, `total_arrangement_value`, `accounting_standard`, `fair_value_method`, `contract_*`) + `revenue_elements` (`standalone_selling_price`, `allocated_amount`, `recognized_amount`, `deferred_amount`, `recognition_rule_id`, `satisfaction_method`) + `revenue_plans`/`revenue_plan_lines` + `revenue_rules` | `RevenueContract` + `PerformanceObligation` + `RevenueContractBookAttributes` (revenue-rec) + recognition schedule | Identical model. NetSuite's `revenue_plans` are our `RecognitionSchedule`; `revenue_rules` are our recognition-pattern enum. |
| `bank_statement_lines` (`matched_transaction_type`, `matched_transaction_id`, `reconciled`) + `reconciliations` + `reconciliation_lines` | `BankStatementLine` + `ReconciliationMatch` (recon) | Same model. NetSuite's `matched_transaction_type` is more general (can match to any txn type); recon today maps to JE lines specifically. |
| `subscriptions`/`subscription_lines`/`charges`/`usage_records` (ASC 606 subscription billing) | **NOT in ledger-nexus** | This is asc606 / RevRec Engine's domain — not in the substrate. NetSuite ships subscription billing as a peer to revenue recognition. |
| `intercompany_transactions` (1,001 truncated) + `consolidation_processes` + `consolidation_subsidiaries` + `consolidation_translations` | Intercompany + consolidation in ledger-core (`getConsolidatedTrialBalance`) | NetSuite has explicit `consolidation_processes` runs that track translation per subsidiary. ledger-core today does consolidation on read. |
| `audit_trail_entries` (1,001 truncated × 13 cols) | `AuditLog` (ledger-core; append-only RULE) | NetSuite ships system-wide audit trail. ledger-nexus has the same pattern with Postgres RULE enforcement. |
| `approval_workflows`/`approval_steps`/`approval_requests`/`approval_authorities`/`approval_delegations` | JE approval queue in ledger-core (`requireJeApproval` config) | NetSuite has full workflow engine; ledger-core has a simpler 4-role × per-tenant approval model. |
| `period_close_tasks` (2 × 11) + `period_state_transitions` | `PeriodClose` (ledger-core) + month-end packet | NetSuite has explicit close-task checklist. Worth examining the 2 rows. |
| `compliance_controls` (81 × 17) + `compliance_tests` (1,001 truncated × 14) | SOC 2 framework in `docs/policies/` | NetSuite tracks SOX controls + test runs. Our framework lives in docs + audit_log. |
| `tax_provisions`/`deferred_tax_items`/`uncertain_tax_positions`/`return_to_provision_true_ups` | BTD report + M-3 detail in ledger-core | NetSuite has full tax-provision engine. ledger-core today produces the BTD + M-3 reports but doesn't track provisions as posted entities. |
| `Debt_instruments`/`debt_amortization_schedules`/`covenant_tests` | **NOT in ledger-nexus** | Treasury / debt management is out of scope. |
| `equity_grants`/`vesting_events`/`option_exercises` | **NOT in ledger-nexus** | Equity comp / cap table is out of scope. |
| `budgets`/`forecasts`/`scenarios` | **NOT in ledger-nexus** | FP&A surface is out of scope. |

---

## Coverage scorecard

**ledger-nexus covers** (as substrate + sub-ledgers + companion repos):

- ✅ GL core (journal_entries + journal_entry_lines + accounts + subsidiaries + accounting_books + accounting_periods)
- ✅ AR + AP sub-ledgers (with open items + applications)
- ✅ Fixed assets + depreciation (fa-amort)
- ✅ Lease ASC 842 (ledger-core)
- ✅ Revenue recognition ASC 606 (revenue-rec)
- ✅ Bank reconciliation (recon)
- ✅ Multi-entity consolidation + elimination
- ✅ Audit trail (append-only RULE)
- ✅ Period close

**ledger-nexus does NOT cover** (deliberately out of scope):

- ❌ Subscription billing engine (`subscriptions`/`charges`/`usage_records`) — asc606's domain
- ❌ Treasury / debt management (`Debt_instruments` + amortization + covenant_tests)
- ❌ Equity / cap-table (`equity_grants` + vesting + option exercises + fx hedges)
- ❌ FP&A (`budgets`/`forecasts`/`scenarios`) — out of scope
- ❌ Project accounting (`projects`/`project_tasks`/`time_entries`) — out of scope
- ❌ Payroll (`payroll_runs`/`payroll_lines`/`expense_reports`) — out of scope
- ❌ Tax provision engine (`tax_provisions`/`deferred_tax_items` as posted entities; we have reporting only)
- ❌ Approval workflow engine (we have a 4-role × tenant model; NetSuite has multi-step workflows)
- ❌ Compliance test framework (`compliance_controls`/`compliance_tests`) — replaced by our docs/policies/

**Partial coverage:**

- 🟡 Dimension engine — ledger-core Layer 3 covers CLASS/DEPT/LOCATION/custom segments; NetSuite ships the same model
- 🟡 Cash + bank — recon covers reconciliation; deposits/transfers/bill_payments not yet modelled as full sub-ledgers
- 🟡 Intercompany — ledger-core does consolidation on read; NetSuite has explicit `consolidation_processes` runs

---

## How to use this reference

1. **NetSuite mapper validation** — `src/lib/mappers/netsuite/` should be able to absorb every row in the GL-core + AR + AP + Fixed Assets + Lease + Revenue tables. The sample data here is a realistic stress test.

2. **Schema coverage gap detection** — when this doc says "NOT in ledger-nexus" and a real customer needs it, that's the trigger for a new sub-ledger / companion repo.

3. **Demo data scale benchmark** — 77K rows across 174 tables is approximately a mid-market SaaS company at ~$50M-$100M ARR. Our demo seed (28 JEs across 1 month) is intentionally tiny by comparison.

4. **Field-level encryption sample size** — `customers` (505 PII rows × 31 cols) + `vendors` (201 × 27) + `employees` (201 × 24) + `subsidiaries` (17 × 22) is the realistic at-rest-encryption surface a mid-market customer would bring. Our encryption-at-rest rollout covers the equivalent ledger-nexus columns.

5. **Sub-processor + vendor inventory sanity check** — NetSuite's `vendor_*` tables include `vendor_prepayments`, `vendor_credits`, `vendor_return_authorizations`. Our `docs/policies/vendor-management.md` v2.0 only inventories OUR upstream service vendors; customer-side vendors (the kind in `vendors` table) are tenant data, not our subprocessors.

## Source-of-truth files (gitignored)

- Full inventory JSON: `/tmp/netsuite_inventory.json` (174 sheets × headers + row counts)
- High-value snapshot JSON: `/tmp/netsuite_snapshot.json` (36 tables × headers + 2 sample rows)

These are session-local; regenerate from the source XLSX if needed.
