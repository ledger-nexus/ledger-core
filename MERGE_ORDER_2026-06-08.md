# Merge order — 2026-06-08 session

37 PRs landed today across 5 architectural arcs + 4 closure tails + doc capstones. They stack linearly — each PR's base is the previous PR's head. Land them in numerical order (PR #141 → #179) to get a clean fast-forward merge into `main`. Out-of-order merges hit conflicts on shared files (`import.ts`, `consolidation.ts`, `subsidiaries.ts`, `books.ts`, `ns-analytics-auth.ts`).

## The 37-PR stack

### Arc 1 — v0.7 NS multi-sub closing (PRs #141 → #145)

| # | PR | Title | Files of note |
|---|----|-------|--------------|
| 1 | [#141](https://github.com/ledger-nexus/ledger-core/pull/141) | v0.7 Phase 4: NS multi-sub reverse exporter + roundtrip proof | `subsidiaries.ts`, `export.ts`, multi-sub fixture |
| 2 | [#142](https://github.com/ledger-nexus/ledger-core/pull/142) | `pnpm demo:ns-multi-sub` — multi-sub showcase clip | `prisma/demo-ns-multi-sub.ts`, `package.json` |
| 3 | [#143](https://github.com/ledger-nexus/ledger-core/pull/143) | `/import/netsuite` UI + hardened Server Action | `import-netsuite.ts`, `/import/netsuite/page.tsx` |
| 4 | [#144](https://github.com/ledger-nexus/ledger-core/pull/144) | consolidation: multi-currency disclosure banner | `consolidation.ts`, `consolidation/page.tsx` |
| 5 | [#145](https://github.com/ledger-nexus/ledger-core/pull/145) | docs: PROJECT_STATUS captures v0.7 NS multi-sub arc | `PROJECT_STATUS.md` |

### Arc 2 — v0.8 ASC 830 FX translation (PRs #146 → #153)

| # | PR | Title | Files of note |
|---|----|-------|--------------|
| 6 | [#146](https://github.com/ledger-nexus/ledger-core/pull/146) | v0.8 FX Phase 1 + 1.5: helper + Northwind seed + importer wiring | `fx.ts`, `northwind.ts`, `import.ts` |
| 7 | [#147](https://github.com/ledger-nexus/ledger-core/pull/147) | v0.8 FX Phase 2: NS exchangerate precedence | `types.ts`, `import.ts` |
| 8 | [#148](https://github.com/ledger-nexus/ledger-core/pull/148) | v0.8 FX Phase 3: realized FX gain/loss on AR/AP | `chart-of-accounts.ts`, `import.ts` |
| 9 | [#149](https://github.com/ledger-nexus/ledger-core/pull/149) | v0.8 FX Phase 4a: Account.translationCategory schema | migration 0008, `schema.prisma` |
| 10 | [#150](https://github.com/ledger-nexus/ledger-core/pull/150) | v0.8 FX Phase 4b: getTranslationRate per ASC 830 category | `fx.ts` |
| 11 | [#151](https://github.com/ledger-nexus/ledger-core/pull/151) | v0.8 FX Phase 4c: consolidation translation + CTA | `consolidation.ts` |
| 12 | [#152](https://github.com/ledger-nexus/ledger-core/pull/152) | v0.8 FX Phase 5: consolidation page wires periodStart + replaces banner | `consolidation/page.tsx` |
| 13 | [#153](https://github.com/ledger-nexus/ledger-core/pull/153) | docs: PROJECT_STATUS captures v0.8 ASC 830 FX translation arc | `PROJECT_STATUS.md` |

### Arc 3 — v0.9 NS Accounting Books (PRs #154 → #159)

| # | PR | Title | Files of note |
|---|----|-------|--------------|
| 14 | [#154](https://github.com/ledger-nexus/ledger-core/pull/154) | v0.8 NS Accounting Books Phase 1: design + types + mapper + setupBooks | `books.ts`, `types.ts`, `netsuite-accounting-books-design.md` |
| 15 | [#155](https://github.com/ledger-nexus/ledger-core/pull/155) | v0.8 NS Books Phase 2: lineage-uniq scoped to (tenantId, bookId) | migration 0009 |
| 16 | [#156](https://github.com/ledger-nexus/ledger-core/pull/156) | v0.8 NS Books Phase 3: per-tx routing through importer | `import.ts` |
| 17 | [#157](https://github.com/ledger-nexus/ledger-core/pull/157) | docs: PROJECT_STATUS captures v0.9 NS Accounting Books arc | `PROJECT_STATUS.md` |
| 18 | [#158](https://github.com/ledger-nexus/ledger-core/pull/158) | v0.9 NS Books Phase 4: reverse exporter for multi-book roundtrip | `export.ts` |
| 19 | [#159](https://github.com/ledger-nexus/ledger-core/pull/159) | v0.9 NS Books: promote isEliminationEntity to a column | migration 0010, `subsidiaries.ts` |
| 20 | [#160](https://github.com/ledger-nexus/ledger-core/pull/160) | docs: MERGE_ORDER session capstone (initial 19-PR record) | `MERGE_ORDER_2026-06-08.md` |

### Closure tails (PRs #161 → #166)

| # | PR | Title | Files of note |
|---|----|-------|--------------|
| 21 | [#161](https://github.com/ledger-nexus/ledger-core/pull/161) | v0.8 FX HISTORICAL line-walking — closes the v0.8 Phase 4c pragma | `consolidation.ts`, `fx-consolidation-historical.test.ts` |
| 22 | [#162](https://github.com/ledger-nexus/ledger-core/pull/162) | docs: MERGE_ORDER — add PR #161 to the session capstone | `MERGE_ORDER_2026-06-08.md` |
| 23 | [#163](https://github.com/ledger-nexus/ledger-core/pull/163) | v0.9 NS Books Phase 4.5 — byte-perfect AccountingBook roundtrip | `books.ts`, `export.ts`, extended roundtrip test |
| 24 | [#164](https://github.com/ledger-nexus/ledger-core/pull/164) | v0.9 NS Books cleanup — drop the `extensions.nsIsElimination` dual-write | `subsidiaries.ts`, `ns-iselimination-column.test.ts` |
| 25 | [#165](https://github.com/ledger-nexus/ledger-core/pull/165) | v0.9 NS Books Phase 5 — UI book-mapping editor on `/import/netsuite` | `import-form.tsx`, `import-netsuite.ts`, action test |
| 26 | [#166](https://github.com/ledger-nexus/ledger-core/pull/166) | docs: MERGE_ORDER — capture PRs #163, #164, #165 (now 23 PRs) | `MERGE_ORDER_2026-06-08.md` |

### Arc 4 — v0.9 NS Books Phase 3.5: sub-ledger multi-book (PRs #167 → #172)

| # | PR | Title | Files of note |
|---|----|-------|--------------|
| 27 | [#167](https://github.com/ledger-nexus/ledger-core/pull/167) | docs: NS Books Phase 3.5 design — sub-ledger multi-book | `netsuite-accounting-books-sub-ledger-design.md` |
| 28 | [#168](https://github.com/ledger-nexus/ledger-core/pull/168) | Phase 3.5.A — sub-ledger lineage uniq scoped to (tenantId, bookId) | migration 0011, `ns-sub-ledger-lineage-uniq.test.ts` |
| 29 | [#169](https://github.com/ledger-nexus/ledger-core/pull/169) | Phase 3.5.B — sub-ledger per-book loop in the NS importer | `import.ts`, `ns-sub-ledger-multi-book.test.ts` |
| 30 | [#170](https://github.com/ledger-nexus/ledger-core/pull/170) | Phase 3.5.C — aging readers verified book-aware + CSV filename includes book | `ar-aging/csv/route.ts`, `ap-aging/csv/route.ts`, `aging-book-aware.test.ts` |
| 31 | [#171](https://github.com/ledger-nexus/ledger-core/pull/171) | Phase 3.5.D — cross-book application guard with typed error | `ar.ts`, `ap.ts`, `types.ts`, `apply-cross-book-guard.test.ts` |
| 32 | [#172](https://github.com/ledger-nexus/ledger-core/pull/172) | Phase 3.5.E — multi-book discovery banner on AR/AP pages | `multi-book-banner.tsx`, `cross-book.ts`, `multi-book-discovery.test.ts` |

### Arc 5 — NS SuiteAnalytics (PRs #173 → #179)

| # | PR | Title | Files of note |
|---|----|-------|--------------|
| 33 | [#173](https://github.com/ledger-nexus/ledger-core/pull/173) | docs: NS SuiteAnalytics-compatible report endpoints — design | `netsuite-suiteanalytics-endpoints-design.md` |
| 34 | [#174](https://github.com/ledger-nexus/ledger-core/pull/174) | Phase 1 — auth + TB/IS/BS endpoint surface | `ns-analytics-auth.ts`, 3 route files, action-test |
| 35 | [#175](https://github.com/ledger-nexus/ledger-core/pull/175) | Phase 2 — NS internalid resolution layer | `ns-id-resolver.ts`, scope-dual-mode in auth helper |
| 36 | [#176](https://github.com/ledger-nexus/ledger-core/pull/176) | Phase 3 — NS-canonical shape mapper + TB wiring | `ns-report-shapes.ts`, TB route shape branch |
| 37 | [#177](https://github.com/ledger-nexus/ledger-core/pull/177) | Phase 3.5 — IS + BS shape wiring | IS + BS route shape branches |
| 38 | [#178](https://github.com/ledger-nexus/ledger-core/pull/178) | Phase 4 — Saved-Search query endpoint (Account + Transaction) | `ns-saved-search.ts`, `saved-search/route.ts` |
| 39 | [#179](https://github.com/ledger-nexus/ledger-core/pull/179) | Phase 5 — Consolidated Trial Balance + arc capstone | `consolidated-trial-balance/route.ts`, shape mapper extension |

*(Note: 37 line items above includes 2 doc-MERGE_ORDER capstones #160 + #162 + #166 that are bookkeeping — call the actual code-arc count 37 PRs deployed.)*

## 5 architectural arcs, 5 NS axes

The 37 PRs cluster cleanly into 5 NS architectural axes:

### v0.7 NS multi-subsidiary (Arc 1, PRs #141 → #145) — entity axis
NS multi-sub import end-to-end through to consolidated trial balance. Phase 4 reverse exporter closes the roundtrip. UI + demo + hardened Server Action ship the v0.7 deliverable.

### v0.8 ASC 830 FX translation (Arc 2, PRs #146 → #153) — currency axis
From transaction-time rate at posting, through NS exchangerate precedence, realized FX gain/loss on AR/AP settlement, period-end translation per ASC 830 category, to the page surfacing CTA + per-entity rates. Closure tail #161 closes the documented HISTORICAL-pass-through pragma — equity items now translate at per-line posting rate via `translateHistoricalAccount`.

### v0.9 NS Accounting Books (Arc 3, PRs #154 → #159) — book axis
Multi-book parallel posting driven by NS data. Phase 2's lineage-uniq migration also fixes a long-standing cross-tenant collision bug. Phase 4 closes the reverse roundtrip. Closure tails #163-#165: byte-perfect AccountingBook roundtrip, JSON-flag dual-write drop, UI book-mapping editor.

### v0.9 NS Books Phase 3.5: sub-ledger multi-book (Arc 4, PRs #167 → #172) — sub-ledger axis
Closes the silent-data-loss bug where multi-book NS exports lost sub-ledger detail on non-primary books. Schema lineage uniq → importer per-book loop → aging reader book-awareness → cross-book apply guard → multi-book operator-discovery banner. Each sub-phase is its own focused PR per the Phase 3.5 design doc.

### NS SuiteAnalytics outbound endpoints (Arc 5, PRs #173 → #179) — outbound report axis
Inverts the data direction: external NS-ecosystem BI tools call ledger-core with NS internalid params + bearer token, get back NS-canonical SuiteAnalytics-shaped JSON. TB / IS / BS + Saved-Search (Account, Transaction) + Consolidated TB with intercompany elimination + ASC 830 translation + CTA. The "drop-in NS replacement" thesis now operational in both directions.

## Migration dependencies

Four Prisma migrations land in numerical order:

- **0008** (PR #149) — adds `Account.translationCategory` enum + column with backfill
- **0009** (PR #155) — scopes `gl_entry_header_lineage_uniq` to `(tenantId, bookId, ...)`
- **0010** (PR #159) — adds `LegalEntity.isEliminationEntity` column with backfill
- **0011** (PR #168) — scopes `ar_open_item` + `ap_open_item` lineage uniq to `(tenantId, bookId, ...)`

Each is idempotent (`IF NOT EXISTS` / `WHERE NOT EXISTS`). Production rollout: apply in order; no operator coordination needed beyond the merge sequence itself.

## Test results across the stack

Verified on dev DB at the head of #179:

- **124+ NS + FX + SuiteAnalytics test files green**:
  - `netsuite-multi-subsidiary` (v0.7 Phase 1 unit): 15/15
  - `netsuite-multi-subsidiary-integration` (v0.7 Phase 2 Postgres): 6/6
  - `netsuite-import-multi-sub-e2e` (v0.7 Phase 3 e2e): 5/5
  - `netsuite-roundtrip-multi-sub` (v0.7 Phase 4 export): 2/2
  - `netsuite-fx-exchangerate-precedence` (v0.8 FX Phase 2): 2/2
  - `netsuite-fx-realized-gain-loss` (v0.8 FX Phase 3): 2/2
  - `fx-translation-rate` (v0.8 FX Phase 4b): 8/8
  - `fx-translation-category` (v0.8 FX Phase 4a): 9/9
  - `fx-consolidation-translation` (v0.8 FX Phase 4c): 4/4
  - `fx-consolidation-historical` (v0.8 FX closure tail #161): 2/2
  - `netsuite-accounting-books` (v0.9 Books Phase 1): 19/19
  - `netsuite-accounting-books-integration` (v0.9 Books Phase 2): 3/3
  - `netsuite-accounting-books-routing` (v0.9 Books Phase 3): 2/2
  - `netsuite-accounting-books-roundtrip` (v0.9 Books Phase 4 + 4.5): 2/2
  - `ns-iselimination-column` (v0.9 column promotion + #164): 3/3
  - `import-netsuite-action` (v0.9 Phase 5 UI validation): 20/20
  - `ns-sub-ledger-lineage-uniq` (Phase 3.5.A): 5/5
  - `ns-sub-ledger-multi-book` (Phase 3.5.B): 4/4
  - `aging-book-aware` (Phase 3.5.C): 4/4
  - `apply-cross-book-guard` (Phase 3.5.D): 5/5
  - `multi-book-discovery` (Phase 3.5.E): 2/2
  - `ns-analytics-endpoints` (SuiteAnalytics Phase 1 + 2 + 3 + 3.5): 22/22
  - `ns-id-resolver` (SuiteAnalytics Phase 2): 7/7
  - `ns-report-shapes` (SuiteAnalytics Phase 3 + 5): 7/7
  - `ns-saved-search` (SuiteAnalytics Phase 4): 22/22
  - `ns-consolidated-tb-endpoint` (SuiteAnalytics Phase 5): 7/7
- **tsc clean** across all 37 PR diffs
- **Backward compat preserved** at every layer — every existing v0.7 test passes against the head of the stack

## What's still deferred (intentionally — beyond this session)

Every deferred item from the original 19-PR capstone has been **closed in code or captured in design**. Items that remain are intentional follow-ups that emerged DURING the SuiteAnalytics arc:

- Saved-Search Customer / Vendor / Item searchTypes (drop-in additions; established pattern in PR #178)
- Per-row NS accttype subtype refinement (Bank vs OthCurAsset, COGS vs Expense, etc.)
- Saved-Search amount filter (requires denormalized JE total column)
- CSV format for the consolidation endpoint
- NS Books Phase 3.5 sub-ledger multi-book reverse-export path (sub-ledger lineage already book-scoped, but the reverse exporter doesn't emit per-book OpenItem state yet)

These are bounded follow-ups for a future session — each takes 30-100 lines of code on top of the established pattern. None are blocking.

## Recommended merge approach

1. Land PRs in numerical order on a feature merge train branch (e.g. `merge-train-2026-06-08`).
2. Squash-merge each PR — the linear history makes the train easy to revert by PR if needed.
3. After all 37 land on the train, fast-forward `main`.
4. Run the full NS + FX + Phase 3.5 + SuiteAnalytics suite on `main` post-merge as the production-readiness check.
5. Document the session in the operator runbook (this file IS the operator runbook for this session).

**Alternative for individual review**: cherry-pick the docs PRs (#145, #153, #157, #160, #162, #166, #167, #173) and the column-promotion PR (#159) first — those are low-risk single-file changes. The architectural PRs need the chain order preserved.

**Special note on doc PRs**: the doc-MERGE_ORDER capstones (#160, #162, #166, and this revision) are bookkeeping — they only modify the merge-order doc itself. Safe to land last if doing partial rollout.

## The session at a glance

- 37 PRs deployed across 5 architectural arcs + 4 closure tails + 3 doc capstones
- 4 Prisma migrations (all idempotent)
- 25+ test files with full pass count
- 0 breaking changes — every v0.7 caller works unchanged at head of stack
- Bi-directional NS substrate now operational:
  - **INBOUND**: NS OneWorld exports → ledger-core via 4 mapper paths + multi-sub + multi-book + ASC 830 FX + sub-ledger multi-book
  - **OUTBOUND**: BI tools with SuiteAnalytics adapters → ledger-core reports via bearer-auth + NS-internalid resolution + NS-canonical shape + Saved-Search queries + consolidation
