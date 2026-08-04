# NetSuite SuiteAnalytics-compatible report endpoints — design

> **Port note (2026-06-11, merge train):** two assumptions in this design predate the train's dispositions and are corrected here rather than carried forward:
>
> 1. **No CTA exists on main.** The v0.8 consolidation-translation phases were closed unmerged after math review (PROJECT_STATUS v1.27 — the layer double-applied FX rates; main is on the ASC 830 remeasurement method). The consolidation endpoint below should surface `getConsolidatedTrialBalance`'s actual shape — per-entity columns, eliminations, the multi-currency disclosure flag — and OMIT the CTA / per-entity-translation-rate keys until a future functional-amount arc revives translation. NS-shape compatibility for those keys can return `null`s with a documented caveat if a BI tool requires the keys to exist.
> 2. **"RLS row enforcement" overstates main.** RLS is Phase-1-only — the `withTenantContext` GUC mechanism is wired but NO policies exist and enforcement is deliberately deferred (deficiency #12, user-gated). The real control for these endpoints is the explicit `tenantId` claim on `external_api_token` plus app-level tenant-scoped WHERE clauses on every query — which the implementation PRs must carry explicitly, not delegate to RLS. Token comparison must use `crypto.timingSafeEqual` per the repo baseline.


**Status:** Phase 1 design · **Author:** Claude (with Chris) · **Created:** 2026-06-08

## Problem

The v0.7/v0.8/v0.9 NS arcs all flow data IN: NS OneWorld exports → ledger-core via the import mapper. End-to-end roundtrip is preserved via the reverse exporter, but that's a *re-export* of the same NS shape we imported — not a fresh report.

What's missing: data flow OUT. An external NS-ecosystem tool (BI dashboard, audit firm's analytics platform, FP&A spreadsheet) expects to call NetSuite's report API and get back NS-shaped data. Today, those tools can't talk to ledger-core. The operator has to manually export from `/reports/*/csv`, transform to NS shape, then upload — defeating the substrate's "drop-in NS replacement" thesis.

NetSuite's analytics surface has three primary layers:

1. **REST/SOAP report endpoints** — operators pull TB / IS / BS / cash-flow as JSON via authenticated API. Each endpoint takes `(subsidiary, accountingBook, asOfDate)` and returns NS's canonical report shape.
2. **Saved Searches** — NS-native query objects with field projections and result paging. The API expects a `savedSearchId` + filter params.
3. **SuiteAnalytics Connect** (ODBC/JDBC) — read-only DB access for BI tools. Maps NS's analytical schema to standard SQL.

ledger-core already has equivalent report data via `getTrialBalance`, `getIncomeStatement`, `getBalanceSheet`, `getConsolidatedTrialBalance`, etc. What's missing is **NS-shaped HTTP delivery** of that data so external tools see a NetSuite-compatible API surface.

This proposal wires HTTP endpoints that:

> Drop a SuiteAnalytics-aware BI tool against ledger-core's API → it sees the same JSON shapes it expects from a real NS instance → reports render side-by-side with whatever it would have shown for a real NS tenant.

## Goals

1. **REST endpoints for the core 4 reports** — TB, IS, BS, cash-flow — in NS's canonical JSON shape (field names, nesting, currency formatting).
2. **`subsidiary` + `accountingBook` parameters** drive the report scope, matching how NS receives them (NS internalid form preserved via lineage).
3. **Authentication via token** — same pattern as `/api/internal/journal-entries` (companion-repo gateway). Bearer token from `NS_SUITEANALYTICS_TOKEN` env, NOT OAuth (which NS uses) — SOC 2 token rotation policy already covers this shape.
4. **Saved-Search-style query endpoint** that takes a JSON-schema query object (filters + projections) and returns paged rows. Phase 4 of the arc.
5. **Multi-book aware** — the BTD report endpoint emits per-book column pairs matching how SuiteAnalytics returns book-tax difference today.
6. **Lineage-stable internalids** — every entity / book / account in the response uses the original NS `internalid` (preserved via the v0.7 lineage triple), so external tools' caches map cleanly between this ledger-core's response and the original NS data.

## Non-goals (deferred to follow-up phases)

- **OAuth 1.0a / TBA authentication** — NS uses Token-Based Authentication for SuiteAnalytics. ledger-core's bearer token is simpler + matches our existing SOC 2 token-rotation pattern. Operators wiring an actual NS-replacement BI tool will need an adapter shim; we explicitly document that adapter shape in Phase 4.
- **SOAP envelope** — pure REST. Legacy SOAP callers are vanishingly rare in BI tools; if a real customer needs SOAP, a separate proxy converts.
- **Real-time streaming endpoints** — SuiteAnalytics Connect supports JDBC streaming for large result sets. Phase 1-5 are batch JSON-over-HTTP. Streaming is a Phase 6+ topic if needed.
- **Custom-segment as a top-level filter** — SuiteAnalytics lets you query by custom segment values. We have the dimension engine (Layer 3) that powers this internally, but the public endpoint shape in Phase 1-5 only takes `subsidiary` + `accountingBook`. Custom-segment filtering is a Phase 5+ enhancement once we see what real callers want.
- **Pivot / aggregation endpoints** — Saved Searches in NS support GROUP BY + aggregate functions. Phase 4 of this arc emits raw rows; the calling tool handles pivots. Native aggregation is Phase 6+.

## Design

### Phase 1 — endpoint surface + auth

Three endpoints, all under `/api/external/ns-analytics/`:

```
GET /api/external/ns-analytics/trial-balance
GET /api/external/ns-analytics/income-statement
GET /api/external/ns-analytics/balance-sheet
```

Common query params:
- `subsidiary` (required) — NS subsidiary internalid (e.g. `"1"`). Mapped to ledger-core `LegalEntity` via the `extensions.nsInternalid` written by v0.7 importer.
- `accountingBook` (required) — NS accounting-book internalid (e.g. `"1"`). Mapped to ledger-core `Book` via the v0.9 `Book.extensions.nsAccountingBookSourcePayloads` stash from Phase 4.5.
- `asOfDate` (TB + BS) or `fromDate`/`toDate` (IS) — ISO 8601 dates.
- `format=json` (default) | `csv` — same shape, different encoding.

Auth: `Authorization: Bearer <NS_SUITEANALYTICS_TOKEN>`. Token rotated quarterly per the SOC 2 policy.

Response shape mirrors NS's `tranBalanceSummary` / `incomeStatement` / `balanceSheet` REST response — see the Implementation Notes section below for the exact field-mapping table.

### Phase 2 — NS internalid resolution layer

A new `src/lib/external/ns-id-resolver.ts` module:

```typescript
// NS subsidiary internalid → ledger-core entityCode.
// Reads LegalEntity.extensions.nsInternalid (populated by v0.7 importer).
export async function resolveNsSubsidiary(
  prisma: PrismaClient,
  nsInternalid: string
): Promise<{ entityCode: string; entityId: string } | null>;

// NS accounting-book internalid → ledger-core bookCode.
// Reads Book.extensions.nsAccountingBookSourcePayloads (populated by
// v0.9 Phase 4.5 setupBooks).
export async function resolveNsAccountingBook(
  prisma: PrismaClient,
  nsInternalid: string
): Promise<{ bookCode: string; bookId: string } | null>;

// NS account internalid → ledger-core account code.
// Reads Account.sourceRecordId (populated by v0.6 importer).
export async function resolveNsAccount(...): Promise<...>;
```

Each resolver returns `null` on miss; the endpoint layer surfaces 404 with the unmapped internalid in the error body. Operators see "Subsidiary 99 not imported" rather than a silent empty result.

### Phase 3 — shape mapper

A new `src/lib/external/ns-report-shapes.ts` module that takes the existing `TrialBalanceRow` / `IncomeStatement` / `BalanceSheet` shapes and emits NS-canonical JSON:

```typescript
export function toNsTrialBalance(
  internal: TrialBalanceRow[],
  context: { subsidiaryInternalid: string; bookInternalid: string; asOfDate: string }
): NsTrialBalanceResponse;
```

Field-mapping table (from real NS SuiteAnalytics responses observed in the wild):

| Ledger-core field | NS field | Notes |
|---|---|---|
| `account.code` | `account.acctnumber` | Direct |
| `account.name` | `account.acctname` | Direct |
| `account.type` | `account.accttype` | Map our `ASSET` → NS `Bank`/`AcctRec`/`OthCurAsset`/etc. via subtype |
| `debitBalance` | `debitamount` | Format to 4 decimals |
| `creditBalance` | `creditamount` | Format to 4 decimals |
| `entity.code` | `subsidiary.internalid` | Map via lineage |
| `book.code` | `accountingBook.internalid` | Map via lineage |

The mapper is pure — no DB access. Phase 2 resolvers handle the lineage lookup at the endpoint layer; the mapper just shapes already-resolved data.

### Phase 4 — Saved-Search-style query endpoint

`POST /api/external/ns-analytics/saved-search`. Body shape:

```json
{
  "searchType": "Transaction",
  "filters": [
    { "field": "trandate", "operator": "WITHIN", "values": ["2026-04-01", "2026-04-30"] },
    { "field": "type", "operator": "ANYOF", "values": ["Invoice", "VendorBill"] }
  ],
  "columns": [
    { "field": "internalid" },
    { "field": "tranid" },
    { "field": "amount" },
    { "field": "trandate" }
  ],
  "page": 1,
  "pageSize": 100
}
```

Translation strategy: each `searchType` maps to a ledger-core query template (JournalEntry, Invoice via lineage filter, etc.). `filters[]` is whitelisted (only safe operators per type) — no arbitrary SQL injection surface. `columns[]` selects fields from the template's projection. Pagination is offset-based (NS uses ID-based; we accept either).

Hard limits:
- `pageSize ≤ 1000` (NS cap is 1000)
- 10 filters max per request (DoS guard)
- Whitelisted `searchType` only — unknown types return 400, not 500.

### Phase 5 — multi-entity / consolidation endpoint

`GET /api/external/ns-analytics/consolidated-trial-balance`:

- `rootSubsidiary` parameter (NS internalid).
- Walks the LegalEntity hierarchy + emits the consolidated TB from `getConsolidatedTrialBalance`.
- Per-entity columns matching SuiteAnalytics's `subsidiaryelimination` shape (each row has `perSubsidiary[]` with subsidiary internalid + amounts).
- CTA + per-entity translation rate surfaced as separate top-level keys, matching how NS exposes these in its translation reports.

## Phasing

### Phase 1 — endpoint surface + auth (1 PR)

- Three GET endpoints under `/api/external/ns-analytics/{trial-balance,income-statement,balance-sheet}`.
- Token-based auth via `NS_SUITEANALYTICS_TOKEN`.
- Audit log entry per call (eventType `DATA_EXPORT`).
- Rate limiting: 60 req/min per token (SOC 2 CC7.2).
- Integration test: token validation + auth failures + successful TB response.

### Phase 2 — NS internalid resolution layer (1 PR)

- `src/lib/external/ns-id-resolver.ts` with the three resolvers.
- Unit test per resolver: hit + miss + ambiguity case (operator imported same NS internalid via two prefixes — should resolve deterministically by `extensions.nsImportedAt` recency).
- 404 with structured error body when resolver returns null.

### Phase 3 — shape mapper (1 PR)

- `src/lib/external/ns-report-shapes.ts` with `toNsTrialBalance`, `toNsIncomeStatement`, `toNsBalanceSheet`.
- Field-by-field mapping per the table in Design above.
- Pure unit tests against canned NS sample responses (saved from real NS exports for fidelity verification).

### Phase 4 — Saved-Search-style query endpoint (1 PR)

- `POST /api/external/ns-analytics/saved-search`.
- Per-searchType query template registry. Phase 4 ships `Transaction`, `Account`, `Customer`, `Vendor`, `Item`.
- Filter operator whitelist per field type (date ranges, enum ANYOF, numeric range, exact match).
- Pagination + result-count headers (`X-Total-Count`).
- Integration test per searchType + filter-injection attempt tests.

### Phase 5 — consolidation endpoint + arc completion (1 PR)

- `GET /api/external/ns-analytics/consolidated-trial-balance`.
- Per-entity columns + CTA + translation rates.
- Integration test against the v0.7/v0.8 multi-sub + multi-book + FX fixture.
- Update PROJECT_STATUS + capstone doc.

## Authentication contract (load-bearing)

Token shape:

```
NS_SUITEANALYTICS_TOKEN=64-char-hex-string-with-checksum
```

Validation pipeline:

1. Extract `Authorization: Bearer ...`.
2. Constant-time compare against env value (the existing `constantTimeEquals` helper from the SOC 2 baseline).
3. Hash + log the token's first 8 chars in the audit row (rotation traceability without storing the secret).
4. Rate-limit by SHA-256 of the token (60 req/min default).

Rotation policy: quarterly. The SOC 2 token-rotation runbook already covers internal API tokens; this is added to the same roster.

## Risk + open questions

- **Field-mapping fidelity**: NS SuiteAnalytics responses have evolved over the years. The mapping table above is based on observed responses. Real-world deployments may discover edge cases (custom field passthrough, currency formatting nuance). We commit to a "best-effort canonical shape" — operators flagging fidelity gaps get follow-up PRs.
- **NS authentication asymmetry**: Real NS uses OAuth 1.0a TBA. BI tools wiring to "ledger-core as a SuiteAnalytics replacement" need an adapter shim that bridges Bearer ↔ OAuth. We document this in the Phase 1 README — not in scope for the arc itself.
- **Multi-tenant token scoping**: every token must scope to ONE tenant. The endpoint reads `tenantId` from the token row (a new table `external_api_token`) and forwards it through Prisma's tenant-context middleware. The SOC 2 RLS pattern handles row-level enforcement; the endpoint layer enforces the explicit tenant claim.
- **PII in error responses**: 404 with "Subsidiary 99 not imported" is fine; 500 with stack-trace details is NOT. The catch-all error handler from the existing `/api/internal/*` pattern (sanitize, log internal, return generic) carries over.
- **CSV alternative**: every endpoint also accepts `format=csv` for ETL pipelines that prefer flat tables. CSV shape mirrors the JSON projection — no separate schema.

## Related arcs

- **v0.6 NS mapper**: provides the lineage substrate (`Account.sourceRecordId`, etc.) that the resolvers consume.
- **v0.7 NS multi-subsidiary**: `LegalEntity.extensions.nsInternalid` powers the subsidiary resolver.
- **v0.8 ASC 830 FX translation**: the consolidation endpoint reuses the same `getConsolidatedTrialBalance` per-entity rates + CTA shape.
- **v0.9 NS Accounting Books**: `Book.extensions.nsAccountingBookSourcePayloads` powers the accounting-book resolver. Multi-book TB endpoints just take `accountingBook` param + resolve.
- **`/api/internal/journal-entries`**: the bearer-token + audit-log pattern reuses what that endpoint pioneered. The new endpoints are the *outbound* analog of the inbound JE-post endpoint.

## What the arc delivers

End-to-end, after the 5 implementation PRs:

1. An NS-ecosystem BI tool with a SuiteAnalytics adapter points at ledger-core's `/api/external/ns-analytics/trial-balance` with `{ subsidiary, accountingBook, asOfDate }` and a valid token.
2. ledger-core resolves the NS internalids to ledger-core entity + book codes via the lineage tables.
3. `getTrialBalance(...)` runs against the resolved scope.
4. The shape mapper emits NS-canonical JSON.
5. The BI tool sees a response identical to what it would receive from a real NS tenant.

The substrate's "drop-in NS replacement" thesis now extends in BOTH directions: imports flow in via v0.6-v0.9; reports flow out via this new arc.
