# Schema ERD

Entity-relationship diagram for the `ledger-core` schema as of v0.2 (Layers 1 + 2 of the universal accounting substrate, with empty seams for Layers 3–5). Authored alongside [universal-schema.md](universal-schema.md) — that file holds the architectural decisions; this one shows how those decisions sit in the tables.

Cardinality follows mermaid convention: `||` = exactly one, `|o` = zero or one, `o{` = zero or many. Arrows read from parent (left) to child (right).

```mermaid
erDiagram
    %% ============ Layer 2 — Master Data ============
    LegalEntity {
        uuid id PK
        string code UK "NORTHWIND"
        string name
        uuid parentEntityId FK "self → entity hierarchy"
        string functionalCurrencyId FK "→ Currency"
        json extensions
        string sourceSystem "lineage"
        string sourceRecordId
    }
    Book {
        uuid id PK
        string code UK "US_GAAP US_TAX IFRS"
        enum basis
        string reportingCurrencyId FK
        bool isActive
    }
    Currency {
        string code PK "ISO 4217: USD EUR JPY"
        string name
        int decimals
        string symbol
    }
    FxRate {
        uuid id PK
        string fromCurrencyId FK
        string toCurrencyId FK
        date asOf
        decimal rate
        enum rateType "SPOT AVG CLOSE HIST"
    }
    FiscalCalendar {
        uuid id PK
        uuid entityId FK
        string code UK "STANDARD_2026"
        enum periodFrequency
    }
    Period {
        uuid id PK
        uuid calendarId FK
        string code "2026-01"
        int ordinal
        date startsOn
        date endsOn
    }
    PeriodClose {
        uuid id PK
        uuid entityId FK
        uuid bookId FK
        uuid periodId FK
        datetime closedAt
    }
    Party {
        uuid id PK
        uuid entityId FK "nullable: shared chart"
        string code
        string displayName
        uuid parentPartyId FK "self → job/project parent"
        json extensions
        string sourceSystem
    }
    PartyRole {
        uuid id PK
        uuid partyId FK
        enum role "CUSTOMER VENDOR EMPLOYEE"
    }
    Item {
        uuid id PK
        uuid entityId FK "nullable"
        string code
        enum itemType "INVENTORY SERVICE KIT"
        enum costingMethod
    }

    %% ============ Layer 1 — Posting Substrate ============
    Account {
        uuid id PK
        uuid entityId FK "nullable: shared"
        string code "1xxx Asset 2xxx Liab"
        enum type
        enum normalBalance
        string subtype "CASH AR_TRADE"
        bool isContra
        bool isControlAccount
        bool isBank
        uuid parentAccountId FK "self → hierarchy"
        string_array bookScope "empty=all books"
        json extensions
    }
    JournalEntry {
        uuid id PK
        string entryNumber UK "NORTHWIND-US_GAAP-00001"
        uuid entityId FK
        uuid bookId FK
        uuid periodId FK "nullable: pre-history"
        string currencyId FK
        decimal fxRate
        date documentDate
        date postingDate
        enum status "DRAFT POSTED VOID REVERSED"
        enum source "MANUAL SEED AI_APPROVED IMPORT"
        uuid reversalOfId FK "self → reversal chain"
        string sourceSystem "QBO NETSUITE INTACCT"
        string sourceRecordType
        string sourceRecordId
        json sourcePayload "frozen raw"
        string mappingVersion
        json extensions
    }
    JournalLine {
        uuid id PK
        uuid entryId FK "CASCADE on entry delete"
        int lineNo "1-based"
        uuid accountId FK
        uuid partyId FK "nullable: sub-ledger key"
        uuid itemId FK "nullable: sub-ledger key"
        uuid dimensionSetId FK "nullable: dim engine"
        string taxCodeId "soft ref - no FK"
        decimal debit "XOR credit non-neg"
        decimal credit
        decimal transactionAmount "signed"
        string transactionCurrencyId FK
        decimal reportingAmount "signed"
        string reportingCurrencyId FK
        json extensions
    }

    %% ============ Layer 3 — Dimension Engine ============
    Dimension {
        uuid id PK
        string code UK "DEPARTMENT CLASS LOCATION PROJECT"
        bool isRequired
        json appliesToAccountTypes
    }
    DimensionValue {
        uuid id PK
        uuid dimensionId FK
        string code
        string name
    }
    DimensionSet {
        uuid id PK
        string hash UK "dedup combo"
    }
    DimensionSetValue {
        uuid dimensionSetId PK "composite PK and FK"
        uuid dimensionId PK
        uuid dimensionValueId FK
    }

    %% ============ Layer 4 + 5 ============
    PostingRule {
        uuid id PK
        string sourceEventType "QBO_INVOICE"
        uuid bookId FK
        int ruleVersion
        json template
        bool isActive
    }
    CustomFieldDefinition {
        uuid id PK
        string targetEntityType "soft ref"
        string fieldKey
        enum fieldType
        json validation
        string sourceErpField
    }

    %% ============ Relationships ============
    %% Currency hub
    Currency ||--o{ LegalEntity      : "functional ccy"
    Currency ||--o{ Book             : "reporting ccy"
    Currency ||--o{ FxRate           : "from"
    Currency ||--o{ FxRate           : "to"
    Currency ||--o{ JournalEntry     : "header ccy"
    Currency |o--o{ JournalLine      : "txn ccy"
    Currency |o--o{ JournalLine      : "reporting ccy"

    %% Entity hierarchy + ownership
    LegalEntity ||--o{ LegalEntity   : "parent → sub"
    LegalEntity ||--o{ FiscalCalendar : "owns"
    LegalEntity |o--o{ Account       : "scope (nullable)"
    LegalEntity |o--o{ Party         : "scope (nullable)"
    LegalEntity |o--o{ Item          : "scope (nullable)"
    LegalEntity ||--o{ JournalEntry  : "owns"
    LegalEntity ||--o{ PeriodClose   : ""

    %% Calendar / period / close
    FiscalCalendar ||--o{ Period     : "contains"
    Period |o--o{ JournalEntry       : "in period"
    Period ||--o{ PeriodClose        : ""
    Book   ||--o{ PeriodClose        : ""

    %% Book → posting
    Book ||--o{ JournalEntry         : "in book"
    Book ||--o{ PostingRule          : "rules"

    %% Account hierarchy + posting
    Account ||--o{ Account           : "parent"
    Account ||--o{ JournalLine       : "posts to"

    %% Party / item / sub-ledger
    Party ||--o{ Party               : "parent (jobs/WBS)"
    Party ||--o{ PartyRole           : ""
    Party |o--o{ JournalLine         : "sub-ledger key"
    Item  |o--o{ JournalLine         : "sub-ledger key"

    %% Journal entry → lines + reversal
    JournalEntry ||--o{ JournalLine  : "CASCADE"
    JournalEntry |o--o{ JournalEntry : "reversal chain"

    %% Dimension engine
    Dimension ||--o{ DimensionValue  : ""
    Dimension ||--o{ DimensionSetValue : ""
    DimensionValue ||--o{ DimensionSetValue : ""
    DimensionSet ||--o{ DimensionSetValue : "CASCADE"
    DimensionSet |o--o{ JournalLine  : "dim assignment"
```

## How to read this

**The graph has three centers of gravity.** All arrows ultimately funnel into one of them.

1. **`Currency`** is the universal hub. Every monetary thing in the system traces back to it — entity functional currency, book reporting currency, FX rate pairs, journal entry header currency, and the per-line txn/reporting columns. It uses ISO 4217 codes as its primary key (USD, EUR, JPY), not a UUID, because those codes are globally stable.

2. **`LegalEntity` + `Book`** are the multi-tenancy axis. Every posting belongs to exactly one `(LegalEntity, Book)`. The relationship `LegalEntity ||--o{ JournalEntry` plus `Book ||--o{ JournalEntry` is what makes Pattern 2 (full parallel ledgers) possible: a single source event in the future posting-rules engine fans out into N JournalEntry rows, one per relevant book, all sharing the same `sourceRecordId` in lineage.

3. **`JournalEntry → JournalLine`** is the posting substrate. The `CASCADE` is deliberate: lines never outlive their header. Lines then reach outward into Account (mandatory), Party / Item / DimensionSet (all nullable sub-ledger keys), and Currency (twice — for txn-currency and reporting-currency views of the same signed amount).

## The nullable FKs are intentional

Four "optional parent" edges (`|o--o{`) carry architectural weight:

- **`LegalEntity → Account/Party/Item`** is nullable because the same master record can be shared across entities (consolidated chart) or scoped to one. Setting it to null is "shared"; setting it to an entity is "this-entity-only."
- **`Period → JournalEntry`** is nullable so backfilled pre-go-live historical entries (with no defined fiscal period) can still post.
- **`DimensionSet → JournalLine`** is nullable because QBO data has 0–2 dimensions and NetSuite data has 8+. The same schema absorbs both without a fixed `class_id`/`department_id` column — which is the anti-pattern the dimension engine exists to avoid.
- **`Currency → JournalLine`** (txn + reporting) is nullable because the line typically inherits from the header; only intercompany / FX-gain-loss lines specify per-line currency.

## Self-references (the four loops)

Four tables reference themselves — these are the hierarchies that ERP systems all have but model differently.

- **`LegalEntity → LegalEntity` (parent)**: parent/subsidiary trees for consolidation.
- **`Account → Account` (parent)**: chart of accounts hierarchy (NetSuite parent accounts, Intacct GL hierarchy).
- **`Party → Party` (parent)**: Customer:Job / Project / WBS / Sage Job — all collapse here per the spec's anti-pattern rule.
- **`JournalEntry → JournalEntry` (reversalOf)**: the corrections chain. A reversal links back to the entry it cancels; both stay in the ledger forever.

## What's NOT in this diagram

- The lineage columns (`sourceSystem` / `sourceRecordId` / `sourcePayload` / `mappingVersion`) appear on most entities but they're **not foreign keys** — they reference external ERPs by string, never by UUID. That's why source-system primary keys aren't reused as schema keys (per the spec's anti-pattern list).
- `CustomFieldDefinition` has no FK to any other table — its `targetEntityType` is a string ("party", "gl_entry_line", etc.). The actual values live in each entity's `extensions Json` column. This is the Layer 5 "no EAV" decision in practice.
- The sub-ledger tables that arrive in the next batch — `ArOpenItem`, `ApOpenItem`, `FixedAsset` + `FixedAssetBookAttributes`, `Lease`, `RevenueContract` — would attach to `JournalLine` via `partyId`/`itemId` lifecycles and to `Book` via the `*_book_attributes` join tables. None of those exist yet.
