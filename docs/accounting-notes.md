# Accounting Notes

A plain-English explainer of the accounting underlying this project. Written for developers who can read code but haven't taken an accounting class.

If you've ever wondered why a "general ledger" needs to be more than a list of transactions, this document is for you.

---

## The fundamental rule: every transaction has two sides

Modern accounting is **double-entry bookkeeping** — a 500-year-old invention (Luca Pacioli, 1494) that says every economic event affects at least two accounts. When you buy a $3,000 laptop with cash:

- Your Cash account decreases by $3,000
- Your Equipment account increases by $3,000

You don't lose value — you exchanged one form of value (cash) for another (equipment). The bookkeeping has to reflect both sides.

In code, every transaction in this system is recorded as a **journal entry** with two or more **lines**. Each line hits one account with either a **debit** or a **credit**. The headline rule:

> **Sum of debits must equal sum of credits, on every entry.**

If you can't write a transaction with debits equal to credits, you've described the transaction wrong. This is enforced in three places in the codebase:

1. `postJournalEntry` rejects unbalanced entries (`UnbalancedEntryError`)
2. Tests in `tests/invariants.test.ts` assert this on dozens of edge cases
3. (In production we'd also add a DB trigger; out of scope for this prototype)

---

## Debits and credits aren't "good" and "bad"

A frustration for new accountants is that "debit" and "credit" don't mean what they sound like. A debit isn't necessarily money going out. A credit isn't necessarily money coming in.

Debits and credits are just labels for **which side of an account a number lives on**. Whether that means "increase" or "decrease" depends on the account type.

| Account type | Normal side | Debit means | Credit means |
|---|---|---|---|
| Asset | Debit | Increase | Decrease |
| Liability | Credit | Decrease | Increase |
| Equity | Credit | Decrease | Increase |
| Revenue | Credit | Decrease | Increase |
| Expense | Debit | Increase | Decrease |

This is why our `Account` model has a `normalBalance` field. The rule that "every account has a side" is encoded directly in the schema.

### Why the asymmetry?

There's a deeper reason. The accounting equation:

```
Assets = Liabilities + Equity
```

…has to hold at all times. If Assets are on the left, debits increase them. For the equation to stay balanced, Liabilities and Equity (on the right) have to be increased by the opposite — credits.

This is also why the trial balance balances. Sum of all debit balances = sum of all credit balances, because every transaction added equal amounts to each side.

---

## Contra accounts: when an account "lives on the wrong side"

Sometimes you want to track a *reduction* to an account without losing the original number. The classic example is **Accumulated Depreciation**: it reduces the value of Equipment, but you don't want to just subtract from Equipment because then you'd lose the original cost.

So you create an **Accumulated Depreciation** account that is an Asset (technically) but has a *credit* normal balance — opposite to what an Asset usually has. When you depreciate, you credit Accumulated Depreciation. When you report the Balance Sheet, Equipment minus Accumulated Depreciation equals the net book value.

In our schema this is the `isContra` boolean on `Account`. The `signFor()` function flips the sign when contra is true, so the reports come out right.

---

## The three statements, and why they're connected

There are three financial statements every business produces:

### 1. Income Statement (P&L)

A *period* report. Answers: "How much money did the business make in March?"

- Revenue minus Expenses = Net Income

Revenue and Expenses are **temporary** accounts. They get "closed" at the end of each year — their balances roll into Retained Earnings on the Balance Sheet, and they start the next year at zero.

In this codebase, we don't physically "close" the books at year-end. Instead, `getBalanceSheet` computes Retained Earnings on the fly from all P&L activity ever. This is simpler and mathematically equivalent for a portfolio MVP.

### 2. Balance Sheet

A *point-in-time* report. Answers: "What does the business own and owe right now?"

- Assets = Liabilities + Equity (must hold, always)
- Equity includes Retained Earnings, which equals cumulative Net Income

### 3. Cash Flow Statement

Out of scope for this MVP. The hard one. A real ledger needs a cash flow statement to be GAAP-compliant; we'd add it as a project extension.

### How they're connected

If you make $10,000 of revenue (P&L), three things happen:
- Revenue increases by $10,000 (P&L)
- An asset increases by $10,000 — Cash or AR (Balance Sheet)
- Retained Earnings increases by $10,000 (Balance Sheet, via the P&L roll-up)

This is why the cross-statement test in `tests/invariants.test.ts` matters: it asserts that **Retained Earnings on the BS equals cumulative Net Income from the IS**. They have to be equal — they're computed from the same source data.

---

## Schema decisions

A few design choices worth calling out:

### Why `Decimal(18, 4)` for money, not integer cents?

The "integer cents" trick (storing $1.23 as `123` in an int column) works fine until you need:
- Sub-cent precision (foreign exchange rates, per-unit pricing on usage-billed SaaS, allocations)
- Compatibility with accounting data exports that arrive in decimal form

`Decimal(18, 4)` gives us 14 dollar-digits and 4 fractional digits. The application layer uses `decimal.js` so we never lose precision in math.

### Why a check constraint on `JournalLine` for the XOR rule?

Even though `postJournalEntry` enforces it in app code, the DB constraint is a backstop. If a future engineer (or an over-eager Claude Code session) writes directly to the table — bypassing the function — the DB will still reject `(debit > 0 AND credit > 0)` rows.

This is the "make invalid states unrepresentable" principle applied to schemas, not just types.

### Why posted entries are immutable

Once an entry is posted, it can't be edited or deleted — only **reversed** with another entry. This is the GAAP-style audit trail rule: a financial statement should always be reproducible from the historical entries.

The `reversesId` field links a reversal back to the entry it cancels. Corrections happen by posting a reversal plus a corrected entry, not by editing the original.

---

## Multi-book accounting: one set of facts, several "books"

The single biggest concept v0.3 adds is **multi-book**. A real-world company runs not one ledger but several, each representing a different *accounting basis*:

- **US GAAP** — what shareholders, banks, and audited financial statements use.
- **US Federal Tax** — what the IRS uses, governed by the Internal Revenue Code. Often diverges from GAAP on timing.
- **IFRS** — what international investors and some non-US subsidiaries use.
- **Management** — internal book sometimes adjusted for executive reporting (excluding stock-based comp, normalizing for one-time items, etc.).

The same economic event posts *differently* to each book. Example: $24,000 of laptops bought in January 2026.

| Book | Useful life | Monthly depreciation | YTD by 6/30/2026 |
|---|---|---|---|
| US GAAP | 36 months | $666.67 | $4,000.02 |
| IFRS | 36 months | $666.67 | $4,000.02 |
| US Tax | 60 months | $400.00 | $2,400.00 |

The asset is the same. The cost is the same. But the *policy* — how fast to depreciate — is different per book. That's the **book-tax difference**: tax shows $1,600 less expense than GAAP, which means tax shows $1,600 *more* income, which (in this case) is a *temporary* difference because tax will eventually catch up over the asset's life.

### Why "Pattern 2" matters

You could keep one ledger and store the "tax adjustments" separately, applying them at query time. That's Pattern 1. It looks attractive — less data, less duplication.

It breaks. The moment a tax adjustment in March affects a posting in October, and someone reverses the March entry, the October state silently becomes wrong. The schema chooses Pattern 2: **post in full to every book** so each book's trial balance is independently correct at any point in time, no recomputation required. The cost (3x the journal entries) is small; the correctness gain is large.

### The book-tax-difference report

`getBookTaxDifference` does the obvious thing: it pulls a trial balance for each book, diffs them, and classifies the deltas as **permanent** or **temporary**. Permanent differences (e.g. tax-exempt municipal bond interest) never reverse. Temporary differences (e.g. depreciation timing) reverse over time — and they're what feeds ASC 740's deferred tax calculation.

v0.3 classifies via a heuristic on account code + subtype. A production version would use a `tax_sensitivity` attribute on each account, populated by the tax analyst.

---

## Sub-ledgers: the detail behind the control account

The GL has **control accounts** — Accounts Receivable, Accounts Payable, Inventory. Each control account has a balance, but the balance is the sum of many smaller items. Those items live in a **sub-ledger**:

- **AR sub-ledger**: one row per open customer invoice. Sum of open balances should equal the AR control account.
- **AP sub-ledger**: one row per open vendor bill.
- **Fixed asset sub-ledger**: one row per asset, with its own depreciation schedule per book.
- **Inventory sub-ledger**: lot-level cost layers.

The spec rule is sharp: "A bill creates an AP open item; it is not itself AP." That is, posting a journal entry that credits the AP control account *also* opens an AP open item — the open item is the detail-level lifecycle (created → partially paid → fully paid → written off → maybe reopened). The JE just moves the balance.

**The headline sub-ledger invariant:**

> Sum of `currentBalance` for items in status `(OPEN, PARTIAL, REOPENED)` per `(entity, book)` = control account balance from the trial balance.

If those numbers don't match, your sub-ledger has lost touch with the GL. The tests in `tests/sub-ledgers.test.ts` enforce this on every operation.

### Why per-book sub-ledgers?

`ArOpenItem` has `bookId` because in cash-basis tax shops, the tax book may have zero AR (revenue recognized when cash arrives) while the GAAP book has $30k of open invoices. Different lifecycles per book → per-book records. Yes, this means one invoice spawns three `ArOpenItem` rows in our Northwind seed. The redundancy is the price of correctness.

---

## Further reading

If this document made you want to understand accounting more deeply, the best resources I've found:

- *Accounting Made Simple* by Mike Piper — 100 pages, the best intro book
- The FASB Accounting Standards Codification (ASC) — the official rules (free at fasb.org)
- *Financial Shenanigans* by Howard Schilit — how the rules get abused; great for intuition

For the developer-leaning, *The DataLog Book of Accounting* (forthcoming, fictional in my head but I keep wishing it existed) would explain debits/credits in terms of immutable event streams and projections. The connection is real and worth making.
