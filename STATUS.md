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

### Session: codex-findings (Claude, 2026-07-17)

- **Claiming:** `src/app/page.tsx` (data/scope layer only, NOT empty-state copy), `src/lib/accounting/subledger-ties.ts`, `src/lib/accounting/sub-ledgers/fixed-assets.ts`, `src/lib/assistant/tools.ts`, `src/app/actions/bank-feed.ts`, `prisma/schema.prisma` + a new migration
- **Why:** Remediate the 8 Codex review findings on `main@0cb47d4` (cross-tenant dashboard leak, assistant-tool book widening, bank-feed IDOR/TOCTOU) across 3 stacked PRs
- **Branch:** `fix/codex-1-dashboard-cross-tenant-scope` (PR A, in flight), then PR B (assistant tools), PR C (bank-feed + schema)
- **Note:** the `laws-of-ux-nav` claim below is stale (started 2026-07-16, work merged in #267/#11/#13); my page.tsx edits touch the scope/query layer, not its empty-state copy — no real overlap
- **Until:** all 3 PRs merged

### ~~Session: laws-of-ux-nav (Claude, 2026-07-16)~~ — stale per 2026-07-17 (work merged: #267 + tasks #11/#13)

- **Claiming:** `src/components/nav/sidebar.tsx`, empty-state/help copy in `src/app/**/page.tsx`
- **Why:** Laws-of-UX restructure — nav progressive disclosure + remove dev-facing copy
- **Branch:** `laws-of-ux-nav` (worktree; shared checkout untouched)
- **Until:** PR merged

---

## Recent completions

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
