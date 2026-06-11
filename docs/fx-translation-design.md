# FX translation arc — design

**Status:** Phase 1 design + first implementation step · **Author:** Claude (with Chris) · **Created:** 2026-06-06

## Problem

After v0.7 NS multi-sub landed, the consolidation report can walk a hierarchy with mixed functional currencies — but it sums each entity's debit/credit values naïvely, without FX translation. PR #144 added a disclosure banner so the limitation is visible. This arc closes the gap properly.

The v0.7 demo's UK invoice (GBP 1,000 on the UK sub) currently gets stored with `debit = 1000` and `credit = 0` in the JournalLine — implicitly treated as USD 1,000 by every downstream report. A CPA looking at the consolidated TB sees GBP and USD numbers summed without distinction.

## Root cause

`postJournalEntry` already accepts an `fxRate` parameter and computes `reportingAmount = signed * fxRate`. The schema already has:

- `JournalLine.transactionAmount` + `transactionCurrencyId` — the original-currency view
- `JournalLine.debit` / `credit` — **the canonical pair in the BOOK's reporting currency** (per the schema comment)
- `JournalLine.reportingAmount` + `reportingCurrencyId` — the reporting-currency view

The **caller** is responsible for converting `debit`/`credit` into the book's reporting currency before calling `postJournalEntry`. The NS importer never does this — it dumps NS-native amounts straight into `debit`/`credit` and lets `fxRate` default to 1.

So the architecture is right; the importer is incomplete.

## Goals

1. **NS importer reads each transaction's `currency` field**, looks up the active `FxRate` for `(transactionCurrency, bookReportingCurrency, transactionDate)`, converts `debit`/`credit` to reporting currency, and passes `fxRate` to `postJournalEntry`.
2. **`transactionAmount` + `transactionCurrencyId` are populated** so the original-currency view is preserved for reverse export + per-currency reports.
3. **Operators can seed `FxRate` rows** ahead of time (Northwind seed gains USD/GBP/EUR baseline rates so demos work out of the box).
4. **Consolidation report becomes correct in mixed-currency scenarios** without modifying the consolidation code at all — the per-line debit/credit values are already in the book's reporting currency, so the existing sum-by-(account, debit/credit) logic just works.
5. **Multi-currency disclosure banner stays** until the entire arc is verified. PR #144 explicitly says it stays until the FX arc lands; this arc's Phase 4 removes it.

## Non-goals (deferred to follow-up phases)

- **CTA (Cumulative Translation Adjustment) accounting per ASC 830 current-rate method.** That handles balance-sheet translation drift over time when a sub's functional currency = its local currency. The v0.7 demo doesn't need it: the UK sub has only a handful of transactions, all at a single FX date, with no period-end revaluation.
- **Translation method picker per account type.** ASC 830 distinguishes monetary vs non-monetary items + current rate vs historical rate vs weighted-average. v0.7 substrate hasn't classified accounts that way; deferred to a later phase that adds `Account.translationCategory`.
- **FX gain/loss accounts wired into per-transaction posting.** Today the importer treats `fxRate` as a one-shot conversion. If two USD invoices on the same sub use different rates at posting vs collection, the realized FX gain/loss isn't computed. Deferred to a sub-ledger-aware Phase 3.
- **NS `exchangerate` field parsing.** Real NS exports include `exchangerate` on each transaction (the rate NS used at posting time). Phase 1 reads from the seeded `FxRate` table; Phase 1.5 will prefer the NS-supplied rate when present.

## Design

### Phase 1 — Importer reads FxRate (this PR)

#### Function: `getFxRateOrDefault`

New helper in `src/lib/accounting/fx.ts`:

```typescript
export async function getFxRateOrDefault(
  prisma: PrismaClient,
  input: {
    fromCurrencyId: string;
    toCurrencyId: string;
    asOf: Date;
    rateType?: FxRateType; // defaults to SPOT
  }
): Promise<Decimal>;
```

Behavior:

- `fromCurrencyId === toCurrencyId` → returns `1` immediately, no lookup.
- Otherwise, query `FxRate` for the most recent rate on or before `asOf` matching `(from, to, type)`.
- If no rate found, throw `FxRateNotSeededError` with an operator-actionable message: "No SPOT rate seeded for GBP→USD as of 2026-04-15. Add a row to the FxRate table or load the Northwind seed."

#### NS importer changes (`src/lib/mappers/netsuite/import.ts`)

For every `postJournalEntry` call inside the importer, when the transaction's `currency` field differs from the book's `reportingCurrencyId`:

1. Look up `bookReportingCurrency` once at the top of `importFromNs`.
2. For each tx, compute `fxRate = getFxRateOrDefault({from: tx.currency, to: bookReportingCurrency, asOf: trandate})`.
3. Pass `fxRate` to `postJournalEntry`.
4. Lines: pass `transactionAmount` (NS-native amount, signed) + `transactionCurrencyId: tx.currency`. The mapper layer (`mapNsInvoice`, etc.) already stores `currencyCode`; just plumb it through.
5. `debit`/`credit` get computed by multiplying NS-native amounts by `fxRate` at the line level (or letting postJournalEntry's `reportingAmount = signed * fxRate` derivation work). Decision: do it at the mapper, so `debit`/`credit` are always in reporting currency by the time they hit postJournalEntry — that matches the comment on the schema field.

#### Northwind seed — FxRate baseline

`src/lib/seed/northwind.ts` gains a small block seeding `FxRate` rows so the demos work without operator setup:

```
GBP → USD @ 2026-01-01: 1.2700
EUR → USD @ 2026-01-01: 1.0500
USD → GBP @ 2026-01-01: 0.7874  (= 1/1.2700)
USD → EUR @ 2026-01-01: 0.9524  (= 1/1.0500)
```

A single asOf date means rate lookups for any 2026 transaction find these rows. Real operators with daily rates would seed many more.

### Phase 2 (future, NOT in this PR) — NS `exchangerate` precedence

NS exports include `exchangerate` on each transaction. When present, prefer that over the seeded FxRate (NS's rate is the authoritative one for transaction-time conversion). Add `parseExchangeRate(tx)` to the mapper layer and pass it through to `getFxRateOrDefault` as an override.

### Phase 3 (future) — Sub-ledger FX gain/loss

When an AR open item opens at one rate and gets paid at another, the difference posts to an `FX_GAIN_LOSS` account at collection time. Requires extending `applyArPayment` to read both rates from the JE lineage and compute the delta. Substrate-wide change.

### Phase 4 (future) — Translation method picker + CTA

When the v0.7 demo extends to a period-end consolidation date, the balance sheet needs translation at the current rate, equity at historical, P&L at weighted-average. Delta goes to a `CUMULATIVE_TRANSLATION_ADJUSTMENT` account in equity. Requires `Account.translationCategory` (MONETARY / NON_MONETARY / EQUITY / OPERATING) + translation logic in the consolidation report.

### Phase 5 (future) — Remove the multi-currency banner

Once Phases 1-4 land + a roundtrip test demonstrates a multi-currency consolidation reconciles to a hand-computed expected value, the disclosure banner (PR #144) gets removed and the report becomes the source of truth.

## What ships in Phase 1 (this PR)

- This design doc
- `src/lib/accounting/fx.ts` — `getFxRateOrDefault` + `FxRateNotSeededError`
- Northwind seed gains GBP/EUR baseline rates
- NS importer plumbs `fxRate` + `transactionAmount` + `transactionCurrencyId` through to `postJournalEntry`
- Unit tests for `getFxRateOrDefault` (same-currency short-circuit, most-recent-on-or-before lookup, throws on missing)
- e2e test: import the multi-sub fixture, verify UK invoice's JE line has `debit ≈ 1270` (1000 GBP × 1.27) and `transactionAmount = 1000` with `transactionCurrencyId = "GBP"`
- The multi-currency disclosure banner (PR #144) stays — its removal lives in Phase 5

## Open questions

1. **Rate direction convention** — `FxRate` stores `(from, to)` as separate columns, so `GBP → USD = 1.27` and `USD → GBP = 0.7874` are separate rows. When the NS importer needs `GBP → USD`, do we look up that row directly, or do we accept either direction and invert if needed? **Recommendation:** look up the requested direction only; if missing, throw. Operators seed rates explicitly. Inverting silently masks data errors.

2. **Date semantics — most-recent-on-or-before vs exact-match** — Real-world FX rates are daily. If a transaction is on 2026-04-15 and the closest seeded rate is 2026-04-01, do we use it? **Recommendation:** yes (most-recent-on-or-before). NS does this. Reflects how rate seeding actually works in production (operators load monthly, weekly, or daily depending on volume).

3. **Currency mismatch between transaction and entity** — If a transaction is in GBP on a USD sub, that's a foreign-currency transaction on a domestic entity (a US sub buying from a UK vendor in GBP). The book reporting currency is still USD. Conversion is GBP → USD via the transaction-date rate. **No issue;** the importer doesn't care whether the GBP came from the sub or from a foreign vendor.

4. **What if NS export has no `currency` field on a transaction?** Older NS exports default to the company's base currency. **Recommendation:** default to the bookReportingCurrency in that case (no conversion, fxRate = 1).

## Test plan

### Unit tests (this PR)

- `getFxRateOrDefault` same-currency returns 1 without DB hit
- `getFxRateOrDefault` returns the most-recent-on-or-before rate
- `getFxRateOrDefault` throws `FxRateNotSeededError` when no rate exists
- `getFxRateOrDefault` honors `rateType` (SPOT default; doesn't surface AVG or HISTORICAL)

### Integration test (this PR)

Existing `tests/netsuite-import-multi-sub-e2e.test.ts` already verifies the UK invoice's `currencyId = "GBP"` on the JE. Extend it (or add a new test file) to assert:

- The JE for Invoice 10003 has `debit ≈ 1270` (1000 GBP × 1.27 USD/GBP)
- The JournalLine has `transactionAmount = 1000` and `transactionCurrencyId = "GBP"`
- The JournalLine has `reportingAmount ≈ 1270` and `reportingCurrencyId = "USD"`

### Demo verification

After Phase 1 + Northwind reseed, re-run `pnpm demo:ns-multi-sub` and verify the consolidated TB:

- Pre-elim totals now reflect the GBP-translated UK contribution (1270 USD instead of 1000 mixed)
- The disclosure banner still shows (Phase 5 removes it)
- Per-entity TB rows show: USA contribution in USD, UK contribution still in GBP (since per-entity reports use functional currency, not reporting currency)

## What this unlocks at v1.0+

After Phase 1: NS imports are no longer silently wrong on cross-currency transactions. Real operators can drop in a multi-currency OneWorld export and the consolidated TB will reconcile to their NS-reported number (within FX rate seeding precision).

After the full arc (Phases 2-5): ledger-core can consolidate a real multi-entity multi-currency multi-book group end-to-end with ASC 830 mechanics. That's the "drop in your books, get GAAP-conforming reports" demo claim made good.
