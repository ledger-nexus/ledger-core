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

## Further reading

If this document made you want to understand accounting more deeply, the best resources I've found:

- *Accounting Made Simple* by Mike Piper — 100 pages, the best intro book
- The FASB Accounting Standards Codification (ASC) — the official rules (free at fasb.org)
- *Financial Shenanigans* by Howard Schilit — how the rules get abused; great for intuition

For the developer-leaning, *The DataLog Book of Accounting* (forthcoming, fictional in my head but I keep wishing it existed) would explain debits/credits in terms of immutable event streams and projections. The connection is real and worth making.
