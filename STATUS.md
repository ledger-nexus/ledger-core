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

### Session rls-route-suites · 2026-08-08
- **Scope**: the three `rls-*` suites #368 deliberately left alone. Measured what each actually leaves in shared NORTHWIND rather than trusting #368's note about them.
- **⚠️ #368's stated reason for skipping them was wrong in BOTH directions.** `rls-internal-je-route` leaks 1 JE per run and its id was available all along (`withTenantContext` returns whatever its callback returns). `rls-recurring-entries` posts no JEs at all — it leaks a `RecurringEntry` template, and only on the FAILURE path, because cleanup was the last statement of each `it`. `rls-run-recurring` does not leak: its cleanup is already in a `finally` and deletes by `sourceRecordId startsWith <template uuid>`, which cannot match a seed row. It is deliberately unchanged and now carries a comment saying why, so nobody "fixes" it into consistency later.
- **Demonstrated, not argued**: flipping one assertion to a wrong value against the unfixed suite left `RLS-ACT-1786215627756` behind permanently; the identical break post-fix leaves nothing.
- **Verified**: 5 tests green; foreign entries on NORTHWIND 2 → 2, total 184 → 184, 0 `RLS-` templates, across a full run of all three; `tsc --noEmit` exit 0.
- **⚠️ PROJECT_STATUS.md had a hole**: #366, #367 and #368 never got entries. All three added here alongside #369.
- **Left alone on purpose**: the two older `RlsPlumbing` entries at rest predate this session, and `seedNorthwind` deletes every entry on the entity (`src/lib/seed/northwind.ts:708`), so `seeded-company`'s next re-seed clears them. No manual DB surgery on the shared dev database.
- **Branch**: fix/rls-route-suites-stop-leaking. PR #369.
### Session latent-survey-findings · 2026-08-08
- **Scope**: the three "query is wider than the claim" findings left from the earlier survey — `fx-translation-category`, `netsuite-mapping`, `flux-rollup`.
- **⚠️ THE HEADLINE IS NOT A TEST FIX.** Scoping `netsuite-mapping`'s global `dimension.deleteMany()` exposed a **cross-tenant read in `exportToNs`**: that file never filtered on tenant in ANY query, and its two `Dimension` reads were bounded by nothing at all, so another tenant's custom segments — names and values — were exported as this tenant's. It stayed invisible because the unscoped TEST CLEANUP was standing in for the production tenant filter: with only one tenant able to hold a dimension at assert time, the leak could not show. All 11 queries over tenant-scoped models now filter on a resolved `tenantId`, defaulting the way `importFromNs` already does.
- **⚠️ For the next session**: the sibling NS suites (`netsuite-accounting-books-roundtrip`, `netsuite-roundtrip-multi-sub`) delete accounts by `tenantId` + NetSuite internal id with **no entity scope**, and they share fixture ids. Not touched here; same defect family.
- **Demonstrated, each by planting on a throwaway tenant**: one ASSET account turns `fx-translation-category` red (`expected 1 to be +0`); a NetSuite account and a Dimension go 1 → 0 from one `netsuite-mapping` run, and survive after the fix; one FluxStatement takes `getFluxRollup` on flux-rollup's old scope from null to NOT NULL.
- **⚠️ A correction made mid-session**: I concluded a transient 2-test red in `ns-sub-ledger-reverse-export` was caused by my own new test file, on the strength of ONE passing run without it. It did not reproduce across four further runs, and the same batch is green on clean main. Retracted in the PR body rather than quietly dropped.
- **Also found**: `fx-translation-category`'s one *scoped* test was under-scoped in the other direction — 37 shared (`entityId = null`) canonical accounts were skipped. Now covered; all 37 already pass.
- **Branch**: fix/latent-survey-findings. PR #370.

### Session rls-suites-stop-leaking · 2026-08-07
- **Scope**: the polluters behind #367. Six of the nine `rls-*` suites that post JEs into shared NORTHWIND now capture the ids they create and remove exactly those in `afterAll`, via `deleteEntries` from #366.
- **⚠️ The first pass leaked 2 of 15 and the MEASUREMENT caught it, not the code review.** Both were posted as `return postJournalEntry(tx, …)` INSIDE a `withTenantContext` callback, so the entry lands on the OUTER variable — a `const X = await postJournalEntry(` capture misses them entirely. Shipping on "15 sites captured, tsc clean" would have claimed a closed leak that still dripped 2 per run. Each site now carries a comment saying why the obvious pattern misses it.
- **⚠️ Two cleanup approaches REJECTED, both of which look right**: (1) `deleteMany` by `sourceRecordType` — these suites stamp generic domain types (`VendorBill`, `CustomerInvoice`, `Payment`) that the Northwind seed also uses, so it would delete seed rows; (2) stamping a distinctive `sourceSystem` marker — `postJournalEntry` dedupes on `(sourceSystem, sourceRecordType, sourceRecordId)` and several of these use FIXED record ids, so the marker would make the SECOND run silently skip the post instead of creating it. Delete-by-captured-id is the only safe option.
- **Verified by measurement, not inspection**: foreign (non-SEED) entries on NORTHWIND before/after a full run of the six — 2 → 2, unchanged. First pass measured 0 → 2, which is how the miss was found. 13 tests green across the six.
- **Still open**: `rls-internal-je-route`, `rls-recurring-entries`, `rls-run-recurring` post through routes with no returned id and need a different capture. Deliberately untouched rather than half-fixed.
- **Branch**: fix/rls-suites-stop-leaking. PR #368.

### Session seeded-company-pollution-detect · 2026-08-07
- **Scope**: the Gauntlet's finding #2. `seeded-company` asserts exact totals over shared NORTHWIND while **nine `rls-*` suites post journal entries there and none clean up** (7 leaked entries measured at rest).
- **⚠️ The bug is that EVERY threshold in its self-heal is a LOWER bound** (`jeCount > 50 && arCount > 5 && faCount >= 1 && recognized != 0`). They catch a dataset that is too SMALL — a partial or wiped seed — and are structurally blind to one that is too BIG. A complete Northwind PLUS one extra posting still read `looksComplete === true`, skipped the re-seed, and let the amount land in an exact-total assertion. The comment above it reads like it defends against exactly this.
- **Fix**: `seedNorthwind` stamps `source: "SEED"` on all 18 of its entries, so a non-SEED row on NORTHWIND is by definition someone else's. The heal now counts those and re-seeds when any exist. Chosen over an unconditional re-seed because the file's own `hookTimeout` says a full seed is ~2 min against remote Neon — one extra `count` keeps the fast path and fires only when it matters. Fixes the VICTIM, so it does not matter how many polluters appear later.
- **Verified end to end**: exposure — one leaked entry moved the asserted total by exactly $10; detection — `foreignEntries = 1`; recovery — suite re-seeded and passed **27/27** including the exact $40k deferred-revenue and $40k AR assertions.
- **⚠️ I reproduced the bug on myself while testing it**: a probe was SIGTERM'd mid-seed and left NORTHWIND partially seeded but still ABOVE `jeCount > 50`, so the retry skipped re-seeding and measured partial data (55000 instead of 75000). Exactly the "threshold only catches too-small" failure. The suite run restored the DB.
- **Still open**: the nine leaking `rls-*` suites themselves (6 of 9 assign the posted entry to a variable, so `deleteEntries` from #366 makes their cleanup trivial; 3 post via routes and need id capture another way).
- **Branch**: fix/seeded-company-detects-pollution. PR #367.

### Session test-ledger-cleanup · 2026-08-07
- **Scope**: output of a Gauntlet run on shared-DB test contamination. One FK-correct teardown helper (`tests/helpers/ledger-cleanup.ts`) replaces two hand-rolled `clearLedger`s.
- **⚠️ The bug**: `ArOpenItem.openedByEntryId` and `ApOpenItem.openedByEntryId` are **NON-NULL** fks to `JournalEntry` (relations "ArOpenedBy"/"ApOpenedBy"), and `Lot.openedByEntryId` is a third. NONE is covered by scoping on the open item's own `entityId`. "References this entry" and "belongs to this entity" are different sets — an open item owned by entity B can be opened by an entry in entity A (intercompany parcels are exactly that shape). Both property suites cleared open items `where entityId = A` then deleted entries `where entityId = A`, and Postgres refused with `ar_open_item_openedByEntryId_fkey`. Green on a clean DB, red once such a row exists, and it fails in CLEANUP so the error points at the wrong place.
- **⚠️ Rejected approach — deleting by `sourceRecordType` is UNSAFE here**: the RLS suites stamp generic domain types (`VendorBill`, `CustomerInvoice`, `Payment`, `RecurringEntry`) that the Northwind seed also uses, so a marker sweep deletes legitimate seed rows; two of them stamp nothing at all. Delete by captured id only.
- **Verification**: `tests/ledger-cleanup-helper.test.ts` builds the cross-entity parcel deliberately and pins BOTH halves — the naive order genuinely throws and leaves the entry behind, and the helper clears the same state. Harness (alone, twice): property-fuzz-substrate OK, property-based OK, helper OK. tsc 0.
- **⚠️ NOT the cause of the battery's run-2 failures** — those are whole-battery load (each suite passes alone twice, and the two pass together; only the full 192-file run trips them). Remedy there is operational (testTimeout / file parallelism) and is Chris's call.
- **⚠️ Left open, documented**: NINE `rls-*` suites post JEs into NORTHWIND with zero cleanup (7 leaked JEs measured at rest); `seeded-company` asserts exact totals over that entity and is green only because NORTHWIND keeps getting re-seeded. Its self-heal cannot catch drift — every threshold is a LOWER bound.
- **Branch**: fix/test-ledger-cleanup. PR #366.

### Session migration-down-sql · 2026-08-07
- **Scope**: the reversibility gap found while preparing the prod runbook — **0 of 42 migrations had a `down.sql`**, against the global standard's "always include a down() migration". Prisma Migrate has no built-in down, so the convention is a sibling `down.sql` applied with `prisma db execute`.
- **⚠️ Deliberately NOT back-filling the other 40.** Several are irreversible in principle (data backfills that discard the prior value; enum additions Postgres cannot undo), and a `down.sql` that looks authoritative but is wrong is more dangerous than none — it invites someone mid-incident to run destructive SQL confidently. Cutoff is a NUMBER (`REVERSIBLE_FROM = 41`), not a 40-entry grandfather list that would silently stop covering anything.
- 0041's down is **partial by nature and says so**: Postgres cannot remove an enum value, so `WEBHOOK_GENERIC` stays (inert). Its substance is a guard that REFUSES if any WEBHOOK_GENERIC channel exists — dropping `signingSecret` under live rows fails at send time, not rollback time, and a rollback that turns an obvious error now into an obscure one later is worse than one that refuses.
- 0042's down is symmetric in schema, **not in data**: it discards operator matching decisions that are not derivable from the ledger. The file carries the backup statement.
- **Verified END TO END on a disposable Neon branch** forked from dev (`br-falling-queen-ak8e5udm`, deleted after) — Chris authorised the fork/exercise/delete explicitly. Both downs RUN, not just reasoned about: 0042's DROP took the table + 4 indexes + 5 FKs + the RLS policy and left `reconciliation`/`bank_transaction`/`gl_entry_line`/`app_user` intact (no cascade damage); 0041's guard **REFUSED with a real WEBHOOK_GENERIC row present** ("1 WEBHOOK_GENERIC channel(s) still exist") and passed through with none; the enum value survived the rollback exactly as documented. Re-applying both forward migrations restored the original schema (4 indexes, 5 FKs, 1 policy, RLS enabled, column back).
- **Branch**: chore/migration-down-sql. PR #365.

### Session unify-tone-scales · 2026-08-07
- **Scope**: the ~215 raw tone classes #362 deferred, on Chris's "one green". positive/negative/warning are now full scales spread from Tailwind's green/red/amber with DEFAULT = the 700 step, so existing bare `text-positive`/`bg-negative` keep their exact values. **219 occurrences converted across 64 files; zero raw palette classes remain in `src`.**
- **⚠️ The sweep was not a rename — it surfaced 4 real AA failures** that had never been checked because raw classes were outside the guard: `text-emerald-600` (3.61), `text-amber-600` (3.05), **`bg-emerald-600` + `text-white` buttons (3.77, and would have become 3.30 as green-600)**, and `text-negative-600` at **4.43 on `bg-ink-100`** — same shape as the original ink-500 finding: passes on the page, fails on the panel. All four bumped to the 700 step. The last one also collapsed **two different reds for one meaning** (82 sites bare + 35 at -600).
- **⚠️ Landmine avoided and verified**: `accent` is OFFSET from Tailwind's cyan by one step — `accent-500` IS cyan-600, `accent-600` IS cyan-700. Spreading `...colors.cyan` would have silently lightened every focus ring (`focus:border-accent-500`, `ring-accent-500/15`). Missing steps (50/200/900) were added by hand instead; browser-verified `accent-500` still computes `rgb(8,145,178)`.
- 6 stragglers with no token remapped by meaning, not by hue: `bg-rose-500`→`bg-negative-500` (the bad end, beside `bg-positive-500`/`bg-warning-400`), blue links/dot→`accent`, sky info panel→`accent-50/200/900`.
- The #362 guard widened from `src/components/ui/` to all of `src` — a rule enforced only where it was already easy never catches the next drift.
- **Verification**: 9/9 guards, tsc 0, every token probed by computed style in the browser. **Branch**: chore/unify-tone-scales. PR #364.

### Session unify-tone-vocabulary · 2026-08-07
- **Scope**: the two-colour-vocabulary drift flagged in #359, closed at the primitives. ⚠️ **They did not merely duplicate — they disagreed.** `positive` is `#15803d` = **green**-700 (the config comment claiming "emerald-700" was wrong), while `Badge` rendered emerald-700 `#047857`. A positive amount and a positive badge were two different greens meaning the same thing. `negative`/`warning` matched exactly; `accent-600` is cyan-700 exactly.
- Tones are now `{ DEFAULT, 100 }` pairs so a surface step exists as a token, and `Badge` resolves through them. Only `positive` changes visually (4.84 → **4.57** contrast, still AA); the rest are value-identical.
- **⚠️ The restructure silently broke the #359 guard, and only half of it complained.** Flattening `{DEFAULT,100}` produced `positive-DEFAULT`, so nothing matched `text-positive`: the tone check failed loudly, but the **contrast check would have gone vacuous**. `paletteFromConfig` now maps DEFAULT to the bare name, and the derivation test asserts the bare tone names resolve — a guard that stops looking is worse than one that never existed.
- **⚠️ Deliberately NOT swept**: ~215 raw tone classes remain across `src`, spanning steps 50–900 while the tokens define only DEFAULT and 100. Converting them needs new scale steps and would shift greens at 24 sites — a design decision, not a refactor. The new guard is scoped to `src/components/ui/` where the boundary is clean and where the vocabulary everyone copies is defined.
- **Verification**: computed styles in the browser — badges resolve through tokens, and **bare `text-positive`/`text-negative` still emit colour via the DEFAULT key** (the silent-regression risk this whole PR is about). 6/6 guard tests, proved failing on the defect. tsc 0.
- **Branch**: chore/unify-tone-vocabulary, **stacked on #359** (`warning` does not exist on main). PR #362.

### Session design-system-contrast · 2026-08-06
- **Scope**: implementing impeccable.style's lessons as an enforced visual contract (#359). Most of the 58-rule catalogue found nothing — no gradients, glass, `transition-all`, pulse, marquee, hover transforms, gradient text. Four fired. **`ink-400` was 2.41:1 against a 4.5 floor while carrying text in 120 places across 60 files**; `ink-500` (#78716c) failed at 4.40:1 on `bg-ink-100` and is the muted-text step, so it moved to #726b66. 45 sizes below the 11px floor, **six of them validation errors** — now `text-xs`. Two `border-l-4` accent strips dropped.
- **⚠️ A live defect, not a style nit: `warning` was used as `text-warning` / `border-warning` / `bg-warning/5` and was never defined in the config.** Tailwind emits nothing for an unknown token, so the consolidation page's "FX translation not active" callout rendered **untinted with a fallback border**, beneath an identically-built positive callout that was green. It looked deliberate because `<Badge tone="warning">` hardcodes `bg-amber-100` and carried the tone alone. Now defined as amber-700.
- **Verification**: each check proven to fail on its own defect first. Browser-driven at 1280×720 on `/reports/consolidation` — `ink-500` computes `rgb(114,107,102)`, **0** elements with a ≥4px side border, smallest rendered font **11px**, and the warning callout tints (`rgba(180,83,9,0.05)`) where it previously computed `rgba(0,0,0,0)`. tsc 0. **CI green on a fresh Postgres.**
- **⚠️ Guard-writing false positives worth knowing** (all four hit while writing the test, each looks right naively): pair colours within one **string literal**, not one line, or a ternary reports dark-on-dark for a state that cannot render; ignore variant prefixes (`file:bg-ink-900` is the file-picker button); `bg-x/5` is a wash, not solid; and admitting `'` as a string delimiter lets "doesn't" swallow the file.
- **⚠️ Found, NOT caused, NOT fixed**: `tests/close-retrospective.test.ts > Task lead time by category` fails on the **shared dev DB** and passes in CI on a fresh one — residue, the hazard CLAUDE.md documents. This commit touches no `src/lib` at all. Also: **the header overflows horizontally at 1280px** (scrollWidth 1455), from fixed-width `w-64` switcher panels — unaffected by a colour/size change. And `Badge` maps tones to raw Tailwind while the config defines semantic equivalents — two colour vocabularies, unification untouched.
- **Branch**: a11y/muted-text-contrast (worktree ~/Code/ledger-core-je-approvals). PR #359.
### Session retrospective-isolation · 2026-08-06
- **Scope**: `tests/close-retrospective.test.ts` failed on the shared dev DB and passed in CI. **Cause: `getCloseRetrospective` windows periods by ENTITY across ALL calendars** (`calendar: { entityId }`, newest N by startsOn), so this suite's dedicated *calendar* never isolated it — Northwind's own STANDARD_2026 periods sat in the same window. One stray DONE ACCRUAL task ("Accrue bonus", `ACCRUE_BONUS`, period 2026-12) made ACCRUAL `sampleSize` 3 instead of 2. Now mints a dedicated **entity**, which is the query's actual scope axis, plus a self-healing `scrubOrphans()` keyed on the `rt4` code prefix.
- **Verification**: reverting ONLY the entity choice back to NORTHWIND reproduces the failure (2 tests red) — so the entity is what fixes it. Scrub proven by planting an orphan entity+calendar+period+DONE task: 1 → 0 after a run. 7/7 green, and 20/20 across close-alerts / recon-auto-open / close-task-state-history. tsc 0.
- **⚠️ The empty-case test carried a documented compromise** — "we can't fully isolate because the entity has prior periods from the Northwind seed", so it only checked SHAPE. Owning the entity removes that, so it now asserts the trends are actually empty; that assertion is itself the isolation guard (it goes red in the revert probe).
- **⚠️ Checked and deliberately NOT changed**: `close-retrospective-history.test.ts` also borrows NORTHWIND but is **not** vulnerable — every assertion locates its own row by `${SUFFIX}` templateKey rather than reading a category aggregate. `close-retrospective-csv.test.ts` already mints its own entity, which is where this pattern comes from. **The general rule: assert on rows you keyed, not on aggregates — and where the API only exposes aggregates (`avgLeadDays`/`sampleSize` by category), isolate the scope instead.**
- **Branch**: fix/retrospective-suite-isolation. PR pending.
### Session header-overflow · 2026-08-07
- **Scope**: the horizontal overflow I reported while auditing #359, run down properly. ⚠️ **My original report was wrong in a way worth recording**: I measured 175px of overflow at 1280 and called it a header bug. Hiding the dev-auth stub (which is `!clerkOn && HIDE_DEV_CHROME !== "1"`, so it does not ship) put production at **exactly 0** at 1280 — I had measured a panel that never reaches a customer. But dropping to 1024 showed production overflowing by **199px** (scrollWidth 1223). So there was a real bug, at a width I had not tested, and my stated one was dev-only.
- **⚠️ The fix is not where the symptom is.** Adding `min-w-0` to the switcher wrappers changed nothing — measured, still 199px — because the shell is `grid-cols-[260px_1fr]` and `1fr` means `minmax(auto, 1fr)`, whose `auto` floor is the track's MIN-CONTENT width. The track grew for its content instead of constraining it, so no flex rule inside could ever bite. `minmax(0,1fr)` fixes it; the `min-w-0`/`shrink-0` work is what makes the shrink land somewhere sensible once the track stops growing.
- **Verification**: 0 page overflow at 1024 and 1280, with and without dev chrome; 0 elements escaping the viewport on /journal-entries; the consolidated TB now scrolls **inside** its own `overflow-x-auto` wrapper (650 visible / 801 content) rather than dragging the page. `tests/layout-shell.test.ts` pins both halves and each assertion was proved to fail on its own defect. tsc 0.
- **Branch**: fix/header-overflow-narrow. PR #361.

### Session authz-remaining-eleven · 2026-08-06
- **Scope**: the 11 files #352 deferred. My "this needs an authorization decision" framing was wrong — **3 of them already gate on the policy catalog** via `requirePermission(name, role, check)`, and **`requirePermission` throws WITHOUT auditing**, so `approve-journal-entry` / `data-subject-request` / `toggle-je-approval` logged neither unauthenticated refusals nor role denials. Converted to `requirePermitted`: identical predicate and floor, both rows gained, no decision needed. The other 8 have no named permission because several are deliberately member-open → new `requireActor(attemptedAction)` = `requirePermitted` minus the permission check; resolves + audits, changes no gate. 6 of 8 converted.
- **⚠️ Two exclusions, both deliberate**: `bank-feed` resolves via `requireCurrentScope` (different path); **`setup-first-entity` runs BEFORE a tenant exists**, so auditing "no tenant membership" there would log the normal first-run state as an access denial.
- **⚠️ My first survey was a false negative** — I grepped `canManage|canPost|canClose|canView|canRemove` and reported "0 admin checks" for `approve-journal-entry`, which gates on `canApproveJournalEntries`. Caught before publishing; widen the pattern or grep `requirePermission(` directly.
- **Verification**: both new tests fail pre-fix with `expected null not to be null`; 39 + 12 green across authz / je-approvals / period-close / owner-transfer / rls-apply-ar-payment / rls-reassign / rls-mark-notifications-read; tsc 0; build clean.
- **Branch**: fix/authz-remaining-actions (worktree ~/Code/ledger-core-je-approvals).

### Session decimal-guard-that-guards · 2026-08-05
- **Scope**: #347's codemod stopped at the `src/` boundary — **44 test files still imported `decimal.js` directly** (ROUND_HALF_UP / precision 20) while prod runs half-even/28, and `tests/decimal-config.test.ts` only ever pinned that the HELPER is configured, never that nothing bypasses it. All 43 remaining files converted; the guard now walks src/tests/prisma/scripts and FAILS naming any offender, with the configuring module the single exception.
- **Verification**: guard proven by dropping a probe file in `src/lib/` → `expected [ 'src/lib/_bypass_probe.ts' ] to deeply equal []`. **69 tests across the 10 rounding-sensitive suites passed with no expectation moved** — the bypass was latent, not an active wrong expectation. tsc 0; build clean.
- **Branch**: chore/decimal-import-guard (worktree ~/Code/ledger-core-je-approvals).

### Session flux-entity-scope · 2026-08-05
- **Scope**: the defect #354 found and deferred. `getFluxAnalysis` resolved account ids with `tenantId` + `code` and NO entity filter (nor `orderBy`), so a sibling entity's account could win the code and land on a persisted `FluxLine`. Now entity-or-shared + `indexEntityScopedByCode`; `resolveEntityBook` exported from reports.ts rather than re-deriving entity resolution in flux.
- **Verification**: pre-fix, the new sibling fixture makes **6 tests fail including 4 pre-existing ones** — reachable, not theoretical. 26 flux tests + 12 reports/consolidation tests green; tsc 0; build clean. Dev DB scanned for existing damage (`flux_line`→`flux_statement`→`account` on mismatched entityId): 0 of 0 rows.
- **Branch**: fix/flux-entity-scoped-accounts (worktree ~/Code/ledger-core-je-approvals).

### Session recon-match-index · 2026-08-05
- **Scope**: last item from the 2026-08-05 review. `matchTransactions` scanned every unclaimed GL line for every statement line; amount equality is EXACT, so the candidates worth inspecting are exactly those sharing an amount. Now bucketed by `amountKey` = `Decimal.toFixed()`, filled in `gl` order so "earliest of equally-close candidates" is preserved.
- **Verification**: equivalence against a full-scan reference over a 120×120 collision-heavy dataset (>50 pairs, identical); an operation COUNT (not a timing — reproducible anywhere): 150×150 distinct amounts made 0 pairwise `Decimal.equals` calls where the scan made ~22,500. A lossy `toFixed(2)` key fails 2 of the new tests. 23 tests green across recon-transaction-match / recon-auto-open / banking-match; tsc 0; build clean.
- **⚠️ Two of my own claims were wrong and are corrected in the code**: (1) I special-cased negated zero in `amountKey` with a comment asserting `-0` renders `"-0"` — it renders `"0"`; branch removed. (2) I wrote a "differing scale" test for `1.50` vs `1.5` — decimal.js NORMALISES at construction, so those are one value and the test could not fail. A deliberately scale-sensitive key passed all 14 tests, which is how it was caught. The real hazard for a bucket index is the opposite direction — a LOSSY key MERGING unequal amounts — so the dataset now carries 100.0001 / 100.0002, distinct at Decimal(18,4).
- **⚠️ Found, not fixed — #347's codemod stopped at the src boundary**: `src/` is clean but **44 TEST files still `import Decimal from "decimal.js"`**, i.e. the UNCONFIGURED constructor (ROUND_HALF_UP, precision 20) while production uses half-even/28. `tests/decimal-config.test.ts` pins that the helper is configured; it does NOT catch a bypass. Worst-placed: `property-fuzz-substrate`, `fx-revaluation`, `subledger-ties`, `balance-sheet-contra` — all rounding-sensitive. Wants its own PR: codemod + a guard that actually fails on a direct import.
- **Branch**: perf/recon-match-amount-index (worktree ~/Code/ledger-core-je-approvals).

### Session shared-types-and-entity-scope · 2026-08-05
- **Scope**: normalization findings from the 2026-08-05 review. `DbClient` was exported from `@/lib/db` and re-declared identically in 9 modules — now imported, with 7 newly-dead `@prisma/client` type imports removed. The entity-scoped-shadows-shared dedup existed as **6 hand-rolled copies with 6 different comments**; 5 now call `indexEntityScopedByCode` (reports.ts ×3, builder/balances, recon-auto-open). The `.sort(localeCompare)` in reports.ts is KEPT rather than relying on the query's ORDER BY — Postgres collation and localeCompare can disagree on mixed-case or punctuated codes and that is not a difference to discover in a tidying PR.
- **Verification**: 67 tests green across balance-sheet-contra / consolidation ×2 / recon-auto-open / flux / allocation / intercompany / report-builder ×2 / tenant-account-resolution; tsc 0; build clean. Net −26 lines.
- **⚠️ For the next session — a REAL defect found and deliberately NOT fixed here**: `get-flux-analysis.ts` resolves account ids with a query filtered on `tenantId` + `code` and **no entity filter at all**, then hand-dedups. Its rule keeps the FIRST row seen unless the newcomer is entity-scoped — so **an account belonging to a SIBLING entity can win**, which `indexEntityScopedByCode` would drop by design. It could not be swapped in because flux carries `entityCode`, not an entity id, so fixing it needs an entity resolution flux does not currently do. That is a correctness change needing its own test (a sibling-entity account at a shared code), not a normalization. Latent: codes reaching flux come from an already-entity-scoped TB.
- **Also verified, not acted on**: `toDecimal(prismaDecimal)` is EXACTLY equivalent to `new Decimal(x.toString())` at full `Decimal(18,4)` width (checked 12345678901234.5678 and 99999999999999.9999) — while a `Number()`-based refactor loses both. So the 123-site `new Decimal(x.toString())` → `toDecimal(x)` sweep is safe whenever someone wants it; skipped here as pure churn on the eve of a deploy. Still open: `matchTransactions` O(n·m); the 11 actions that never enter the policy layer.
- **Branch**: chore/shared-dbclient-and-entity-scope (worktree ~/Code/ledger-core-je-approvals).

### Session action-error-sanitization · 2026-08-05
- **Scope**: second finding from the 2026-08-05 code review. 26 catch-alls across 24 action files returned `e instanceof Error ? e.message : "..."` — so an unhandled Prisma error put table names, column names and the failing constraint into a toast, and a `PrismaClientValidationError` renders the failing call ARGUMENTS into its own message, which can include amounts. `sanitizeActionError(e, fallback)` replaces driver errors with the caller's own fallback and reports them through `captureError`; **authored refusals pass through verbatim** — that copy is deliberate user-facing wording and a blanket "never show e.message" would have thrown away the good half.
- **Verification**: 4 of 7 new cases fail against a stubbed pre-fix helper, 3 pass on both sides. 66 tests green across authz/period-close/accounts/recurring/je-approvals/action-error; tsc 0; build clean.
- **⚠️ For the next session**: driver detection is belt-and-braces (`instanceof` **plus** name/`Pnnnn`-code) because two copies of the Prisma client can be loaded at once — the same dual-package hazard that made `Decimal.set()` a no-op for 99 files. The `instanceof`-only version silently fails there; a test pins the lookalike case. Still open from the review: `DbClient` re-declared in 17 files, 6 hand-rolled entity-scope dedups, `matchTransactions` O(n·m), and the 11 actions that never enter the policy layer.
- **Branch**: fix/sanitize-action-errors (worktree ~/Code/ledger-core-je-approvals).

### Session authz-audit-at-throw-site · 2026-08-05
- **Scope**: first finding from the 2026-08-05 code review. `requirePermitted` audited the ROLE check only; an unresolved actor (not signed in / no membership / no tenant selected) was refused silently, and whether the attempt reached the audit log depended on which of four hand-copied catch blocks the action inherited — **10 action files wrote the row, 18 did not**, including approve-journal-entry, owner-transfer and the DSR erasure path. Audit moved to the throw site so a new action cannot forget it. Also collapsed a **duplicate `NotAuthenticatedError`** — ./tenant declared a second class of that name which `requireCurrentTenant` threw while every action catch imports ./current-user's, so the `instanceof` would have been silently false; latent today because every call site reaches `requireCurrentUser` first.
- **Verification**: both new tests fail against the pre-fix tree with the right signatures (`expected null not to be null`; `expected [Function NotAuthenticatedError] to be [Function NotAuthenticatedError]`) and the other 11 in that suite pass on both sides. 78 tests green across authz/period-close/accounts/recurring/audit-append-only/soc2-matrix/pen-test-isolation/internal-scope; tsc 0; build clean.
- **⚠️ For the next session**: this closes **7 of the 18** silent files — the ones that gate via `requirePermitted`. The other **11** (apply-ap/ar-payment, approve-journal-entry, bank-feed, data-subject-request, mark-notifications-read, owner-transfer, reassign-ap/ar-item, setup-first-entity, toggle-je-approval) call `requireCurrentUser` + `requireCurrentTenant` directly and never enter the policy layer at all. Their real fix is probably "adopt requirePermitted with a named permission", which is an AUTHORIZATION decision (it picks a role floor), not a refactor — deliberately not done here. Still open from the same review: 62 raw-`e.message` returns across 27 files, `DbClient` re-declared in 17 files, 6 hand-rolled entity-scope dedups, `matchTransactions` O(n·m).
- **Branch**: fix/authz-audit-unresolved-actor (worktree ~/Code/ledger-core-je-approvals).

### Session translation-read-volume · 2026-08-05
- **Scope**: `getTranslatedTrialBalance` read volume — the last logged-not-fixed item from #337. It loaded every ledger-effective line of every in-scope account to add them up in JS; only HISTORICAL accounts can use per-line detail. Now: `groupBy` sums the functional balance in Postgres, and lines are read only for the accounts whose category resolves to a null rate. Two properties deliberately preserved rather than incidentally kept — rates are resolved ONLY for accounts with activity (an unused WEIGHTED_AVG account must not raise `FxRateNotFoundError` over a period-start rate the statement doesn't depend on), and the aggregate and detail passes share ONE line predicate.
- **Verification**: new test counts line rows materialized through EITHER path (journalLine.findMany AND the old nested-`lines` account select) — 6 against the pre-fix tree, 1 after, with the four-category numbers identical either way. 35 tests green across the 4 translation/consolidation suites; tsc 0; build clean. Browser-driven on ACME_GROUP with temporary EUR activity in ACME_EU: cash 1,561.00 (1400 × 1.115 close), APIC 1,050.00 (frozen at January's 1.05 — the per-line walk), revenue 441.20 (× 1.103 avg), CTA 69.80, TB balances; missing-rate probe still falls back to the naïve banner. Seeded entries removed afterward.
- **⚠️ For the next session** (corrected after the merge): the dev DB had lost the ENTIRE Acme consolidation dataset — all four entities at zero entries — which is the "full local `npm test` wipes demo data" hazard, NOT a seed gap. Restored with `seedConsolidationDemo`. The real defect that fell out: `consolidation-demo.ts`'s worked example documented a 1 APRIL window (1.10625 / $8,850 / CTA $1,370) while `deriveDefaultPeriodStart` produces 1 MARCH (1.091 → 1.103 / $8,824 / CTA $1,396), so the file never matched the page. Engine correct both ways — verified by passing `periodStart=2026-04-01` and getting the documented figures back. Comment fixed in the follow-up docs PR.
- **Branch**: perf/translation-historical-only (worktree ~/Code/ledger-core-je-approvals), merged as #350; docs follow-up on docs/consolidation-demo-worked-example.

### Session recurring-idempotency · 2026-08-04
- **Scope**: Code-review follow-ups on the parity arc (PR #337). Recurring runner: a crash between the post and the bookmark used to wedge a STANDARD template permanently (postJournalEntry has no dedup branch — the header claimed one — so the re-run raised P2002 forever); it now pre-checks the lineage triple and catches only the lineage-index conflict, never the entryNumber race. Allocation: month-end/MONTHLY anchor enforced at creation AND run time (a mid-month anchor silently dropped the rest of every month), plus a refusal when rounding would drive the last target negative. **The allocation form could never be submitted** — the gate wanted balanced debits/credits that allocation lines structurally don't have; now mode-aware, with percent-vocabulary footer and "+ Target line". New `entity-scope.ts` (entity shadows shared — three copies lived inside postJournalEntry alone) and `source-lineage.ts` (triple construction + conflict detection).
- **Verification**: CI green on the merge commit (full suite + production build against a fresh DB with the lineage index). Both new regression suites verified to FAIL against the pre-fix tree — the runner test with the exact unique violation, the DOM suite 4-of-6. Browser-driven end to end: mid-month allocation refused with the guard's message, month-end accepted and the template created (the first one ever created through the UI).
- **⚠️ For the next session**: logged-not-fixed — `entryNumber` via `count()+1` races under concurrent posts; `Decimal.set()` is an import side effect of post-journal.ts; `createRecurringEntryAction` still hand-rolls validation instead of Zod and never checks `cadence` against the enum; `getTranslatedTrialBalance` loads every line when only HISTORICAL needs them.
- **Branch**: fix/recurring-idempotency-allocation-guards (worktree ~/Code/ledger-core-je-approvals), merged via PR #337.

### Session allocation-schedules · 2026-08-04
- **Scope**: ALLOCATION recurring templates — migration 0040, `accounting/allocation.ts` (percent-sum-100 or refuse; last-target remainder penny invariant), runner branch (zero activity advances without posting), create action + form (kind selector, source picker, percent column), registry AUTO note.
- **Verification**: 3 new tests + tsc 0 + build clean; browser-verified the form's ALLOCATION mode. Dev DB migrated via `db execute`; fingerprint updated.
- **Branch**: feat/allocation-schedules (worktree ~/Code/ledger-core-je-approvals).

### Session translation-phase-bc · 2026-08-04
- **Scope**: Translation Phases B/C — `reports/translation.ts` (functional-balance translation at #149/#150 category rates; HISTORICAL per-line walk; CTA = credit-positive balancing plug, sign re-derived), consolidation `periodStart` + synthetic CTA equity row + rate map, page/CSV with #152's default derivation, two-mode banner, FxRateNotFoundError → graceful naïve fallback.
- **Verification**: 23 tests green (new suite pins #151's 1950-not-2463.50 double-application refutation + reval-invisibility + HISTORICAL freeze + CTA balance); tsc 0; build clean; browser regression on all-USD Acme (translation inert, new control renders).
- **Branch**: feat/consolidation-translation-b (worktree ~/Code/ledger-core-je-approvals).

### Session translation-phase-a · 2026-08-04
- **Scope**: Translation arc Phase A — per-line `functionalAmount`/`functionalCurrencyId` (migration 0039 + backfill), postJournalEntry derivation (txn==functional → txn amount; functional==reporting → reporting amount; three-way → resolveFxRate or throw; explicit override), revaluation poster stamps functional 0 ONLY when functional ≠ reporting (real remeasurement income keeps its amount when functional==reporting).
- **Verification**: 38 tests green across functional-amount (6, incl. the #151 1000-GBP/1200-USD trap pinned) + invariants + fx-reval ×2; tsc 0; build clean. Dev DB migrated via `db execute`. Schema fingerprint updated.
- **Branch**: feat/consolidation-translation (worktree ~/Code/ledger-core-je-approvals).

### Session ic-pairing · 2026-08-04
- **Scope**: Intercompany auto-pairing shipped — `src/lib/accounting/intercompany.ts` (pure deriveMirrorPlan + prepareIntercompanyMirror via postJournalEntry; lineage triple INTERCOMPANY/gl_entry_mirror/<source-id> is link + idempotency lock, NO schema change), `prepareMirrorAction`, JE-detail Intercompany card + mirror banner, automation-registry REVIEW entry with live count.
- **Verification**: tsc 0; 8/8 new tests + je-approvals + consolidation green; `next build` clean; browser-driven ACME_US→ACME_UK mirror (posted, flipped 2400/5900 lines, audit row, registry count). Demo data note: ACME_US-US_GAAP-00007 + its mirror ACME_UK-US_GAAP-00007 now exist in the default tenant — intentional, they demo the feature.
- **Branch**: feat/intercompany-pairing (worktree ~/Code/ledger-core-je-approvals).

### Session netsuite-parity-201 · 2026-08-04
- **Scope**: Landed PR #201 (Report Builder) after merging 247 commits of main drift into it. Conflict story: the PR's tenantId threading of the legacy reports was superseded by main's #237/#238 (took main for 6 files); deficiency-log entries renumbered #30/#31 with a cross-ref marking #30 as the same finding as #15/#16. Post-June alignment: builder balances now filter `LEDGER_EFFECTIVE_STATUSES` (pending JEs were reaching builder reports — e2e regression added), template mutations gate on new `canManageReportTemplates` (ADMIN; VIEWER could previously mutate), `isBank` threaded through AccountBalance/compat, migration renumbered 0013→0038, schema fingerprint updated, nav catalog row added.
- **Verification**: tsc 0; 127 builder-adjacent tests green (incl. authz-policy + soc2-control-matrix); `next build` clean; browser-verified clone → render (live Northwind numbers) → CSV → VIEWER affordance hiding → delete, with clone/delete audit rows confirmed in audit_log.
- **⚠️ Shared dev DB**: `prisma db push` now proposes DROPPING companion tables (`bank_*`, `xbrl_*`) that live in the same Neon dev DB — do NOT `--accept-data-loss`; apply additive DDL via `prisma db execute` on the migration file (that's how report_template got there).
- **Branch**: `report-builder-design` (worktree ~/Code/ledger-core-je-approvals), merged via PR #201.

### Session reopen-reason-modal · 2026-08-03
- **Scope**: Replaced the `window.prompt()` reopen-reason collector at `src/app/periods/period-actions.tsx` with an in-app modal. `prompt()` throws `Error: prompt() is not supported` in sandboxed/embedded contexts (Chrome blocks it in cross-origin iframes; automation/preview panes reject it), and the unhandled throw made period reopen **unusable** there — for a string that is SOC 2 evidence (`period_reopen_log.reason` + the `reopen-period` audit row). New `src/components/ui/modal.tsx` (controlled, `aria-modal` + real Tab trap, Esc/backdrop dismiss, focus restore, 16px radius; overlay conventions lifted from the ⌘K palette). **Close was converted too** — same component, same blast radius; leaving it would have left `/periods` half-broken in the very environment the bug came from. Semantics unchanged: dismiss aborts, empty/whitespace refused without firing, trimmed string to the action (which still re-validates server-side).
- **Deliberately NOT done**: client-side min-length on the reason (server accepts any non-empty; a client-only floor diverges from the contract and is bypassable — belongs in `reopenPeriodAction` first). The other 11 `confirm()` sites across 9 files collect **no field**, so none met the audit-relevant bar; follow-up now that `Modal` exists.
- **Files**: `src/components/ui/modal.tsx` (new), `src/app/periods/period-actions.tsx`, `tests/period-reopen-dialog.test.tsx` (new, 11), `vitest.config.ts` (+`esbuild.jsx: "automatic"`), `package.json`/`package-lock.json` (jsdom + @testing-library/react + @testing-library/dom), `PROJECT_STATUS.md`, `STATUS.md`. NO schema/migration/fingerprint change; no Server Action change.
- **Branch**: `fix/period-reopen-reason-modal` (worktree `.claude/worktrees/mystifying-mclaren-8c5e6b`).
- **Outcome**: tsc 0; `next build` green; 10 files / 107 tests pass in one run (invariants + cash-flow + fx-reval + the new jsdom suite together — proves the esbuild/jsx config change is inert and jsdom-per-file coexists with the Postgres suites under `singleFork`). **Browser-verified end to end** on the dev DB: closed 2026-11 on NORTHWIND/US_GAAP, reopened it with a deliberately space-padded reason, and confirmed `period_reopen_log.reason` + the audit metadata both stored the **trimmed** 41-char string. Also verified live: field autofocus, empty-reason refusal (dialog stays open, action not fired), Esc + backdrop dismiss with focus restored to the trigger, and the server-error path (the close-task gate's "48 required tasks still open" rendering next to the button). Regression guard proven: all 11 tests FAIL against the pre-change component.
- **⚠️ Environment notes for the next session**: (1) 42 suites — incl. `period-close-action` — call `withPeriodReopenLogMutable`/`withAuditLogMutable`, which **refuse to run** against `ep-misty-resonance/neondb` (not recognizably disposable). Pre-existing and env-only; I did NOT set `AUDIT_LOG_DDL_ALLOW=1` because it disarms the append-only rules DB-wide and a concurrent session was live. CI's `mini_ledger_test` satisfies the guard. (2) **Cookies ignore ports**: a concurrent session's dev server on `localhost:3111` clobbered my `lc-user`/`lc-tenant` on `localhost:3000` mid-verification (a wrong `lc-tenant` surfaces as a confusing "Unknown entity: NORTHWIND" from the action). Fix: drive the app on `http://127.0.0.1:<port>` — a distinct cookie host — when another session is running.
### Session cron-get-verb · 2026-08-01 (commit `5fd3c3f`)
- **Scope**: All four `vercel.json`-registered cron routes exported only `POST`. Vercel Cron always issues a GET and cannot be configured otherwise, so every scheduled job would have 405'd on every fire once deployed — recurring JEs, assertion re-checks, and both Slack alert cadences, i.e. the entire unattended half of the product. Invisible because the app has never been deployed (no `CLERK_SECRET_KEY`; middleware fails closed in prod), and **disguised**: three of the four exported an explicit GET returning 405 "so accidental browser visits don't trigger a run" — a guard that on Vercel blocks only the scheduler. Renamed POST→GET in all four (no internal POST caller — grep found only vercel.json/docs/tests), matching `/api/cron/retention` on `feat/retention-engine`, which had already documented the trap and declined to copy it.
- **Files**: `src/app/api/cron/{assertion-check,recurring-je-run,close-alerts-digest,close-alerts-dispatch}/route.ts`, `tests/{recurring-je-cron-route,close-alerts-digest-route}.test.ts`, `tests/cron-route-verbs.test.ts` (new), `docs/deployment.md`, `PROJECT_STATUS.md`. NO schema/migration/fingerprint change.
- **Branch**: `fix/cron-routes-get-verb` (worktree `.claude/worktrees/amazing-nightingale-a4e30f`).
- **Outcome**: tsc exit 0; `next build` green with all four routes registered ƒ; cron suites 31/31. ⚠️ **Two suites asserted `GET → 405`** — they pinned the defect as intended behavior; assertions replaced, not deleted. New static suite reads `vercel.json` and asserts every cron path resolves to a file exporting GET and not POST (verified to fail 5/13 pre-fix) — note 3 of the 4 pre-fix routes PASSED "exports GET" because of the 405 stub, so the "does not export POST" half is what catches them. ⚠️ `tests/{balance-assertions,close-alerts-assertion-pillar}.test.ts` fail at `beforeAll` on this shared Neon DB (`assertDisposableTestDatabase` refuses to disarm audit_log append-only rules) — **verified identical on a clean tree**, pre-existing and environmental; NOT worked around with `AUDIT_LOG_DDL_ALLOW=1`, which would disarm a control other concurrent suites assert.
### Session d069cc6b · tourkit /how-it-works lane · completed 2026-08-01 17:27
- Shipped #322 (gallery + capture pipeline, dark) and #323 (vendored player). Page verified live: player loads, tour advances, zero CSP violations.
- Found and filed three product defects while shooting the tour: close-task calendar has no UI to instantiate it; close dashboard misdiagnoses that as "templates not seeded"; period reopen uses window.prompt() which throws in embedded browsers.
- ⚠️ Gotcha for everyone: worktrees SHARE .git/hooks — the pre-commit symlink resolves to the MAIN checkout's copy of scripts/pre-commit-secrets-scan.sh. A hook change is only live after it merges AND ~/Code/ledger-core is pulled.
- Left dark on purpose: frames 3–4 undersell the close pillar until the instantiate gap is fixed. Reshoot, then flip (drop robots block + add catalog row).

### Session close-cal · 2026-08-03
- **Scope**: Close-task calendar had no UI entry point — `instantiateCalendarForPeriod` shipped tested but with zero UI callers, and `/close` misdiagnosed "no tasks for this period" as "templates not seeded" (different tables). Added `InstantiateCalendarButton` (one client island, mounted on the dashboard task card + the `/close/tasks` empty state), a pure `resolveCloseCalendarState` resolving NO_TEMPLATES / NOT_INSTANTIATED / INSTANTIATED / PERIOD_CLOSED, and fixed the stale "wired in PR 5" empty-state copy. **Also fixed** `/close/tasks` period resolution: N entities ⇒ N rows per period code (12 for `2026-12` in `default`), so `?period=<code>` from the dashboard landed on another entity's period and the new CTA would have instantiated against it — now scope-entity-preferred with an `id` tiebreaker, chips deduped.
- **Files**: `src/lib/close-tasks/calendar-state.ts` (new), `src/app/close/instantiate-calendar-button.tsx` (new), `src/app/close/page.tsx`, `src/app/close/tasks/page.tsx`, `tests/close-calendar-instantiate-ui.test.ts` (new, 12), `PROJECT_STATUS.md`.
- **Branch**: `fix/close-calendar-instantiate-ui` (worktree `.claude/worktrees/bold-curie-961bd4`).
- **Outcome**: tsc 0; new suite 12/12; close-task neighbours 45/45. Browser-verified end-to-end on the dev DB (all four states; seed → instantiate → 50 tasks / 41 dep edges / 0 dangling / 1 aggregate audit row). No schema change, no migration.

### Session dsr · 2026-07-27
- **Scope**: #46 harvest slice ⑥ — GDPR Art. 15 export + Art. 17 erasure. `buildUserDataExport` (v2 bundle w/ companion attribution that degrades to null), OWNER-only idempotent erasure-by-redaction (User + EmailDelivery.toEmail via search-hash rewrite + **JournalEntryNote.authorEmail by authorUserId** — post-#46 column, unfilterable by value), DATA_ERASURE audit event (migration 0036) carrying an email HASH never plaintext, Zod-validated subject ids, `/admin/data-subject-requests` queue + nav entry.
- **Files**: `src/lib/privacy/{user-data,companion-attribution}.ts` (new), `src/app/actions/data-subject-request.ts` (new), `src/app/admin/data-subject-requests/*` (new ×2), `src/lib/audit/log.ts` (+DATA_ERASURE), `prisma/{schema.prisma,migrations/0036_dsr_erasure_event/}`, nav catalog, `tests/data-subject-requests.test.ts` (new, 6).
- **Branch**: `feat/dsr` (worktree ~/Code/ledger-core-je-approvals).
- **Outcome**: tsc 0; DSR suite 6/6; browser-verified (unauth gate + admin queue). Unblocks #47 retarget + #135 rewrite. Full suite at commit time — see PR.

### Session owner-transfer · 2026-07-27
- **Scope**: #46 harvest slice ⑤ — two-step tenant ownership transfer. Pending-offer columns (migration 0035), pure lifecycle lib (OWNER-only initiate; target-only accept with identity-masking refusals; atomic role swap + ownerUserId rotation; either-party cancel), audited actions + bell + offered/accepted/cancelled emails, `/admin/team` Ownership card with the non-admin pending-target carve-out.
- **Files**: `prisma/{schema.prisma,migrations/0035_owner_transfer/}`, `src/lib/auth/owner-transfer.ts` (new), `src/app/actions/owner-transfer.ts` (new), `src/app/admin/team/{page,owner-transfer-card}.tsx`, `src/lib/email/templates/owner-transfer-{offered,accepted,cancelled}.ts` (new ×3), `src/app/actions/team.ts` (message), `tests/owner-transfer.test.ts` (new).
- **Branch**: `feat/owner-transfer` (worktree ~/Code/ledger-core-je-approvals, branch-switched after ④ merged).
- **Outcome**: tsc 0; suite 4/4; browser-verified both sides of the OWNER gate. ⚠️ Teardown lesson: the initiate action rings the bell — delete `notification` rows before the tenant. Full suite 153 files / 1264 tests ALL PASS in the worktree.

### Session je-approvals · 2026-07-25
- **Scope**: #46 harvest slice ④ — maker-checker JE approvals. `initialStatus` seam in postJournalEntry (period-close check + rules deferred to approval); `LEDGER_EFFECTIVE_STATUSES` stamped on EVERY aggregation site (reports/revaluation/tie-outs/bank-match/ask-tool/register — they previously had NO status filter); approval lifecycle lib (self-approval refused, reason-required reject, submitter-only withdraw); tenant flag + threshold + pure routing matrix; `/journal-entries/pending` queue + JE-detail panels + team-page policy card; approve/reject emails via slice ②.
- **Files**: `prisma/{schema.prisma,migrations/0034_je_maker_checker/}`, `src/lib/accounting/{types,post-journal,approval,approval-threshold,reports,revaluation,subledger-ties}.ts`, `src/lib/banking/match.ts`, `src/lib/assistant/tools.ts`, `src/app/accounts/[code]/page.tsx`, actions ×3, `src/app/journal-entries/pending/` + `[id]` panels, `src/app/admin/team/{page,approval-toggle}.tsx`, templates ×2, nav catalog, `tests/je-approvals.test.ts` (13).
- **Branch**: `feat/je-approvals` (worktree ~/Code/ledger-core-je-approvals).
- **Outcome**: tsc 0; approvals suite 13/13 incl. the TB-exclusion core claim; browser-verified queue + policy card; full suite 152 files / 1260 tests ALL PASS in the worktree.

### Session team-invites · 2026-07-24
- **Scope**: #46 harvest slice ③ — team management. `/admin/team` + `/invites/accept` + team.ts actions (invite/revoke/change-role/remove, all requirePermitted + audited); VIEWER role added (migration 0033 enum value; auditor seed flipped); `TenantInvite` with day-one email encryption + search hash; accept state machine extracted to `src/lib/team/accept-invite.ts`; RLS policy #54. ⚠️ Rewriter does NOT recurse relation filters — resolve User top-level, then membership by userId.
- **Files**: `prisma/{schema.prisma,migrations/0033_tenant_invite_and_viewer/}`, RLS phase-1 SQL, `src/lib/auth/policy.ts` (VIEWER), `src/lib/db/encrypted-fields-extension.ts`, `src/lib/seed/northwind.ts`, `src/app/actions/team.ts` (new), `src/lib/team/accept-invite.ts` (new), `src/lib/email/templates/invite.ts` (new), `src/app/admin/team/*` (new ×3), `src/app/invites/accept/page.tsx` (new), `src/components/nav/catalog.ts`, `tests/team-invites.test.ts` (new).
- **Branch**: `feat/team-invites` (worktree ~/Code/ledger-core-team-invites).
- **Outcome**: tsc 0; full suite 151 files — 150 passed + one fixture bug in the NEW suite caught under full-parallel and fixed: users created via the RAW client carry NULL emailHash, and a prior suite's leaked FIELD_DETERMINISTIC_KEY makes the rewritten equality filter miss them (the documented raw-client rollout gap, reproduced in a fixture). Fix: create fixture users through the APP client. Suite now passes bare AND with keys ambient. Browser-verified on the dev DB (invite → LOGGED_ONLY + accept URL + pending row; wrong-user accept → EMAIL MISMATCH).
### Session ui-polish-vibecurb · 2026-07-24
- **Scope**: UI-only polish pass derived from the VibeCurb ruleset, calibrated for a data app (marketing-page atmospherics rejected). Warm stone `ink` palette (same semantic names — zero className churn), Outfit display font on headings only, primitive upgrades (Card/Button/Table/Input), snap-easing motion behind `prefers-reduced-motion`, header breadcrumb demoted to a truncating context line.
- **Files**: `tailwind.config.ts`, `src/app/globals.css`, `src/app/layout.tsx`, `src/components/ui/{card,button,table,input}.tsx`, 16 page-title h1 classNames.
- **Branch**: `feat/ui-polish-vibecurb` (worktree ~/Code/ledger-core-ui-polish).
- **Outcome**: tsc 0; `next build` green; browser-verified on dev DB (palette/radius/easing confirmed via computed styles, zero console errors). NO logic/schema.
- **Second commit — NetSuite nav reorg (owner's direct request)**: the "More (N)" Pareto compression is GONE; all 39 destinations visible across 8 NetSuite-taxonomy sections (Overview / Transactions / Sub-ledgers / Lists / Reports / Period & close / Automation / Setup). Open AR/AP promoted to a first-class Sub-ledgers region; every report enumerated; the full close suite shown; admin section renamed Setup with Import moved in. DOM-verified: 39 links, hasMore=false, nav scrolls independently. ⚠️ Team link 404s until #314 merges — merge #314 BEFORE this branch and resolve the catalog.ts conflict by keeping THIS file (it already includes Team).

### Session authz-policy-layer · 2026-07-24
- **Scope**: #46 harvest slice ① — per-tenant RBAC. New `src/lib/auth/policy.ts` (named-permission catalog) + `src/lib/auth/authorize.ts` (`requirePermitted`/`getViewerRole`); DELETED the email-allowlist `isAdmin`/`requireAdmin` and migrated all 21 call sites; tenant-pinned period close/reopen entity lookups; user-lifecycle membership pin + previously-missing audit rows; seeds grant memberships (controller ADMIN etc.).
- **Files**: `src/lib/auth/{policy,authorize,current-user}.ts`, 7 actions, 13 pages, audit-log CSV route, `src/lib/seed/{northwind,default-tenant}.ts`, `tests/authz-policy.test.ts` (new), `tests/{auth-current-user,period-close-action}.test.ts`.
- **Branch**: `feat/authz-policy-layer` (worktree ~/Code/ledger-core-authz-policy). NO schema/migration/fingerprint change.
- **Outcome**: tsc exit 0; full suite 149 files — 147 pass + period-close fixture fixed (now 9/9) + property-fuzz confirmed Neon-load flake (5/5 alone). ⚠️ Suites signing in via `lc-user` must pin `lc-tenant` — auto-resolve is concurrency-unsafe.
### Session email-infra · 2026-07-24
- **Scope**: #46 harvest slice ② — transactional email substrate. `sendEmail()` (Resend / LOGGED_ONLY degrade, never throws) + `EmailDelivery` model (migration 0032) + RLS policy #53 + day-one encryption of toEmail/subject/bodies with `toEmailHash` search hash. LOGGED_ONLY console line redacted vs #46 (no recipient/subject/body in stdout). Templates deferred to their consuming slices.
- **Files**: `src/lib/email/send.ts` (new), `prisma/schema.prisma` + `prisma/migrations/0032_email_delivery/`, `prisma/sql/2026-06-05-rls-phase-1-policies.sql`, `src/lib/db/encrypted-fields-extension.ts`, `src/lib/env.ts`, `tests/email-send.test.ts` (new), fingerprint.
- **Branch**: `feat/email-infra` (worktree ~/Code/ledger-core-email-infra).
- **Outcome**: tsc 0; full suite 149 files / 1228 tests ALL PASS in the worktree (incl. the new email suite and the encryption-extension suite against the widened registry).

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
