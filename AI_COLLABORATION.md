# AI Collaboration Log — mini-ledger

This project was scaffolded with significant AI assistance. This document is an honest record of that collaboration — what I specified, what AI implemented, where AI got the accounting wrong, and where domain knowledge had to override.

I'm including this because the difference between "shipped with AI" and "shipped by AI" matters, and pretending otherwise insults the people reading.

---

## Tools used

- **Claude (claude.ai)** — used for planning, schema design discussion, and writing the initial scaffolds for the core accounting files
- **Claude Code** — used for the UI layer (Next.js pages, React components, Tailwind styling) and most of the test scaffolding
- **Cursor** — used for inline edits, especially fixing TypeScript errors that the larger models missed

---

## What I specified vs. what AI implemented

**I specified (no AI generation):**
- The data model decisions: three tables, normal-balance on Account, contra-account flag, source enum on JournalEntry
- The headline invariants: debits = credits, balance sheet balances, retained earnings reconciles
- The boundary rule: all writes flow through `postJournalEntry`; AI may suggest entries but never posts them directly
- The seed scenario: a SaaS company with payroll, deferred revenue, depreciation, AR
- The chart of accounts structure and numbering convention
- The test cases (the *what to assert*; AI wrote the actual test code)
- The decision to use `decimal.js` over native Number or integer cents

**AI implemented (with my review):**
- The Prisma schema from my data model description
- The TypeScript implementation of `postJournalEntry` from my specification
- The report generators (`getTrialBalance`, `getIncomeStatement`, `getBalanceSheet`) — I gave Claude the formulas; it wrote the queries
- Most of the seed data — I described the scenarios; Claude generated the line-by-line entries
- All Next.js pages and React components
- All Tailwind styling
- Migration boilerplate
- Most of the `package.json` and TS config

---

## Where AI got the accounting wrong

This is the section that matters. If I had skipped review, these would have shipped.

### 1. Contra accounts treated as opposite-type

**First pass:** Claude modeled Accumulated Depreciation as a `LIABILITY` because its normal balance is CREDIT, the same as a liability's.

**Why that's wrong:** Accumulated Depreciation is conceptually an Asset (it reduces equipment, which is an asset). On the Balance Sheet, it appears under the Assets section, just as a negative. Modeling it as a Liability would have made it show up in the wrong place and broken the Assets-equals-L+E identity.

**Fix:** Added an explicit `isContra` boolean on Account. Type stays as ASSET; normal balance flips. Wrote the `signFor()` helper to encode the flip.

### 2. Retained earnings on the Balance Sheet was static

**First pass:** The initial implementation of `getBalanceSheet` just summed the Equity-type accounts and returned that as Total Equity.

**Why that's wrong:** Net income for the current period hasn't been "closed" into a stored Retained Earnings account yet, so Equity was under-reported by the amount of YTD net income. The balance sheet didn't balance.

**Fix:** Rewrote `getBalanceSheet` to compute retained earnings on the fly by running `getIncomeStatement` over all-time, then adding it to Equity. Added a cross-statement test that asserts the relationship.

### 3. Off-by-one on a payroll seed entry

**Caught by a test:** I prompted Claude to write a payroll JE for the seed (8 employees × $10k salary, plus taxes and benefits). It produced a $94,400 cash credit but I miscounted the offsets when reading the output. The first run of the seed failed because debits didn't equal credits by 16 cents.

**Why this matters:** The error wasn't Claude's — it was mine for not verifying. But the test infrastructure caught it before I could push. This is why the invariant tests run on the seed.

### 4. Floating-point in tests

**First pass:** Some early test assertions compared values with `===` (JS strict equality) on `Decimal` instances.

**Why that's wrong:** `Decimal` instances are objects. Two `Decimal(100)`s are not `===`. The test passed only because it was comparing the same reference; it would have falsely passed even if the math was wrong.

**Fix:** Replaced all `===` with `.equals()` on Decimal values. Added an ESLint rule (TODO) to catch this.

---

## Prompts that worked well

A few patterns I've found effective for this kind of work:

1. **Specify the invariant first, then ask for the implementation.** "Write `postJournalEntry` such that it throws `UnbalancedEntryError` if debits ≠ credits" got me a better result than "write a function to post a journal entry."
2. **Give Claude the test cases I want passing.** Pasting `tests/invariants.test.ts` and asking "make these pass" worked dramatically better than describing the function in prose.
3. **Make it explain the accounting back to me.** Before letting Claude write `getBalanceSheet`, I asked it to walk through how net income ends up on the balance sheet. The explanation was almost right but missed the "computed-on-the-fly because we don't close periods" subtlety. Catching that in conversation saved me a debugging session.
4. **Ask for the alternative considered.** "What's an alternative way to model contra accounts and why is it worse?" gave me useful context for the DESIGN.md doc and surfaced a tradeoff I hadn't considered.

---

## What I'd still need a senior engineer for

Honesty section.

- **Production-grade auth.** I can scaffold a Clerk or NextAuth integration with help. Designing the actual authorization model (which roles can post to which account ranges, four-eyes approval on entries over $X, etc.) requires more experience than I have.
- **Database migrations under load.** The check constraints are added in a separate migration; in a real schema-evolution scenario with downtime constraints, I'd need help.
- **Observability.** I have no telemetry, no error reporting, no alerts. A production system needs all of these and I haven't built those before.
- **Security review of the AI-touching code paths in the bank-recon project.** Anywhere AI output influences a write is a potential injection surface.

---

Last updated: [DATE]
