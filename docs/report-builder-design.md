# Report Builder — Design

**Status:** Design — execution deferred to a future session
**Estimated scope:** 6-PR architectural arc
**Date:** 2026-06-09

## Problem statement

Each of ledger-core's financial reports today (`getTrialBalance`, `getIncomeStatement`, `getBalanceSheet`, `getCashFlowStatement`, `getBookTaxDifference`, `getConsolidatedTrialBalance`, `getM3Detail`, AR/AP aging) is a hand-coded function in `src/lib/accounting/reports/`. Adding a new report — or letting a user compose one — requires writing TS code, a UI page, a CSV route, a (possibly) NS shape mapper, and tests. There is no presentation DSL.

Additionally, the GAAP-4 financial statements are incomplete: ledger-core ships Income Statement, Balance Sheet, and Cash Flow Statement, but **not Statement of Stockholders' Equity** (the 4th).

This doc proposes a report builder modeled on NetSuite's Financial Report Builder, with the 4 GAAP financial statements as defaults shipped out of the box and user-saved custom reports persisted as `ReportTemplate` rows.

## Reference research: how QBO and NetSuite present the 4 financials

### QuickBooks Online

- **Hard-coded standard reports** (~80) compiled from the same underlying TB.
- Customization = filter / group / column toggles in UI; not a real composition DSL.
- **Cash vs. accrual toggle** is a top-level switch affecting which transactions are included (timing of revenue/expense recognition).
- **Drill-down**: click any number → underlying transactions.
- **Memorized reports** — save customizations; schedule email delivery.
- **Class / Location filters** as the primary "slice this report differently" lever.
- **Statement of Equity** is minimal — Net Income roll-up + owner contributions/distributions.

### NetSuite Financial Report Builder (the architectural model)

NetSuite has three separate report systems:

1. **Standard Reports** — fixed, like QBO's
2. **Financial Report Builder** — actual builder for financial statements ← *this is what we emulate*
3. **Saved Searches / SuiteAnalytics Workbook** — analytical (transaction-level multi-dim queries)

The Financial Report Builder architecture:

- **Row layout = hierarchical tree of sections.** Each section declares:
  - `accountCriteria` (type / subtype / parent / explicit list)
  - `sectionType: detail | summary | formula | spacer`
  - `signFlip` (revenue presents positive even though credit-normal)
  - `subtotal` flag
  - Nested children sections
- **Column layout = orthogonal axis.** Independent DSL:
  - Period offsets (Current month, Prior month, Current YTD, Prior YTD)
  - Book override per column
  - Subsidiary override per column
  - Currency override per column
  - Variance columns (Current − Prior, % change)
- **Formula rows** — `Gross Profit = Revenue − COGS` as a first-class row referencing other row IDs. Computed at render, not stored.
- **Headers / footers** — Net Income as a footer that flows into Statement of Stockholders' Equity (cross-report linking).
- **Statement of Stockholders' Equity** specifically: matrix layout. Columns = equity components (Common Stock, APIC, Retained Earnings, AOCI). Rows = beginning balance, net income, distributions, OCI, ending balance.
- **Saved as `Financial Layout` records** — versionable; one Layout usable for IS across all subsidiaries.
- **Drill-down at every cell** — see contributing TB rows → JE lines.
- **Cash vs. accrual toggle** maps to "alternate book" mechanism (NetSuite's `AccountingBook`).

### What both share architecturally

1. **Math layer is the same TB primitive for every report.** Both compute account balances once per `(scope, asOf or period)`, then filter/group/sign-flip per statement.
2. **Presentation is a templating DSL** — rows + columns as data, not code.
3. **Default templates ship out-of-the-box** but are editable + clonable.
4. **Multi-book / multi-currency / multi-subsidiary** are first-class column dimensions, not separate reports.

## Proposed architecture for ledger-core

### Layer separation

```
┌────────────────────────────────────────────────────────────┐
│ Layer 4 — PRESENTATION                                     │
│   ReportTemplate (DB-persisted DSL) + renderTemplate()     │
│   Default 4 financials ship as code constants              │
│   User-saved templates stored as JSON in ReportTemplate    │
├────────────────────────────────────────────────────────────┤
│ Layer 3 — COLUMN ENGINE                                    │
│   Expands column DSL → list of (scope, asOf/period, book,  │
│   entity, currency) tuples                                 │
│   Calls row engine once per tuple, assembles matrix        │
├────────────────────────────────────────────────────────────┤
│ Layer 2 — ROW ENGINE                                       │
│   Takes a row tree + scope → walks the tree, filters       │
│   accounts per section, computes subtotals, evaluates      │
│   FORMULA rows                                             │
│   Returns RenderedRow[] with sign-flipped values           │
├────────────────────────────────────────────────────────────┤
│ Layer 1 — MATH PRIMITIVE                                   │
│   getAccountBalances(prisma, { entity, book, asOf })       │
│   → Map<accountCode, { debit, credit, balance }>           │
│   Extracted from getTrialBalance — same math, lighter shape│
└────────────────────────────────────────────────────────────┘
```

### Type definitions

```ts
// ---- Layer 2: Row layout ------------------------------------------

type AccountFilter = {
  types?: AccountType[];          // ["REVENUE"] or ["ASSET", "LIABILITY"]
  subtypes?: string[];            // ["CASH", "AR_TRADE"]
  parentCodes?: string[];         // roll up everything under "1000" parent
  includeCodes?: string[];        // explicit inclusion (overrides type/subtype)
  excludeCodes?: string[];        // explicit exclusion after type/subtype
};

type RowDef =
  | {
      id: string;
      kind: "ACCOUNTS";
      label: string;
      filter: AccountFilter;
      signFlip?: boolean;         // present credit balances as positive (Revenue)
      showAccountDetail?: boolean; // expand to per-account rows or roll up
    }
  | {
      id: string;
      kind: "SUBTOTAL";
      label: string;
      childIds: string[];         // references to other RowDef.ids
      signFlip?: boolean;
    }
  | {
      id: string;
      kind: "FORMULA";
      label: string;
      add?: string[];             // row IDs to add
      subtract?: string[];        // row IDs to subtract
      // Future: full expression parser. v1 sticks to add/subtract for
      // safety — 95% of financial-statement formulas fit this shape.
    }
  | {
      id: string;
      kind: "PERIOD_DELTA";       // Cash Flow Statement support
      label: string;
      filter: AccountFilter;
      direction?: "increase" | "decrease"; // sign treatment for working-cap changes
    }
  | { id: string; kind: "SPACER" }
  | { id: string; kind: "HEADER"; label: string };

// ---- Layer 3: Column layout ---------------------------------------

type ColumnScope = {
  entityCode: string;
  bookCode: string;
  asOf?: Date;                    // for point-in-time (BS / Equity ending balance)
  period?: { fromDate: Date; toDate: Date };  // for range (IS / Cash Flow)
  currencyCode?: string;          // null = book's reporting currency
};

type PeriodOffset =
  | { type: "current"; basis: "MONTH" | "QUARTER" | "YEAR" | "YTD" | "QTD" }
  | { type: "prior"; basis: "MONTH" | "QUARTER" | "YEAR" | "YTD" | "QTD"; offset: number }
  | { type: "absolute"; asOf?: string; fromDate?: string; toDate?: string };

type ColumnDef =
  | {
      id: string;
      kind: "SCOPE";              // a real column tied to an actual scope
      label: string;
      scope: ColumnScope | { offset: PeriodOffset };  // resolved at render
    }
  | {
      id: string;
      kind: "VARIANCE";           // computed column
      label: string;
      from: string;               // column id
      to: string;                 // column id
      format: "money" | "percent";
    };

// ---- Layer 4: Template --------------------------------------------

type ReportTemplate = {
  code: string;                   // "IS" / "BS" / "CF" / "EQ" / "MY-CUSTOM-1"
  name: string;
  version: number;
  rows: RowDef[];
  columns: ColumnDef[];
  presentation: {
    moneyFormat?: { decimals: number; thousands: boolean; parens: boolean };
    showDrillDown?: boolean;
    showAccountCodes?: boolean;
  };
  // Cross-template references (e.g., Equity statement reads IS net income):
  references?: Array<{ alias: string; templateCode: string; rowId: string }>;
};

// ---- Render output ------------------------------------------------

type RenderedCell = {
  value: Decimal;
  display: string;                // formatted per presentation
  drillDown?: {
    accountCodes: string[];
    scope: ColumnScope;
  };
};

type RenderedRow = {
  id: string;
  label: string;
  cells: RenderedCell[];          // one per column
  indent?: number;                 // visual nesting from SUBTOTAL nodes
  isSubtotal?: boolean;
  isFormula?: boolean;
};

type RenderedMatrix = {
  template: ReportTemplate;
  columns: Array<{ id: string; label: string }>;
  rows: RenderedRow[];
};
```

### The 4 default templates

These ship as code constants in `src/lib/accounting/reports/templates/`. Editable, clonable, but canonical defaults.

**Income Statement** (`templates/income-statement.ts`):

```ts
export const IS_TEMPLATE: ReportTemplate = {
  code: "IS",
  name: "Income Statement",
  version: 1,
  rows: [
    { id: "rev",   kind: "ACCOUNTS", label: "Revenue",         filter: { types: ["REVENUE"] }, signFlip: true },
    { id: "cogs",  kind: "ACCOUNTS", label: "Cost of goods sold", filter: { subtypes: ["COGS"] } },
    { id: "gp",    kind: "FORMULA",  label: "Gross profit",    add: ["rev"], subtract: ["cogs"] },
    { id: "opex",  kind: "ACCOUNTS", label: "Operating expenses", filter: { types: ["EXPENSE"], excludeCodes: COGS_CODES } },
    { id: "opinc", kind: "FORMULA",  label: "Operating income", add: ["gp"], subtract: ["opex"] },
    { id: "tax",   kind: "ACCOUNTS", label: "Income tax",      filter: { subtypes: ["INCOME_TAX_EXPENSE"] } },
    { id: "ni",    kind: "FORMULA",  label: "Net income",      add: ["opinc"], subtract: ["tax"] },
  ],
  columns: [
    { id: "current", kind: "SCOPE", label: "Current period", scope: { offset: { type: "current", basis: "YTD" } } },
  ],
  presentation: { showDrillDown: true },
};
```

**Balance Sheet** — Current Assets, Non-Current Assets, Total Assets; Current Liabilities, Non-Current Liabilities, Total Liabilities; Equity sections; Total Liabilities + Equity. Each top section is a SUBTOTAL node.

**Cash Flow Statement** — uses `PERIOD_DELTA` rows for working-capital changes plus a cross-template reference to `IS.ni` for the starting Net Income. Honest caveat: indirect-method math doesn't fit cleanly into the row engine; this template may carry more special-case logic than IS / BS.

**Statement of Stockholders' Equity** (the new one — proves the builder works):

```ts
export const EQUITY_TEMPLATE: ReportTemplate = {
  code: "EQ",
  name: "Statement of Stockholders' Equity",
  version: 1,
  rows: [
    { id: "begin", kind: "ACCOUNTS", label: "Beginning balance",
      filter: { types: ["EQUITY"] }, signFlip: true,
      // asOf = period start (handled by special column scope below)
    },
    { id: "ni",    kind: "FORMULA",  label: "Net income",
      add: ["@IS.ni"]  // cross-template reference
    },
    { id: "ctb",   kind: "ACCOUNTS", label: "Contributions",
      filter: { subtypes: ["EQUITY_CONTRIBUTION"] }, signFlip: true },
    { id: "dist",  kind: "ACCOUNTS", label: "Distributions",
      filter: { subtypes: ["EQUITY_DISTRIBUTION"] } },
    { id: "oci",   kind: "ACCOUNTS", label: "Other comprehensive income",
      filter: { subtypes: ["OCI"] }, signFlip: true },
    { id: "end",   kind: "FORMULA",  label: "Ending balance",
      add: ["begin", "ni", "ctb", "oci"], subtract: ["dist"] },
  ],
  columns: [
    // One column per equity sub-category — Common Stock, APIC, Retained
    // Earnings, AOCI. Each column scopes to the same period but filters
    // its ACCOUNTS rows by subtype.
    { id: "cs",    kind: "SCOPE", label: "Common Stock",       scope: { /* subtype filter merged at column level — open question */ } },
    { id: "apic",  kind: "SCOPE", label: "Additional Paid-in Capital", scope: { /* ... */ } },
    { id: "re",    kind: "SCOPE", label: "Retained Earnings",  scope: { /* ... */ } },
    { id: "aoci",  kind: "SCOPE", label: "AOCI",               scope: { /* ... */ } },
    { id: "total", kind: "VARIANCE", label: "Total", from: "cs", to: "aoci", format: "money" },
  ],
  references: [{ alias: "@IS.ni", templateCode: "IS", rowId: "ni" }],
};
```

**Open question on Equity:** matrix layout requires column-level account filtering (column "Common Stock" filters Equity rows to Common Stock subtype only). The current `ColumnDef` shape doesn't have a column-level filter — needs a small extension.

### Cash vs. accrual toggle

Maps to the `bookCode` parameter on the column scope. ledger-core's existing `TAX_CASH_BASIS` book IS the cash-basis view. A user toggling "Cash basis" just swaps the column scope's `bookCode`. No special engine work.

### Multi-currency / multi-entity

Columns can override:
- `currencyCode` → triggers translation via existing `getTranslationRate`
- `entityCode` → either a different entity, or the parent (consolidation)

When consolidating, the column engine routes through `getConsolidatedTrialBalance` instead of `getAccountBalances`. The row engine doesn't need to know about this — the math primitive returns balance-by-code either way.

### Drill-down

Every `RenderedCell` carries `drillDown.accountCodes + scope`. Clicking it deep-links to `/journal-entries?accountCode=X&entityCode=Y&bookCode=Z&fromDate=...&toDate=...` — which the JE list page already supports. No new infrastructure.

### Persistence

```prisma
model ReportTemplate {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId    String   @db.Uuid
  tenant      Tenant   @relation(fields: [tenantId], references: [id])
  code        String                                  // "IS" / "BS" / "MY-CUSTOM-1"
  name        String
  isSystem    Boolean  @default(false)                // true for the 4 defaults; non-editable per-tenant
  definition  Json                                    // serialized RowDef[] + ColumnDef[] + presentation
  version     Int      @default(1)
  createdBy   String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([tenantId, code])
  @@index([tenantId])
  @@map("report_template")
}
```

System templates seed via migration (4 rows per tenant, `isSystem: true`). User-cloned templates are user-editable copies with new codes.

### UI shape

```
/reports                 — list (System + Custom)
/reports/[code]          — render
/reports/[code]/customize — clone + edit (admin only for system)
/reports/new             — fresh template (blank or based on a system one)
```

Render: rows + columns matrix. Formula cells highlighted. Subtotals bolded. Drill-down on click. CSV / PDF downloads via per-template CSV/PDF route handlers.

## Honest scope: 6-PR arc

| PR | Title | Files of note |
|---|---|---|
| 1 | Design doc + schema + system-template seed | This doc + `prisma/migrations/0013_report_template/migration.sql` + `prisma/seed/report-templates.ts` |
| 2 | Math primitive + Row engine | `src/lib/accounting/reports/builder/balances.ts`, `row-engine.ts`, unit tests against Northwind |
| 3 | Column engine + renderer | `src/lib/accounting/reports/builder/column-engine.ts`, `render.ts`, integration tests |
| 4 | Statement of Stockholders' Equity built via the builder | `templates/equity.ts`, e2e test against Northwind seed (proves the builder works on a NEW report) |
| 5 | Re-implement IS / BS on top of the builder | `templates/income-statement.ts`, `templates/balance-sheet.ts`; deprecate `getIncomeStatement`/`getBalanceSheet` (keep as compatibility shims pointing at the builder) |
| 6 | CSV + PDF route generators + UI matrix renderer | `/reports/[code]/route.ts`, `/reports/[code]/page.tsx` |

**Out of arc, follow-up:**
- UI builder at `/reports/[code]/customize` for editing templates (real WYSIWYG)
- Period-comparison columns (Current / Prior / Variance) as templated columns
- Cross-template references (Equity reading IS.ni) — Phase 2 of the arc
- Cash Flow Statement on the builder — may stay hand-coded; indirect-method math doesn't fit cleanly

## Risks + open questions

1. **Cash Flow Statement may not fit.** Indirect method works on period-over-period balance deltas plus account-classification heuristic (OPERATING vs. INVESTING vs. FINANCING). The `PERIOD_DELTA` row kind plus cross-template `@IS.ni` reference covers the structure, but the classification heuristic is currently embedded in `getCashFlowStatement`. May ship as a "hybrid" — builder-style template wrapping the existing math.

2. **Equity statement matrix layout.** Current `ColumnDef` doesn't support column-level filters. Either extend the type or accept that Equity needs its own specialized renderer. The latter is honest: GAAP equity matrices are sui generis.

3. **Formula expression power.** v1 uses `add: string[]` + `subtract: string[]` arrays. Covers basic financial formulas but not, e.g., `(revenue - cogs) / revenue` for gross margin %. Future: real expression parser. Don't ship v1 with `eval` — security.

4. **Cross-template references.** Equity reads IS.ni. Requires evaluating IS first, caching the result, then evaluating Equity. Possible to express as a DAG; v1 hard-codes the dependency.

5. **Multi-tenant template seeding.** System templates need to seed for every tenant on tenant creation (not at migration). Plumb through `onTenantCreate` hook or seed lazily on first read.

6. **RLS interaction.** When RLS Phase 3 lands (deficiency #12), the report engine queries are inside `withTenantContext`. The math primitive query goes through Prisma which honors the GUC. No special work needed; just ensure the engine doesn't bypass.

7. **Performance.** The math primitive runs ONCE per `(entity, book, asOf)` tuple. Column engine deduplicates — if 5 columns share `(SUB1, US_GAAP, 2026-06-30)`, the underlying balance query runs once. Important for period-comparison columns where current + prior YTD share most accounts.

8. **Drill-down filter shape.** JE list page filter (`accountCode + entityCode + bookCode + fromDate + toDate`) needs verification — does it actually support all these query params today? If not, that's a small adjacent PR.

9. **Sub-Equity sign conventions.** Contributions: credit-normal (cash to equity = Cr Equity). Display in equity matrix: positive (added to equity). signFlip = true. Distributions: debit (Dr Equity, Cr Cash). Display: positive (subtracted from equity). signFlip = false. Worth a unit test row.

10. **Cash Flow's "Δ AR" working capital adjustment.** AR DEC = cash INC. Sign convention non-obvious. Document in the template or carry as a special direction flag on `PERIOD_DELTA`.

## Why this design doc tonight, not the implementation

The 6-PR arc is a real architectural commitment. Each PR is bounded but the total is multi-session work. Starting it tonight at end-of-session would leave half-done work. The doc above front-loads every decision so the next session is executional — no architectural choice points remain.

Decisions locked:
- Layer separation (math / row / column / presentation)
- Row engine type system (5 kinds: ACCOUNTS / SUBTOTAL / FORMULA / PERIOD_DELTA / SPACER + HEADER)
- Column engine type system (SCOPE / VARIANCE with PeriodOffset DSL)
- Persistence shape (`ReportTemplate` Json column, `isSystem` flag, per-tenant cloning)
- Default 4 templates ship as code constants seeded per tenant
- Cash vs. accrual = bookCode override at column scope
- Multi-currency = currencyCode override; translation via existing `getTranslationRate`
- Drill-down = link to existing JE list page filter
- Statement of Stockholders' Equity is the proof-of-builder PR (PR 4)
- IS / BS re-implemented on builder (PR 5); old functions become compatibility shims
- Cash Flow may stay hand-coded — flagged as risk

Open questions to resolve in PR 2 design:
- Column-level account filters (Equity matrix)
- Cross-template references DAG resolution
- Tenant seeding mechanism (`onTenantCreate` hook vs. lazy)

Verification checklist for arc closure (when PR 6 lands):
- [ ] 4 default templates (IS, BS, Cash Flow, Equity) ship as system templates
- [ ] Equity statement is the 4th GAAP financial — net new feature
- [ ] Old `getIncomeStatement`, `getBalanceSheet` are compatibility shims pointing at the builder
- [ ] User can clone a system template and customize
- [ ] CSV + PDF export work for custom templates
- [ ] Drill-down works on every cell
- [ ] Cash vs. accrual toggle works via book override
- [ ] Multi-book and multi-entity columns supported
- [ ] CLAUDE.md updated with "Report builder" section
- [ ] PROJECT_STATUS captures the arc closure
