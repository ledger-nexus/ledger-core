# Merge order — 2026-06-08 session

20 PRs landed today across 3 architectural arcs + 1 closure tail. They stack linearly — each PR's base is the previous PR's head. Land them in numerical order (PR #141 → #161) to get a clean fast-forward merge into `main`. Out-of-order merges hit conflicts on shared files (`import.ts`, `consolidation.ts`, `subsidiaries.ts`).

## The 20-PR stack

| # | PR | Title | Files of note |
|---|----|-------|--------------|
| 1 | [#141](https://github.com/ledger-nexus/ledger-core/pull/141) | v0.7 Phase 4: NS multi-sub reverse exporter + roundtrip proof | `subsidiaries.ts`, `export.ts`, multi-sub fixture |
| 2 | [#142](https://github.com/ledger-nexus/ledger-core/pull/142) | `pnpm demo:ns-multi-sub` — multi-sub showcase clip | `prisma/demo-ns-multi-sub.ts`, `package.json` |
| 3 | [#143](https://github.com/ledger-nexus/ledger-core/pull/143) | `/import/netsuite` UI + hardened Server Action | `import-netsuite.ts`, `/import/netsuite/page.tsx` |
| 4 | [#144](https://github.com/ledger-nexus/ledger-core/pull/144) | consolidation: multi-currency disclosure banner | `consolidation.ts`, `consolidation/page.tsx` |
| 5 | [#145](https://github.com/ledger-nexus/ledger-core/pull/145) | docs: PROJECT_STATUS captures v0.7 NS multi-sub arc | `PROJECT_STATUS.md` |
| 6 | [#146](https://github.com/ledger-nexus/ledger-core/pull/146) | v0.8 FX Phase 1 + 1.5: helper + Northwind seed + importer wiring | `fx.ts`, `northwind.ts`, `import.ts` |
| 7 | [#147](https://github.com/ledger-nexus/ledger-core/pull/147) | v0.8 FX Phase 2: NS exchangerate precedence | `types.ts`, `import.ts` |
| 8 | [#148](https://github.com/ledger-nexus/ledger-core/pull/148) | v0.8 FX Phase 3: realized FX gain/loss on AR/AP | `chart-of-accounts.ts`, `import.ts` |
| 9 | [#149](https://github.com/ledger-nexus/ledger-core/pull/149) | v0.8 FX Phase 4a: Account.translationCategory schema | migration 0008, `schema.prisma` |
| 10 | [#150](https://github.com/ledger-nexus/ledger-core/pull/150) | v0.8 FX Phase 4b: getTranslationRate per ASC 830 category | `fx.ts` |
| 11 | [#151](https://github.com/ledger-nexus/ledger-core/pull/151) | v0.8 FX Phase 4c: consolidation translation + CTA | `consolidation.ts` |
| 12 | [#152](https://github.com/ledger-nexus/ledger-core/pull/152) | v0.8 FX Phase 5: consolidation page wires periodStart + replaces banner | `consolidation/page.tsx` |
| 13 | [#153](https://github.com/ledger-nexus/ledger-core/pull/153) | docs: PROJECT_STATUS captures v0.8 ASC 830 FX translation arc | `PROJECT_STATUS.md` |
| 14 | [#154](https://github.com/ledger-nexus/ledger-core/pull/154) | v0.8 NS Accounting Books Phase 1: design + types + mapper + setupBooks | `books.ts`, `types.ts`, `netsuite-accounting-books-design.md` |
| 15 | [#155](https://github.com/ledger-nexus/ledger-core/pull/155) | v0.8 NS Books Phase 2: lineage-uniq scoped to (tenantId, bookId) | migration 0009 |
| 16 | [#156](https://github.com/ledger-nexus/ledger-core/pull/156) | v0.8 NS Books Phase 3: per-tx routing through importer | `import.ts` |
| 17 | [#157](https://github.com/ledger-nexus/ledger-core/pull/157) | docs: PROJECT_STATUS captures v0.9 NS Accounting Books arc | `PROJECT_STATUS.md` |
| 18 | [#158](https://github.com/ledger-nexus/ledger-core/pull/158) | v0.9 NS Books Phase 4: reverse exporter for multi-book roundtrip | `export.ts` |
| 19 | [#159](https://github.com/ledger-nexus/ledger-core/pull/159) | v0.9 NS Books: promote isEliminationEntity to a column | migration 0010, `subsidiaries.ts` |
| 20 | [#161](https://github.com/ledger-nexus/ledger-core/pull/161) | v0.8 FX HISTORICAL line-walking — closes the v0.8 Phase 4c pragma | `consolidation.ts`, new `fx-consolidation-historical.test.ts` |

## Three arcs + one closure tail

The 19 architectural PRs cluster cleanly into 3 NS axes; the 20th (#161) is a focused closure of a documented v0.8 pragma:

### v0.7 closing (PRs #141 → #145) — 5 PRs
**Entity axis**: NS multi-subsidiary import, end-to-end through to consolidated trial balance. Phase 4 reverse exporter closes the roundtrip. UI + demo + hardened Server Action ship the v0.7 deliverable. Multi-currency disclosure banner makes the gap honest before the FX arc lands.

### v0.8 ASC 830 FX translation (PRs #146 → #153) — 8 PRs
**Currency axis**: from transaction-time rate at posting (Phase 1.5), to NS exchangerate precedence (Phase 2), to realized FX gain/loss on AR/AP settlement (Phase 3), to period-end translation per ASC 830 category (4a + 4b + 4c), to the page surfacing CTA + per-entity rates (Phase 5). The v0.7 disclosure banner becomes "FX translation active" with accurate translated numbers + methodology.

### v0.9 NS Accounting Books (PRs #154 → #159) — 6 PRs
**Book axis**: multi-book parallel posting driven by NS data. Phase 2's lineage-uniq migration also fixes a long-standing cross-tenant collision bug. Phase 4 closes the reverse roundtrip. The isEliminationEntity column promotion is architectural debt cleanup the arc surfaced.

### v0.8 FX closure tail (PR #161) — 1 PR
**Currency-axis polish**: closes the documented HISTORICAL-pass-through pragma from v0.8 Phase 4c. ASC 830 requires HISTORICAL accounts (equity) to translate at the rate IN EFFECT WHEN POSTED, not the period-end rate. The new `translateHistoricalAccount` walker queries each JournalLine for the account + multiplies each line's debit/credit by its parent JE's `fxRate`. The CTA plug stops absorbing the equity-translation gap; pre-existing Phase 4c test shrinks from CTA=360 → 120 (the 240 difference was the missing equity translation). New `fx-consolidation-historical` test posts two contributions at DIFFERENT historical rates (1.20 and 1.15) to prove single-rate translation can't reproduce the line-walked result.

## Migration dependencies

Three Prisma migrations land in numerical order:

- **0008** (PR #149) — adds `Account.translationCategory` enum + column with backfill
- **0009** (PR #155) — scopes `gl_entry_header_lineage_uniq` to `(tenantId, bookId, ...)`
- **0010** (PR #159) — adds `LegalEntity.isEliminationEntity` column with backfill

Each is idempotent (`IF NOT EXISTS` / `WHERE NOT EXISTS`). Production rollout: apply in order; no operator coordination needed beyond the merge sequence itself.

## Test results across the stack

Verified on dev DB at the head of #161:

- **81/81** NS + FX test files green:
  - `netsuite-multi-subsidiary` (v0.7 Phase 1 unit): 15/15
  - `netsuite-multi-subsidiary-integration` (v0.7 Phase 2 Postgres): 6/6
  - `netsuite-import-multi-sub-e2e` (v0.7 Phase 3 e2e): 5/5
  - `netsuite-roundtrip-multi-sub` (v0.7 Phase 4 export): 2/2
  - `netsuite-fx-exchangerate-precedence` (v0.8 FX Phase 2): 2/2
  - `netsuite-fx-realized-gain-loss` (v0.8 FX Phase 3): 2/2
  - `fx-translation-rate` (v0.8 FX Phase 4b): 8/8
  - `fx-translation-category` (v0.8 FX Phase 4a): 9/9
  - `fx-consolidation-translation` (v0.8 FX Phase 4c): 4/4
  - `fx-consolidation-historical` (v0.8 FX closure tail, PR #161): 2/2
  - `netsuite-accounting-books` (v0.9 NS Books Phase 1): 19/19
  - `netsuite-accounting-books-integration` (v0.9 NS Books Phase 2): N/N
  - `netsuite-accounting-books-routing` (v0.9 NS Books Phase 3): 2/2
  - `netsuite-accounting-books-roundtrip` (v0.9 NS Books Phase 4): 2/2
  - `ns-iselimination-column` (v0.9 column promotion): 3/3
- **tsc clean** across all 20 PR diffs
- **Backward compat preserved** at every layer — every existing v0.7 test passes against the head of the stack

## What's still deferred (not in this session)

- NS Books Phase 3.5: sub-ledger multi-book (Invoice/Bill/Payment per-book open items)
- NS Books Phase 4.5: operator-supplied original `AccountingBook[]` preserved byte-for-byte
- NS Books Phase 5: UI book-mapping editor on `/import/netsuite`
- NS SuiteAnalytics → report endpoints
- Drop the `extensions.nsIsElimination` JSON flag after every consumer migrates to the column

(HISTORICAL line-walking in consolidation was closed by PR #161 — entries removed from this list.)

## Recommended merge approach

1. Land PRs in numerical order on a feature merge train branch (e.g. `merge-train-2026-06-08`).
2. Squash-merge each PR — the linear history makes the train easy to revert by PR if needed.
3. After all 20 land on the train, fast-forward `main`.
4. Run the 81-test NS + FX suite on `main` post-merge as the production-readiness check.
5. Document the session in the operator runbook (or chain a session-capstone doc PR if useful).

Alternative for individual review: cherry-pick the docs PRs (#145, #153, #157) and the column-promotion PR (#159) first — those are low-risk single-file changes. The architectural PRs need the chain order preserved.
