# Active Claude sessions — coordination scoreboard

**READ THIS BEFORE EDITING ANY FILE.** Multiple Claude sessions can
run concurrently in this workspace (context auto-fork on >50% usage,
or the user may launch parallel sessions intentionally). Without
coordination, parallel sessions clobber each other's writes.

The rule: **read this file first. Claim the files you'll touch.
Release on exit.** Other sessions defer to active claims.

---

## Active claims

<!--
Format for each claim — start a new ### block per session, never edit
someone else's:

### Session <short-id> · started <YYYY-MM-DD HH:MM> · heartbeat <HH:MM>
- **Scope**: one-line description of what this session is doing
- **Files / globs**: paths this session may write to
- **Branch**: git branch this session is on
- **Working dir**: absolute path (different from default if using a worktree)

Update your own heartbeat every ~20 turns. If your heartbeat is older
than 60 minutes, other sessions may consider your claim stale.
-->

_No active claims._

---

## Recent completions

### Session commodity-price-entry · 2026-07-24
- **Scope**: Added the two surfaces that made the commodity/lots arc reachable — `createCommodityAction` + `recordCommodityPriceAction` and the `/commodities` page. ⚠️ Found that NOTHING could create a Commodity (tests only), so ④'s trade form always failed "unknown commodity" — my 2026-07-18 "complete vertical slice" claim was wrong.
- **Files**: `src/app/actions/manage-commodities.ts` (new), `src/app/commodities/page.tsx` (new), `src/app/commodities/commodity-forms.tsx` (new), `src/components/nav/catalog.ts`, `tests/manage-commodities-actions.test.ts` (new).
- **Branch**: `feat/commodity-price-entry`. NO schema/migration/fingerprint change.
- **Outcome**: tsc exit 0; DB suite CI-only. ⚠️ VISUAL unverified from this clone.


### Session assertion-close-alerts · 2026-07-24
- **Scope**: Completed Beancount ① — assertions now PUSH. Added the `assertion` close-alert pillar (FAIL→high, UNCHECKED→low, period-scoped, reads the cached lastStatus) + `POST /api/cron/assertion-check` daily 03:00 UTC (after the 02:00 recurring-JE run) refreshing that cache.
- **Files**: `src/lib/close/alerts.ts`, `src/app/close/alerts/page.tsx`, `src/app/api/cron/assertion-check/route.ts` (new), `vercel.json`, `tests/close-alerts-assertion-pillar.test.ts` (new).
- **Branch**: `feat/assertion-close-alerts`. NO schema/migration/fingerprint change.
- **Outcome**: tsc exit 0; DB suite CI-only. ⚠️ Deploy: vercel.json cron entry needs a deploy to register.


### Session balance-assertions-ui · 2026-07-24
- **Scope**: Armed Beancount ① — added the missing create path + `/assertions` page with live PASS/FAIL results. `checkBalanceAssertions` previously had zero callers in `src/`.
- **Files**: `src/app/actions/create-balance-assertion.ts` (new), `src/app/assertions/page.tsx` (new), `src/app/assertions/assertion-form.tsx` (new), `src/components/nav/catalog.ts`, `tests/create-balance-assertion.test.ts` (new).
- **Branch**: `feat/balance-assertions-ui`. **Working dir**: `.worktrees/assert-ui`. NO schema/migration/fingerprint change.
- **Outcome**: tsc exit 0; DB suite CI-only (real books in this clone). ⚠️ VISUAL unverified from this clone — Chris's browser is the check.


### Session encrypt-note-author-email · 2026-07-24
- **Scope**: Landable remainder of PR #131 — `JournalEntryNote.authorEmail` joins the encryption registry. Dropped #131's speculative `authorEmailHash` column (the report justifying it doesn't exist; zero filters on the column), so this is a registry line + tests with NO schema/migration/backfill/fingerprint change.
- **Files**: `src/lib/db/encrypted-fields-extension.ts`, `tests/encrypted-fields-extension.test.ts`.
- **Branch**: `soc2/encrypt-note-author-email` (PR against main). **Working dir**: `.worktrees/enc-phase3`.
- **Outcome**: tsc exit 0; DB suite CI-only (real books in this clone). No deploy action — nothing to push to a DB.


### Session encrypt-user-email · 2026-07-23
- **Scope**: Rebased PR #130 (`User.email` encryption) onto main and made it landable. Added `rewriteWhereForSearchHash` to the encrypted-fields extension so equality `where` filters rewrite onto `emailHash` transparently, and non-equality filters throw `EncryptedFieldQueryError` instead of silently matching nothing. Fixed the `ensureDefaultTenant` duplicate-owner drift bug (via the rewriter, not a hand edit). Added migration 0031 (#130 shipped none). CI caught that #130's three direct `emailLookupKeyForUser` call sites throw when `FIELD_DETERMINISTIC_KEY` is unset — all reverted to plain `where: { email }`.
- **Files**: `prisma/schema.prisma` (+fingerprint), `prisma/migrations/0031_user_email_hash/`, `src/lib/db/encrypted-fields-extension.ts`, `src/lib/soc2/index.ts`, `src/lib/auth/clerk.ts`, `src/lib/seed/{northwind,default-tenant}.ts`, `scripts/encrypt-user-emails.ts` (new), `tests/{encrypted-fields-extension,tenant-isolation,audit-log-csv}.test.ts`.
- **Branch**: `soc2/encrypt-user-email` (PR against main). **Working dir**: `.worktrees/enc-phase2`.
- **Outcome**: tsc exit 0. DB suite is CI-only (real books in this clone). ⚠️ Requires `prisma db push` + `scripts/encrypt-user-emails.ts` backfill on any environment with existing users; until backfilled, NULL-hash rows match no rewritten filter.


### Session holdings-trade-form · 2026-07-18
- **Scope**: Beancount adoption ④ part 4b — the UI I had deferred. `src/app/holdings/trade-form.tsx` (client component) calls the gated `recordCommodityTradeAction`; gain/loss fields render only for SELL; errors show the substrate's own message. Wired into `/holdings`. Nav: Holdings added to **Transactions → `more`** (beside Open AR/AP — third open-item sub-ledger view; kept out of the Pareto `items` set deliberately).
- **Files**: `src/app/holdings/trade-form.tsx` (new), `src/app/holdings/page.tsx`, `src/components/nav/catalog.ts`, `PROJECT_STATUS.md`, `STATUS.md`. NO schema/migration/fingerprint change; no new server logic (action + reader already tested).
- **Branch**: `feat/holdings-trade-form` (PR against main).
- **Outcome**: tsc exit 0; CI's **production build** covers the App Router client/server boundary. ⚠️ VISUAL still unverified from this clone (real books; in-app browser can't drive React forms) — Chris's real browser is the check. No deploy action.


### Session holdings-and-trade-action · 2026-07-18
- **Scope**: Beancount adoption slice ④ / part 4 — completes the lots arc. `recordCommodityTradeAction` (gated Server Action: auth + session-derived scope + `auditPrivilegedAction`, wrapping the part-3 domain commands) + `getHoldings()` (open lots rolled up per commodity: units, cost basis, weighted-avg cost, mark-to-market via commodity-price ③; unpriced → nulls, never an invented mark) + read-only `/holdings` page. NO schema change.
- **Why the action matters**: part 3's commands were intentionally left unreachable/un-audited; this is the control that makes trades user-reachable AND attributable ("AI suggests, humans approve, the system posts").
- **⚠️ Dependency caught by tsc**: part 4 imports part 3's `commodity-trade.ts`, which was in unmerged #302 → merged #302 first, then rebased onto main. (Lesson: a part-N slice importing part-(N−1) must land the dependency or stack.)
- **Files**: `src/lib/accounting/holdings.ts` (new), `src/app/actions/record-commodity-trade.ts` (new), `src/app/holdings/page.tsx` (new), `tests/holdings.test.ts` (new), `tests/record-commodity-trade-action.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/holdings-and-trade-action` (PR against main).
- **Outcome**: tsc exit 0; fingerprint unchanged (no schema). ⛔ NO local DB run (real books) — CI runs the suite. ⚠️ `/holdings` page is typecheck-verified ONLY, **not browser-verified** — interactive trade-entry FORM + sidebar nav link deliberately DEFERRED as browser-verified UI work for Chris's environment. No migration / no deploy action.

### Session commodity-trade · 2026-07-18
- **Scope**: Beancount adoption slice ④ / part 3 — posting integration. `src/lib/accounting/commodity-trade.ts`: `recordCommodityPurchase` (Dr Investment / Cr Cash + augmentLot) + `recordCommoditySale` (getOpenLots → bookReduction → disposal JE → consumeLots). Disposal JE = Dr Cash proceeds / Cr Investment cost-relieved / Cr Gain or Dr Loss (gain driven by BASIS not price).
- **Safety**: `postJournalEntry` NOT modified — only called (its debits==credits invariant rejects any bad composition). Whole flow in one `withTenantContext` tx → atomic (proven by over-sell test: throws InsufficientUnitsError, nothing posted, no lot touched). **Inert** — domain commands, NO user-facing caller yet (gated Server Action + audit + human gate = part 4). NO schema change.
- **Files**: `src/lib/accounting/commodity-trade.ts` (new), `tests/commodity-trade.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/commodity-trade` (PR against main).
- **Outcome**: tsc exit 0; fingerprint unchanged (no schema). ⛔ NO local DB run (real books) — CI runs the suite. No migration / no deploy action. **Remaining ④: part 4 = holdings UI + gated Server Action.**

### Session lot-persistence · 2026-07-18
- **Scope**: Beancount adoption slice ④ / part 2. New `Lot` model + `LotStatus` enum (migration 0030, additive) — cost-basis parcel of a commodity in an account, per book; modeled on `ArOpenItem` (book-aware, `openedByEntryId` nullable). `src/lib/accounting/lots.ts`: `augmentLot` (purchase→OPEN lot), `getOpenLots` (returns the ENGINE's `Lot` type so `bookReduction` consumes directly), `consumeLots` (draw down remainingUnits + CLOSE depleted; run in the sale's tx). `Decimal(28,10)` units/cost. Branched off main (commodity ③ merged).
- **Tests**: augment/read + **end-to-end composition** (augment 2 → getOpenLots → FIFO bookReduction → consumeLots → re-read: consumed lot CLOSED not deleted, remainder correct, gain 350) + tenant isolation.
- **6 backrefs** added (Tenant/LegalEntity/Book/Account/Commodity/JournalEntry) — schema.prisma edit, will conflict on the Tenant/Account backref anchors + `.sha256` if other schema PRs land first (recompute-from-merged-schema).
- **Files**: `prisma/schema.prisma` (+Lot,+LotStatus,+6 backrefs), `prisma/schema.prisma.sha256`, `prisma/migrations/0030_lot/migration.sql` (new), `src/lib/accounting/lots.ts` (new), `tests/lots.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/lot-persistence` (PR against main).
- **Outcome**: prisma validate + generate clean; tsc exit 0; fingerprint green. ⛔ NO local DB run (real books) — CI runs the suite. **Deploy**: migration 0030 needs `prisma db push` on personal-books + any prod. **Remaining ④: part 3 posting integration, part 4 UI.**

### Session beancount-adoption-study · 2026-07-18
- **Scope**: Docs-only. Added `docs/spec/beancount-adoption-study.md` — a study of Beancount v3 (repo + official language/inventory/query docs) against ledger-core, with every "has/lacks" claim verified in-tree and every candidate checked against the LOCKED canon.
- **Key findings**: ledger-core genuinely LACKS balance assertions (`Reconciliation` is a periodic attested workflow, not a cheap dated machine check), `pad`, a non-currency price DB (`FxRate` is currency-pair-only), account currency constraints / dated open-close (`Account` has only `active` + `bookScope`), lot & cost-basis booking (`CostingMethod` enum has ZERO code references), links, and general document attachment. Ranked adoption: ① balance assertions + pad → ② account currency constraints + open/close dates → ③ commodity+price → ④ lots. Explicit do-NOT-adopt list (plugin stream-rewriting, a query DSL, tolerance in the core balancing invariant, silent pad) with canon reasons.
- **First slice scoped concretely**: `BalanceAssertion` table + checker reusing `getTrialBalance(prisma, scope, asOf)` (already returns per-account normal-side balances scoped to tenant/entity/book, `documentDate <= asOf`), default tolerance from `Currency.decimals`. ⚠️ Flags the as-of convention divergence (Beancount asserts at START of date; recommend end-of-day to match `getTrialBalance`) as a silent-wrong-answer trap.
- **Files**: `docs/spec/beancount-adoption-study.md` (new), `STATUS.md` (this entry).
- **Branch**: `docs/beancount-adoption-study` (PR against main)
- **Outcome**: docs-only; no code, schema, or DB change. No suite run needed. 4 open decisions left to Chris (commodity/price extension, enforcement level, as-of convention, whether lots are on the roadmap).
### Session inventory-booking-engine · 2026-07-18
- **Scope**: Beancount adoption slice ④ / part 1 (Chris picked "④ lots/cost basis"). The PURE algorithmic core: `src/lib/accounting/inventory.ts` — `bookReduction(held, reduceUnits, method, opts)` matches lots (STRICT/FIFO/LIFO), computes cost relieved + realized gain (proceeds − basis). Helpers totalUnits/totalCost/averageCost. NONE/AVERAGE out of scope (AVERAGE unimplemented upstream too).
- **Deliberately pure**: no DB, no schema, no posting integration → exhaustively unit-testable and **run LOCALLY 16/16** (DB-free single-file vitest is safe from this clone; verified no vitest globalSetup first) in addition to CI. All decimal.js.
- **④ arc plan** (each its own PR): part 2 = Lot persistence model (book-aware, stacks on commodity ③) + augment; part 3 = posting integration (realized-gain JE via postJournalEntry); part 4 = UI/holdings. Deferred to stay reviewable.
- **Files**: `src/lib/accounting/inventory.ts` (new), `tests/inventory-booking.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`. NO schema/migration/fingerprint change.
- **Branch**: `feat/inventory-booking-engine` (PR against main — independent).
- **Outcome**: tsc exit 0; 16/16 local + CI. No deploy action.
### Session pad-balance-assertion · 2026-07-18
- **Scope**: Beancount adoption slice ① part 2 (study PR #295; assertions PR #296). `padBalanceAssertionAction` posts the adjusting entry that satisfies an unmet assertion — the opening-balances path. Explicit + human-triggered + audited via `postJournalEntry` (Beancount's `pad` inserts silently; ours never does). Direction DERIVED from delta + `normalBalance`, never supplied. Observed balance recomputed at pad time (never padded from the cached result).
- **Idempotency without a status flag**: the entry carries lineage `(SUBSTRATE, BalanceAssertion.pad, <assertionId>)`, and the pre-existing `gl_entry_header_lineage_uniq` partial unique index makes a second pad fail P2002 → "already been padded". **NO schema change, no migration, fingerprint unchanged.**
- **Shared semantics**: exported `resolveTolerance` / `evaluateAssertion` from `balance-assertions.ts` so pad and the checker use ONE definition of "satisfied", not two.
- **Files**: `src/app/actions/pad-balance-assertion.ts` (new), `tests/pad-balance-assertion.test.ts` (new), `src/lib/accounting/balance-assertions.ts` (export the shared comparison), `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/pad-balance-assertion` — ⚠️ STACKED on `feat/balance-assertions` (#296); needs the `BalanceAssertion` table. PR base = that branch.
- **Outcome**: tsc exit 0; fingerprint unchanged (correct — no schema edit). ⛔ NO local DB run (real books) — CI verifies (stacked PRs need the temp-retarget-to-main trick).

### Session balance-assertions · 2026-07-18
- **Scope**: Beancount adoption slice ① (study: `docs/spec/beancount-adoption-study.md`, PR #295). New `BalanceAssertion` model + `AssertionStatus` enum (migration 0027, additive) + `checkBalanceAssertions()` in `src/lib/accounting/balance-assertions.ts`. Enforces correctness ACROSS TIME (drift no single write would reject) vs `postJournalEntry`'s at-write enforcement. Complementary to `Reconciliation` (periodic human attested control), NOT a replacement.
- **Design**: reuses `getTrialBalance` (one TB per distinct asOf, so N assertions on a date = one query) instead of a second balance query path; default tolerance from `Currency.decimals`; `expectedAmount` on the account's NORMAL side; result cache (`lastStatus`/`lastObservedAmount`/`lastCheckedAt`) refreshed only when `persist` is set. Relations to tenant/entity/book/account (PeriodClose shape); `currencyId` plain per ar/ap_open_item precedent.
- **Decisions taken on Chris's "do it"** (both were open questions in the study; both reversible, both documented loudly): **advisory-only** (no posting/close gate) and **END-of-day asOf** (`documentDate <= asOf`, matching getTrialBalance — Beancount asserts at the START of the date).
- **Files**: `prisma/schema.prisma` (+BalanceAssertion, +AssertionStatus, 4 backrefs), `prisma/schema.prisma.sha256`, `prisma/migrations/0027_balance_assertion/migration.sql` (new), `src/lib/accounting/balance-assertions.ts` (new), `tests/balance-assertions.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/balance-assertions` (PR against main)
- **Outcome**: `prisma validate` + generate clean; tsc exit 0; schema-fingerprint green. ⛔ NO local DB run (real books) — tests run in CI's ephemeral Postgres. **Deploy**: migration 0027 needs `prisma db push` on personal-books + any prod.
### Session account-currency-lifecycle · 2026-07-18
- **Scope**: Beancount adoption slice ② (study PR #295). `Account` + `allowedCurrencies String[]`, `openedOn`, `closedOn` (migration 0028, additive) with enforcement in **`postJournalEntry`** — the single write path, so every caller inherits it. Closes two holes: nothing stopped a EUR posting into a USD-only account, and `active: Boolean` can't answer "was this valid on the ENTRY's date" for a backdated post. New errors `AccountCurrencyNotAllowedError` / `AccountNotOpenError` (mirror `AccountBookScopeError`).
- **Semantics**: boundaries **INCLUSIVE** — postable on `[openedOn, closedOn]`; checked against **documentDate** (what resolves the period), not postingDate.
- **⭐ INERT BY DEFAULT** — `allowedCurrencies` defaults `[]` (unconstrained), dates default NULL (unbounded). No existing account changes behaviour; the full suite staying green is the proof. Tests LEAD with that regression guard, then allowed/refused currency + all four date boundaries.
- **Files**: `prisma/schema.prisma`, `prisma/schema.prisma.sha256`, `prisma/migrations/0028_account_currency_lifecycle/migration.sql` (new), `src/lib/accounting/types.ts` (+2 errors), `src/lib/accounting/post-journal.ts` (select + map + 2 checks), `tests/account-currency-lifecycle.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/account-currency-lifecycle` (PR against main — independent of #296/#297).
- **Outcome**: prisma validate + generate clean; tsc exit 0; fingerprint green. ⛔ NO local DB run (real books) — CI runs the suite. **Deploy**: migration 0028 needs `prisma db push` on personal-books + any prod.
### Session commodity-price · 2026-07-18
- **Scope**: Beancount adoption slice ③ (Chris greenlit the Layer-2 extension via AskUserQuestion). New `Commodity` + `CommodityPrice` models (migration 0029, additive) + `getCommodityPrice()` / `recordCommodityPrice()` in `src/lib/accounting/commodity-price.ts`. Fills the gap where a security price was unrepresentable (`FxRate` is currency→currency; `Currency` is ISO-4217-keyed by design). ADDITIVE — Currency/FxRate/posting path untouched.
- **Design**: `Commodity` is tenant master data (symbol/name/assetClass, unique per `(tenant, symbol)`, like Item/Party). `CommodityPrice` mirrors `FxRate` but commodity→currency, tenant-scoped, `currencyId` plain (no Currency backref, per ar_open_item precedent). Resolver is **on-or-before** (same as `resolveFxRate`); recorder is **last-write-wins** upsert (Beancount rule). `null` for "no price" is a normal answer.
- **Files**: `prisma/schema.prisma` (+Commodity, +CommodityPrice, +2 Tenant backrefs), `prisma/schema.prisma.sha256`, `prisma/migrations/0029_commodity_price/migration.sql` (new), `src/lib/accounting/commodity-price.ts` (new), `tests/commodity-price.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/commodity-price` (PR against main — independent of #296/#297/#298).
- **Outcome**: prisma validate + generate clean; tsc exit 0; fingerprint green. ⛔ NO local DB run (real books) — CI runs the suite. **Deploy**: migration 0029 needs `prisma db push` on personal-books + any prod. Consumers (holdings valuation) are follow-ups.
### Session csp-dev-unsafe-eval · 2026-07-22
- **Scope**: extracted the dev-CSP hydration fix from `feat/flowkit-graft` into its own PR — `'unsafe-eval'` moved into the non-production `script-src` directive (eval() is governed by `script-src`, not `script-src-elem`); prod policy byte-identical. `src/middleware.ts` (buildCspHeader) + regression tests in `tests/csp-nonce.test.ts`.
- **Branch**: `fix/csp-dev-script-src-unsafe-eval` (PR against main)
- **Outcome**: csp-nonce suite 11/11 (dev-branch test verified to fail pre-fix); tsc exit 0; live dev run hydrates (`window.next` object, zero console errors); `next build && next start` smoke: prod CSP strict (no unsafe-eval), `/sign-in` hydrates, `/` fail-closes 503 without Clerk keys. DB-free change — no local DB suites run.

### Session entry-lineage-view · 2026-07-17
- **Scope**: Documents & Corrections arc, Half A / A4 (scope doc `docs/spec/documents-and-corrections-arc.md`, PR #288). `getEntryLineage(db, {tenantId, entryId})` (`src/lib/accounting/lineage.ts`) — tenant-scoped resolver returning an entry's reversal + correction lineage in both directions (reverses/reversedBy via reversalOfId, corrects/correctedBy via correctionOfId). JE detail page renders a unified related-entries display from it (corrections alongside reversals; ReverseButton fed from the same source). Read-only, NO schema change.
- **Files**: `src/lib/accounting/lineage.ts` (new), `tests/entry-lineage.test.ts` (new), `src/app/journal-entries/[id]/page.tsx`, `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/entry-lineage-view` — ⚠️ STACKED on `feat/je-reclassify-correction` (#289), because it walks `correctionOfId` which only exists there. PR base = that branch; retarget to main after #289 merges.
- **Outcome**: tsc clean; ⛔ NO local DB run (real books) — resolver tests run in CI's ephemeral Postgres. Page is server-rendered (typechecked; visual browser-deferred). May trivially conflict with #290 on PROJECT_STATUS.md.

### Session je-reclassify-correction · 2026-07-17
- **Scope**: First code slice of the Documents & Corrections arc (Half A, scoped in `docs/spec/documents-and-corrections-arc.md`, PR #288). Adds `JournalEntry.correctionOfId` (nullable self-link mirroring `reversalOfId`; migration 0024, additive/nullable/no-backfill/not-mirror-DDL) + `reclassifyJournalEntryAction` — moves an amount from one GL account to another via a balanced correcting entry through `postJournalEntry`, links `correctionOfId`, leaves the source POSTED (a correction supplements, it does NOT negate). Direction derived from the source's net on the from-account (no direction input; proves the account was in the source; per-correction bound to what the source booked — cumulative over-reclass is a documented v1 limit). Tenant-scoped lookup + privileged-action audit.
- **Files**: `prisma/schema.prisma` (+correctionOfId), `prisma/schema.prisma.sha256` (refreshed), `prisma/migrations/0024_journal_entry_correction_of/migration.sql` (new), `src/app/actions/reclassify-journal-entry.ts` (new), `tests/reclassify-journal-entry.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/je-reclassify-correction` (PR against main)
- **Outcome**: `npx tsc --noEmit` clean; `prisma validate` + client generate clean; schema-fingerprint gate green. ⛔ NO local DB suite run (this clone holds real books) — the invariant/guard/tenant-isolation tests run in CI's ephemeral Postgres. **Deploy**: migration 0024 needs `prisma db push` on personal-books + any prod; does not auto-deploy. UI entry point deferred (unverifiable from this clone).

### Session docs-documents-corrections-spec · 2026-07-17
- **Scope**: Docs-only. Added `docs/spec/documents-and-corrections-arc.md` — a scoping doc for Codex's roadmap items #1 (native transaction documents) + #2 (correction/reversal workflows), verified against the code and the locked `docs/universal-schema.md` before writing.
- **Key finding**: the canon splits the arc across layers — corrections operate on `JournalEntry` (Layer 1, fits ledger-core), but Layer-4 document tables are assigned to **consumer repos** (build order line 168), NOT the substrate. So "build native documents in the engine" collides with a locked decision; documents are blocked on a repo-placement call. Corrections half is the recommended build (first slice: `correctionOfId` self-link + correcting-entry/reclass action).
- **Files**: `docs/spec/documents-and-corrections-arc.md` (new), `STATUS.md` (this entry).
- **Branch**: `docs/documents-corrections-arc-spec` (PR against main)
- **Outcome**: docs-only; no code, schema, or DB change. No suite run needed.
### Session period-reopen-log-append-only · 2026-07-17
- **Scope**: A3 hardening (Documents & Corrections arc). `period_reopen_log` is now append-only at the DB level via Postgres RULEs (`period_reopen_log_no_update`/`_no_delete` → DO INSTEAD NOTHING) — same silent no-op as audit_log. Rules in `migration-mirror.sql` §7 (CI + db:restore-ddl) + migration `0026` (migrate-deploy). Test escape hatch `withPeriodReopenLogMutable` added to `tests/_helpers/audit-log-cleanup.ts` (mirrors withAuditLogMutable, same disposable-DB gate); A3 test beforeEach cleanup uses it. New `tests/period-reopen-log-append-only.test.ts` proves UPDATE/DELETE no-op + INSERT allowed.
- **Files**: `prisma/sql/migration-mirror.sql`, `prisma/migrations/0026_period_reopen_log_append_only/migration.sql` (new), `tests/_helpers/audit-log-cleanup.ts`, `tests/period-close-action.test.ts`, `tests/period-reopen-log-append-only.test.ts` (new), `PROJECT_STATUS.md`, `STATUS.md`. NO schema.prisma change (RULEs aren't Prisma-expressible) → no fingerprint change.
- **Branch**: `feat/period-reopen-log-append-only` — ⚠️ STACKED on `feat/period-reopen-reason` (#290); needs the period_reopen_log table. PR base = that branch.
- **Outcome**: tsc clean (after `prisma generate`). ⛔ NO local DB run (real books) — CI verifies (via temp-retarget-to-main trick, since stacked PRs don't trigger main-only CI). **Deploy**: migration 0026 rules ride with db:restore-ddl/mirror DDL on personal-books + prod.

### Session period-reopen-reason · 2026-07-17
- **Scope**: Documents & Corrections arc, Half A / A3 (scope doc `docs/spec/documents-and-corrections-arc.md`, PR #288). `reopenPeriodAction` now REQUIRES a reason (empty → refused before the delete) + records each reopen in a new append-only-by-convention `period_reopen_log` table (migration 0025; denormalized codes + reason + reopenedBy + reopenedAt, NO FK relations so a row survives period/entity deletion — audit_log.actorEmail rationale). Close-lock delete + log insert in one `$transaction`; reason also in reopen audit metadata. UI collects reason via prompt.
- **Contract change**: `ReopenPeriodInput.reason` is now required. Only caller was `periods/period-actions.tsx` (updated); existing reopen contract tests updated to pass a reason (mechanics assertions unchanged) + new empty-reason-refused + log-row-written tests.
- **Files**: `prisma/schema.prisma` (+PeriodReopenLog), `prisma/schema.prisma.sha256`, `prisma/migrations/0025_period_reopen_log/migration.sql` (new), `src/app/actions/period-close.ts`, `src/app/periods/period-actions.tsx`, `tests/period-close-action.test.ts`, `PROJECT_STATUS.md`, `STATUS.md`.
- **Branch**: `feat/period-reopen-reason` (PR against main)
- **Outcome**: tsc clean; prisma validate + generate clean; schema-fingerprint green. ⛔ NO local DB run (real books here) — tests run in CI's ephemeral Postgres. **Deploy**: migration 0025 needs `prisma db push` on personal-books + any prod. May trivially conflict with reclassify PR #289 on PROJECT_STATUS.md (keep both).

### Session je-reclassify-correction · 2026-07-17
- **Scope**: First code slice of the Documents & Corrections arc (Half A). Adds `JournalEntry.correctionOfId` + `reclassifyJournalEntryAction`. See PR #289.
- **Branch**: `feat/je-reclassify-correction` (PR against main) — OPEN.

### Session month-end-tenant-pin · 2026-07-17 (commit `5c8a704`)
- **Scope**: The follow-up flagged in the codex-findings block below (⚠️ #2). `src/app/reports/month-end/page.tsx` re-resolved the entity with an un-tenant-pinned `legalEntity.findFirst({ where: { code } })` after `resolveCurrentScope()` — entity codes are unique only per `(tenantId, code)` (Phase 4b), so a code collision could resolve a DIFFERENT tenant's entity, and `entity.id` feeds the periodClose lookups, the three report calls, and the recon rollup. Fixed to `where: { tenantId: scope.tenantId, code: scope.entityCode }` (Codex #1 dashboard class, PR #269).
- **Swept siblings**: `src/app/reports/**/page.tsx` — month-end was the ONLY page with the un-pinned findFirst-by-code. The other 10 resolve via `getCurrentScope()` (tenant-verified) and pass `scope.tenantId` downstream; `ar-aging`/`ap-aging`'s secondary `arOpenItem`/`apOpenItem.findMany` already pin `tenantId` at the top level of `where`.
- **Branch**: `claude/festive-ramanujan-730aa2` (PR against main)
- **Outcome**: `npx tsc --noEmit` clean. No local DB suite / `db push` (this clone holds real books — ⛔; CI runs the suite). One-line UI read-path fix; no schema/product-behavior change.

### Session codex-findings · 2026-07-17 (PRs #269 / #270 / #271)
- **Scope**: Remediated all 8 Codex review findings on `main@0cb47d4`, verified against code first (no finding taken on trust), across 3 merged PRs. **#269** (Critical dashboard cross-tenant leak + Low Decimal-sign): `page.tsx` now resolves `getCurrentScope()` and pins every read to `(tenantId, entityId)`; `netBookValue` / `checkSubledgerTies` / `findControlAccount` / `sumControlAccountBalance` gained an optional `tenantId`; month-end passes it too. **#270** (High assistant book-widening + Med activity tenant-pin + Low date round-trip): `get_book_tax_difference` bounds the comparison book to a server-derived allowlist of books the entity uses; `get_account_activity` pins `tenantId` directly; `parseDate` rejects calendar-invalid dates (2026-02-30). **#271** (High bank-feed cross-entity IDOR + High categorize TOCTOU + Med match race): categorize/exclude/match pin `entityId`+book; categorize/exclude use a conditional FOR_REVIEW `updateMany` claim; `postedEntryId` is now `@unique` (migration 0023) with match mapping P2002 → "already matched".
- **Preserved (per AGENTS.md)**: RLS Phase 1 inert, shared `entityId=null` accounts, and the documented legacy `postJournalEntry` fallback — none touched.
- **Tests**: assistant allowlist-refusal + normalized-date; bank-feed sibling-entity refusal, categorize-once-then-refuse-resubmit, and unique-index P2002. All green in CI (ephemeral Postgres). One self-inflicted CI failure fixed en route: the new categorize happy-path learns a `bank_rule`, so `afterAll` needed to delete `bank_rule` before accounts (a leaked ACME account had poisoned the fx-translation-category dev-DB scan).
- **⚠️ Follow-ups**: (1) **migration 0023** (`bank_transaction_postedEntryId` unique) must be applied to prod + the personal-books DB via `prisma db push` — it does NOT auto-deploy; verify no pre-existing duplicate `postedEntryId` first (safe by construction). (2) Adjacent same-class leak NOT in Codex's 8 and left for a follow-up: `src/app/reports/month-end/page.tsx` resolves the entity with an un-tenant-pinned `legalEntity.findFirst({ where: { code } })`.
- **Outcome**: 3 PRs merged; `main` at `68e48c7`. tsc + schema-fingerprint gate clean locally; full suite green in CI. No local DB test run (this clone holds Chris's real books — ⛔).

### Session askq-flake-triage · 2026-07-16 (commit `4f6df08`)
- **Scope**: `tests/assistant-tools.test.ts` — fixture user is now upserted instead of delete-and-recreated.
- **Triage correction**: the reported flake (`expected '0.00' to be '24700.00'`, unscoped `legalEntity.findFirst` picking the wrong `ASKQ_ENT` twin) was ALREADY fixed by #260 (`3c7804c`, merged 19:13) — `post()`/`postFixtures()` pin `scope.tenantId` and the reads resolve on `tenantId` + `entity.code`, so writes and reads agree. The residue attribution in the brief was also wrong: `/Users/hosungson/personal-books/app` is a second clone of THIS repo whose only `.env` points at a different Neon DB (`ep-fancy-dream` vs our `ep-misty-resonance`), and its copy of the suite is byte-identical to ours — the `askq-test` tenant is this suite's own dedicated fixture, by design. The `default`-tenant `ASKQ_ENT` twin was created at 21:02 local, ~2h AFTER the `askq-test` one and AFTER #260 merged: stale residue from a pre-#260 run, not a live writer.
- **Real bug found**: #260 introduced a deterministic `beforeAll` failure. `user.deleteMany` hard-deletes an `app_user`, which makes Postgres run the `audit_log_actorUserId_fkey` referential action; migration 0015's append-only rule rewrites it to NOTHING → `XX000 referential integrity query ... gave unexpected result`. A no-match `deleteMany` skips the FK check, so the FIRST run on a fresh DB passes (CI's service container) and EVERY rerun against the shared dev DB dies (1 passed / 12 skipped). Same class as the `tests/tenant-context.test.ts` flake noted at PROJECT_STATUS.md:189.
- **Why upsert over `withAuditLogMutable`**: the helper DROPs the append-only rules DB-wide; on the shared dev DB that briefly disarms a control other concurrent suites assert. Upsert is idempotent and matches `tests/tenant-account-resolution.test.ts`, which reuses a fixture user rather than churning `app_user` rows.
- **Considered and declined**: per-run unique tenant + entity code. With `tenantId` pinned on both sides it buys no correctness, and `Tenant` has no `createdAt`, so a `askq-test-*` prefix scrub couldn't be age-gated — it would delete a CONCURRENT checkout's tenant, making cross-session runs more hostile, not less.
- **Note**: running the suite executes its own global `ASKQ_ENT` scrub, which removed both twins (incl. the `default`-tenant residue) during verification. That is the committed suite's designed behavior, not a manual delete; it recreates its fixtures each run.
- **Branch**: `claude/amazing-nightingale-a4e30f` (PR against main)
- **Outcome**: 13/13 on 3 consecutive runs incl. reruns against an already-dirtied DB (the failing condition); full `npm test` green — 130 files / 1076 tests / 0 failures; tsc clean. Test-hygiene only; no product change.

### Session subledger-fixture-isolation · 2026-07-16 (commit `5a1c8d3`)
- **Scope**: Replaced `tests/sub-ledgers.test.ts`'s TABLE-WIDE `deleteMany()` cleanup (journalLine / journalEntry / all AR/AP/FA/lease/rev-contract tables, no `where`) with a per-run tenant (`subledger-<suffix>`) + entity (`SUBLEDGER_<suffix>`), entity-scoped chart/calendar/parties, tenant-scoped deletes, `tenantId` pins on the posting/report/sub-ledger-balance calls, and a self-healing prefix scrub in `beforeAll`. This is the same global-wipe hygiene issue the `ask-widen` session hit below (`reconciliation_match` FK) and filed a chip for.
- **Branch**: `fix/sub-ledgers-tenant-scoped-fixtures` (pushed; PR #264 open against main)
- **Outcome**: 9/9 over 4 consecutive runs incl. one against injected killed-run residue (scrub collected it all); zero `subledger-` rows left behind; tsc clean; full `npm test` green with the change. Test-hygiene only — no product/schema change. **Found en route**: `tests/assistant-tools.test.ts` (pre-#260) could write and read different `ASKQ_ENT` entities — its `post()` helper calls `postJournalEntry` with no `tenantId` (unscoped `findFirst`) while its reads pin a tenant; with two `ASKQ_ENT` rows on the shared DB (tenants `default` + `askq-test`) that silently yields `0.00`/`undefined`. #260's dedicated-tenant refactor covers the suite; the unscoped-`findFirst` hazard in `postJournalEntry` itself remains for any caller that omits `tenantId`.
### Session po-collision-fix · 2026-07-16 (commit `b72ebde`, merged via #262)
- **Scope**: PR #262 shipped `prisma/migrations/0017_po_allocation_columns` while main already had `0017_ns_iselimination_entity_column` — two directories on the same ordinal. Main was at 0021, so 0017 was never free. Renamed to `0022_po_allocation_columns` (ordinal only; SQL body untouched, still `IF NOT EXISTS`-guarded).
- **Branch**: `schema/upstream-po-allocation-columns` (merged as `837f170`)
- **Outcome**: main has no duplicate ordinals; #262 went `CONFLICTING` → `MERGEABLE` and merged with all 5 checks green (test 2m16s). Note: a concurrent session rebased this branch mid-flight; the rename was re-applied on top of their rebase rather than force-pushed over it — both approaches produced an identical `schema.prisma` (`c34071fd…`).

### Session po-upstream · 2026-07-16
- **Scope**: upstream performance_obligation ASC 606 allocation columns (allocatedAmount, allocationMethod, fairValueMethod, quantity + 2 enums) from revenue-rec PR #17 into ledger-core's schema + migration 0022
- **Branch**: schema/upstream-po-allocation-columns (worktree .claude/worktrees/po-upstream)
- **Outcome**: schema-only; DB already has the columns; verified via prisma migrate diff (PO statements gone)

### Session ask-widen · 2026-07-16
- **Scope**: /ask tool widening (cash flow, AR/AP aging, book-tax difference — 4 new read-only tools) + tenant pin on arAging/apAging/openArBalance/openApBalance (pre-tenancy signatures, deficiency-#16 class) threaded through aging pages/CSV routes + PROJECT_STATUS v1.26 catch-up entry.
- **Branch**: `wt-ask-widen` (PR against main)
- **Outcome**: tsc + build clean; 46/46 (assistant 13 + sub-ledgers 9 + invariants 24) on a quiet shared DB. Note: a second local run collided with the concurrent recon-session's test data (FK from reconciliation_match on sub-ledgers' GLOBAL deleteMany cleanup — pre-existing hygiene issue, chip filed); CI verifies in an isolated service container.

### Session crh-fixture-collision · 2026-07-16 (commit `cfaeb0f`)
- **Scope**: Fixed the intermittent P2002 on `(calendarId, ordinal)` in `tests/close-retrospective-history.test.ts` — dedicated per-run fiscal calendar + deterministic ordinals 1..3 + self-healing `crh`-prefix scrub in `beforeAll`, mirroring the sibling `tests/close-retrospective.test.ts`. Root cause was NOT concurrent workers (vitest pins `singleFork: true`): the three random ordinal draws came from overlapping ranges, self-colliding ~3.26% per run (~1 in 31), compounded by residue stranded on the shared Northwind calendar by killed runs.
- **Branch**: `fix/close-retrospective-history-fixture-collision` (pushed; PR #259 open against main)
- **Outcome**: 6/6 green over 6 consecutive runs incl. one against injected residue (scrub collected it all); 31/31 across the five calendar-interacting suites; suite passes in full `npm test`. Test-hygiene only — no product/schema change.
### Session 2026-07-15-sbom-npm-fix · 2026-07-15 (PR #242)
- **Scope**: Fixed the always-red SBOM workflow (`.github/workflows/sbom.yml`) — it set up pnpm (`pnpm/action-setup`, `cache: pnpm`, `pnpm install --frozen-lockfile`) but the repo is npm-only, so all 25 runs since 2026-06-12 failed in ~15s ("lock file is not found ... pnpm-lock.yaml"). Switched to `cache: npm` + `npm ci`, mirroring ci.yml. SBOM gen step (`@cyclonedx/cyclonedx-npm`) was already npm-correct.
- **Branch**: `claude/bold-curie-961bd4` (pushed; PR #242 open against main)
- **Outcome**: Verified green via `workflow_dispatch` on the branch (run 29466230891, success) — real 104 KB SBOM artifact uploaded, 90-day retention. Non-blocking Node 20→24 deprecation annotation noted (repo-wide, out of scope).

### Session 2026-06-11-report-tenant-scope · 2026-06-11
- **Scope**: Deficiency #16 — tenant-scoped the remaining unscoped account scans in report modules (IS, BS via `entityTenantId`; cash-flow, BTD, M-3 via resolve-entity-first) + 5 poisoned-shared-account regression tests (`tests/report-tenant-scoping.test.ts`, verified to fail pre-fix) + deficiency #16 → Closed. BTD finding: its subtype scan read the ENTIRE account table across all tenants.
- **Branch**: `fix/report-tenant-scoped-account-scans` (pushed; PR open against main)
- **Outcome**: tsc clean; 10/11 affected suites green (111 tests) — `netsuite-mapping.test.ts` FK failures verified pre-existing on main (state-dependent, unrelated; `ar_open_item_partyId_fkey`).

### Session 2026-06-11-consolidation-tenant-scope · 2026-06-11
- **Scope**: Tenant-scoped three unscoped lookups in the consolidation report path (account-metadata subtype/isContra bleed into IC elimination, client-controlled `?root=` cross-tenant read, `getTrialBalance` shared-account scan) + adversarial regression tests + deficiency log #15 (Closed) / #16 (Open: same pattern in IS/BS/cash-flow/M-3)
- **Branch**: `fix/consolidation-tenant-scoped-lookups` (pushed; PR open against main)
- **Outcome**: consolidation + tenant-isolation suites green (17/17), tsc clean; regression tests verified to fail pre-fix. Follow-up for the remaining report scans tracked as deficiency #16.

<!--
When a session finishes work, move its block here with a final timestamp.
Keep the last ~10 entries; trim older ones to keep this file under 200 lines.

Example:

### Session <short-id> · YYYY-MM-DD (commit `<sha7>`)
- **Scope**: what shipped
- **Branch**: branch name (and whether merged/pushed)
- **Outcome**: one-line result
-->

### Session 2026-06-08-evening · 2026-06-09 (PRs #180-#200)
- **Scope**: v0.9 NS SuiteAnalytics Arc 6 burndown (5 PRs) + Arc 7 adversarial pass (CWE-1236 CSV injection) + Arc 8 v1.2+ polish closure (Tab shortcut, sortable aging, HISTORICAL ASC 830 pin, orphan-tenant cleanup) + RLS arc Decision C ack on PR #89 + 3 CI infrastructure fixes (npm-audit threshold + test workflow pnpm→npm + gitleaks binary install) + this orchestrator install
- **Branch**: 21 individual PR branches off main; `install-orchestrator-protocol` is the last
- **Outcome**: 21 PRs shipped on ledger-core (#180-#200) plus 4 companion-repo CLAUDE.md mirrors (recon #28-#29, revenue-rec #32-#33, fa-amort #25-#26, integrations #22-#23). v0.9 NS arc fully closed (Phases 1-5 + SuiteAnalytics + Burndown + 34th adversarial pass). v1.2+ ergonomics-and-polish list fully cleared. 3 CI blockers fixed (RLS arc unblocks once #197-#199 merge). Tomorrow's session inherits the protocol and the 27-PR RLS arc merge queue.

---

## How to use this file

**At session start (every session, every time):**
1. Read this file
2. Look at active claims
3. If your task overlaps with an active claim, either:
   - Pick a different task
   - Wait for the other session to finish
   - Surface the conflict to the user before proceeding

**Before your first file edit:**
4. Append a `### Session <id>` block under "Active claims" with your
   scope + the files/globs you'll touch + your branch + working dir
5. Commit STATUS.md immediately (small atomic commit) so other
   sessions see your claim — uncommitted claims race with concurrent
   reads

**Every ~20 turns:**
6. Update your heartbeat timestamp in STATUS.md (also small atomic
   commit)

**At session end:**
7. Move your block to "Recent completions" with a final outcome line
8. Commit one last time

**If you see a stale claim** (heartbeat >60 min old):
- The owning session may have died; gently take over but log it
- Add a `~~strikethrough~~ stale per <YYYY-MM-DD HH:MM>` note in
  their block

**Forbidden:**
- Editing another session's claim block (only the owner edits it)
- Skipping the read step
- Holding a claim on the entire repo (`**`) — break work into scoped
  chunks

---

## Why this works

The protocol is **soft + advisory**, not a hard lock. It works because:

1. **Visibility** — every session sees what every other session is
   doing
2. **Atomic small commits** — claims race-loose-but-don't-collide
   because git serializes commits. If two sessions try to claim at
   once, one's `git pull` shows the other's claim before the second
   writes
3. **Human arbitration** — when sessions DO collide, the user (one
   person driving N sessions) sees the conflict in the commit log
   and can manually coordinate
4. **Cheap** — no daemons, no Redis, no extra processes. Just a file
   + discipline encoded in CLAUDE.md

Hard locks (e.g. lockfile + fcntl) would be more robust but require
infrastructure. For ~5 self-reporting Claude sessions with one human
overseer, soft coordination is enough.
