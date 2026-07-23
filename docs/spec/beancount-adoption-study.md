# Study — What ledger-core can adopt from Beancount

**Status:** Study / scoping. No code implied by this document.
**Date:** 2026-07-18
**Method:** Read Beancount v3 (repo + official language/inventory/query references — links at
the end), then audited ledger-core's schema and `src/lib` for each candidate feature. Every
"ledger-core has / lacks" claim below was verified in-tree, not assumed. Each candidate is
checked against the LOCKED canon (`docs/universal-schema.md`) before being recommended.

---

## TL;DR

Beancount is architecturally the opposite of ledger-core — Python, a plain-text file parsed on
read, one ledger, no database. Nothing about its *implementation* transfers. But its **semantic
model is unusually well specified**, and four ideas transfer cleanly.

Ranked: **① balance assertions + `pad` → ② account currency constraints + dated open/close →
③ commodity + price database → ④ lot / cost-basis booking.**

The standout is **①**: it is a real gap, it is canon-clean, it is cheap, and it extends
ledger-core's own "make invalid states unrepresentable" thesis through *time*.

---

## Why study a plain-text tool at all

Beancount has had ~15 years of adversarial use by people whose own money is on the line, and it
had to make every accounting rule *explicit in a grammar* — there is no UI to paper over an
ambiguity. That forced unusually precise answers to questions ledger-core also has to answer:
when is a balance "true", what is a lot, how do you match a reduction against holdings, what
does a tolerance mean. The value here is the **specification**, not the code.

---

## Audit — ledger-core today (verified in-tree)

| Beancount concept | ledger-core state |
|---|---|
| `balance` assertion | **Absent.** Nearest is `Reconciliation` (`glBalance` vs nullable `supportingBalance` + `ReconStatus` sign-off) — a *periodic, human, attested workflow*, not a cheap dated machine check |
| `pad` | **Absent** |
| `price` DB for any commodity | **Partial.** `FxRate` is strictly currency→currency (both sides FK `Currency`); cannot express "AAPL = 231.40 USD" |
| `commodity` as a first-class type | **Absent** (`Currency` is ISO-4217-keyed by design) |
| `open`/`close` dates; per-account currency constraint; per-account booking method | **Absent.** `Account` has only `active: Boolean` + `bookScope String[]` |
| Lots / cost basis / booking methods | **Seam only.** `CostingMethod` enum exists on `Item` with **zero code references** |
| `note` | Partial — `JournalEntryNote` is JE-scoped, not (account, date)-scoped |
| `document` | Partial — only `ReconciliationAttachment` |
| tags `#` | Covered in spirit — dimension engine + `extensions Json` |
| links `^` | **No analog.** (`reversalOfId` / `correctionOfId` are single-purpose FKs, not general chains) |
| metadata key/values | Covered — `extensions Json` + `CustomFieldDefinition` |
| BQL | Covered differently — typed report builders (`src/lib/accounting/reports.ts`) + `/ask` |

---

## Tier 1 — recommend adopting

### ① Balance assertions + `pad`

**What Beancount does.** `YYYY-MM-DD balance Account Amount` asserts that an account holds a
specific quantity of a specific commodity. It applies *at the beginning of* its date, aggregates
across lots, can assert on a parent account (including children), and supports an explicit
tolerance (`319.020 ~ 0.002 RGAGX`). `pad` inserts an automatic balancing entry against an equity
account so a following assertion becomes true — the standard way to establish opening balances.

**Why this is the best fit.** ledger-core already enforces correctness *at the moment of write*
(CHECK constraints, `postJournalEntry`'s balance/period/account invariants). An assertion enforces
correctness *across time*: it catches silent drift — a double-posted import, a missed reversal, a
mapper regression — on the date it first appears, instead of at period close.

**It does not duplicate `Reconciliation`.** They are complementary and should stay separate:

| | Balance assertion | Reconciliation |
|---|---|---|
| Cost | cheap, machine-run, continuous | heavy, human, periodic |
| Output | pass/fail tripwire | attested control with sign-off + evidence |
| Scope | one (account, currency, date) | period close workflow |

**Canon fit:** clean. A new table plus a read-only checker. It does not touch the write path and
introduces no anti-pattern. See the concrete slice below.

**Immediate payoff here:** `pad` is exactly the mechanism for the **opening balances** still owed
on personal-books, and an assertion after each bank-feed import is a real guard on that feed.

**One deliberate divergence from Beancount:** `pad` inserts silently there. Here it must be an
explicit, human-approved posting through `postJournalEntry` with real provenance — non-negotiable
per CLAUDE.md #2 and #3. A silent auto-posting engine is not acceptable in this substrate.

### ② Account currency constraints + dated open/close

**What Beancount does.** `open` optionally constrains which commodities an account may hold (and
which booking method it uses); `close` is dated.

**The gap.** `Account.active` is a boolean — it cannot answer *"was this account valid on the
entry's date"*, which matters for every backdated entry. And nothing stops a EUR posting landing
in a USD-only account.

**Why it's worth it.** Additive columns (`openedOn`, `closedOn`, `allowedCurrencies String[]`)
enforced in `postJournalEntry` — the single write path. This is the cheapest guard-value on the
list and is squarely the "make invalid states unrepresentable" ethos already in the canon. These
are account *attributes*, not dimensions, so the anti-patterns list is not implicated.

---

## Tier 2 — valuable, needs an architectural decision

### ③ Commodity + price database
Beancount treats currencies and securities **uniformly**: everything is a commodity, and `price`
populates one price database. ledger-core cannot express a security price at all — `FxRate` is
currency-pair-only.

Needed for investments, mark-to-market, and net-worth reporting, and it would let the existing FX
revaluation engine generalise beyond currencies. **Requires an owner decision:** `Currency` is
ISO-4217-keyed on purpose ("these are stable"); putting securities in it pollutes Layer-2 master
data. The clean shape is a separate `Commodity` + `Price` pair. That is a canon *extension*, not a
violation — but it is the owner's locked layer, so it is the owner's call.

### ④ Lots / cost basis / booking methods
The best-specified part of Beancount. A **Position** is (units, cost, acquisition date, optional
label); an **Inventory** merges positions *only when commodity and all cost attributes match
exactly*; **augmentations** create lots unconditionally while **reductions** use the cost spec as a
*filter*; ambiguity is resolved by booking method — STRICT (default, errors), FIFO, LIFO, NONE,
AVERAGE (still unimplemented upstream). Capital gains fall out of balancing on cost basis while the
`@ price` annotation supplies proceeds.

The canon already anticipates this — it lists "inventory layers" alongside leases and revenue
contracts in the book-aware master-data-extension pattern, and `CostingMethod` is already an (unused)
enum. So the seam is declared; the implementation is not. Large arc — serves investments *and* COGS.

### ⑤ Links (`^`)
Beancount links group financially related transactions **across time** (invoice → payment → refund).
ledger-core has no analog. Note the corrections arc just shipped `reversalOfId` / `correctionOfId`
as single-purpose FKs — a general link table should sit **alongside** those for N-way chains, not
replace them.

### ⑥ `document` directive
Dated evidence attached to any account (plus convention-based directory discovery). ledger-core has
only `ReconciliationAttachment`. Independently corroborated as a gap by the external roadmap's
evidence/document-management item. Precondition: attachments carry the known ClamAV provisioning
requirement.

---

## Explicitly do NOT adopt

- **Plugin architecture** (Python functions rewriting the directive stream). Conflicts head-on with
  "every ledger write goes through `postJournalEntry`" and with auditability. ledger-core's
  posting-rules engine already covers the legitimate part of this need.
- **A query DSL (BQL).** Conflicts with the canon's minimal-DSL principle (author complex logic in
  TS). **Do steal the semantics, not the language:** BQL's real insight is *two-level filtering* —
  `FROM` filters transactions, `WHERE` filters postings — plus inventory-aware aggregation and
  statement operators. Worth expressing in the existing typed report/assistant layer. Not worth a parser.
- **Tolerances in the core balancing invariant.** Beancount infers tolerance from number precision.
  `postJournalEntry` must keep demanding exact `Decimal` debits == credits. Tolerance belongs on
  *assertions and reconciliation only*; letting it reach the posting invariant would be a regression.
- **Silent `pad`.** See ①.
- **Colon-path account names as the hierarchy.** That is a workaround for having no database;
  ledger-core has a real account tree plus the dimension engine.

---

## Concrete first slice — balance assertions

Scoped against the real code. Read-only checker; no change to the write path.

### Schema (one additive table)

```
BalanceAssertion
  id, tenantId, entityId, bookId, accountId
  currencyId          -- v1: the book's reporting currency
  asOf                @db.Date
  expectedAmount      Decimal @db.Decimal(20,4)   -- on the account's NORMAL side
  tolerance           Decimal? @db.Decimal(20,4)  -- null => derive from Currency.decimals
  -- result cache (recomputable; the assertion itself is the durable fact)
  lastCheckedAt, lastObservedAmount, lastStatus (PASS | FAIL | UNCHECKED)
  createdBy, createdAt
  @@unique([entityId, bookId, accountId, currencyId, asOf])
```

### Checker

Reuse the existing report path — do **not** write a new balance query:

- `getTrialBalance(prisma, { entityCode, bookCode, tenantId }, asOf)` already returns per-account
  `TrialBalanceRow { accountCode, debit, credit, balance, … }` scoped to `(tenant, entity, book)`
  with lines filtered `documentDate <= asOf`. `balance` is already expressed on the account's
  normal side, which is why `expectedAmount` should be too.
- Compare `|observed − expected| <= tolerance`, all in `decimal.js`.

### Semantics to pin down explicitly (these are the ambiguities Beancount had to answer)

1. **As-of convention.** Beancount asserts at the *beginning* of the date (excludes that day's
   transactions). **Recommendation: end-of-day (`documentDate <= asOf`)** — it matches
   `getTrialBalance`'s existing semantics (so no second query path) and matches how an accountant
   says "balance as of 6/30". Document the divergence loudly; it is a silent-wrong-answer trap.
2. **Sign.** `expectedAmount` on the account's normal side (matches `TrialBalanceRow.balance`).
3. **Currency.** v1 asserts in the book's reporting currency only — `TrialBalanceRow` carries no
   per-commodity breakdown. True per-commodity assertions unlock only after ③.
4. **Default tolerance.** Derive from `Currency.decimals` (one unit of the last decimal place:
   0.01 USD, 1 JPY). Explicit `tolerance` overrides.
5. **Parent accounts.** Beancount rolls children into a parent assertion. v1: assert on the single
   account only; `TrialBalanceRow.parentCode` + `buildHierarchy()` make roll-up a clean follow-up.

### Enforcement points (pick per appetite)

- **Advisory (v1):** a checker run + a `/close` or report surface listing FAILs. Zero blast radius.
- **Gate (later):** block period close while any in-period assertion FAILs — a natural fit with the
  existing close-task gate.

### `pad` (second step, not v1)

Given an unmet assertion, *propose* the balancing entry (Dr/Cr account ↔ equity) and post it via
`postJournalEntry` only after explicit human approval — mirroring the FX-revaluation gate, with
`source: "AI_APPROVED"` if AI-proposed. Never silent.

### Tests / guardrails

Invariant tests: PASS at exact match; FAIL beyond tolerance; PASS inside tolerance; cross-tenant
assertion resolves to nothing (tenant isolation); currency-decimals default applied. Standard rules
apply — `tenantId` on the new table, session-derived scope, audit row on any assertion mutation,
reversible migration, self-healing `beforeAll`.

### Effort

**S–M.** One table + one checker + tests + a read-only surface. No write-path change, no migration
mirror DDL (nothing here is non-Prisma-expressible).

---

## Open decisions (owner)

1. **③ commodity/price** — extend Layer-2 master data with `Commodity` + `Price`, or keep the
   ledger currency-only for now?
2. **Assertion enforcement** — advisory-only, or eventually a close gate?
3. **As-of convention** — confirm end-of-day (recommended) vs Beancount's beginning-of-day.
4. **④ lots** — is investment/COGS lot tracking on the roadmap, or explicitly deferred?

---

## Sources

- <https://github.com/beancount/beancount>
- <https://beancount.github.io/docs/>
- <https://beancount.github.io/docs/beancount_language_syntax/>
- <https://beancount.github.io/docs/how_inventories_work/>
- <https://beancount.github.io/docs/beancount_query_language/>
