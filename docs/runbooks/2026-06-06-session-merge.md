# Operator runbook — 2026-06-06 session merge

**Created:** 2026-06-06 · **Owner:** Chris · **Status:** Pending operator action

## What this runbook is for

The 2026-06-06 session produced **45 PRs across 5 repos** that need to be merged in a specific order to avoid integration regressions. This runbook gives the operator (you) step-by-step instructions to land them safely.

Total reading time: ~5 minutes. Total merge time: ~30 minutes at a steady pace, or break into 4 phases for comfortable interruption points.

## Headline state delta after this merge

| Metric | Pre-session | Post-session |
|---|---|---|
| **Critical-Open count** | 1 | **0** |
| Closed-state | 12 / 28 | 14 / 28 |
| Remediated-state | 1 | 3 |
| Readiness % | 80% | **85%** |
| Risk #1 score | 20 | 5 |
| Risk register Mitigated | 12 | 16 |
| PR #10 features extracted | 0/9 | 5/9 |
| Portfolio Sentry coverage | 4/5 | 5/5 |
| Audit trail defense layers | 1 | 3 |
| Re-audit pattern coverage | 0/5 | **5/5** portfolio |

## Pre-merge: 5-minute sanity check

```bash
cd /Users/hosungson/Code/ledger-core
git fetch --all --prune
gh pr list --state open --search "label:soc2 OR title:soc2 OR title:CLAUDE OR title:MERGE_ORDER OR title:PROJECT_STATUS OR title:deficiency OR title:readiness OR title:risk-register OR title:audit OR title:extract OR title:rls OR title:pinning" --limit 50
```

Should show ~37 open PRs in ledger-core (numbers #89 through #125, plus the earlier session PRs). Companion repos have 8 more (npm pinning × 4 + re-audit pattern × 4).

## Phase 1: PR #10 split engineering (5 PRs) — 5 minutes

These bring substantive SOC 2 hardening to `main`. Merge in order:

| Order | PR | What |
|---|---|---|
| 1 | [#99](https://github.com/ledger-nexus/ledger-core/pull/99) | CSP middleware + 9/9 tests — closes deficiency #2 (HIGH) |
| 2 | [#115](https://github.com/ledger-nexus/ledger-core/pull/115) | soc2 helper module + monitoring shim + 25 tests — completes 5/5 portfolio Sentry coverage |
| 3 | [#116](https://github.com/ledger-nexus/ledger-core/pull/116) | /api/health endpoint — CC7.1 anomaly detection. Stacked on #115. |
| 4 | [#120](https://github.com/ledger-nexus/ledger-core/pull/120) | audit-log append-only RULE + 15 test patches — CC4 + CC7.2. Stacked on #116. After merge: `prisma db execute --file prisma/sql/audit-log-append-only.sql` |
| 5 | [#123](https://github.com/ledger-nexus/ledger-core/pull/123) | /soc2-check slash command + pre-commit secrets scanner — CC4 + CC8 + CC6.7. After merge: `cp scripts/pre-commit-secrets-scan.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit` |

**Post-Phase-1 verification**: `npx tsc --noEmit` should be clean. The audit-log RULE smoke test (`npx vitest run tests/audit-log-append-only.test.ts`) should pass 3/3.

## Phase 2: Companion-repo npm pinning (4 PRs) — 5 minutes

| Repo | PR | Range count |
|---|---|---|
| recon | [#26](https://github.com/ledger-nexus/recon/pull/26) | 24 deps pinned |
| fa-amort | [#23](https://github.com/ledger-nexus/fa-amort/pull/23) | 22 deps pinned |
| revenue-rec | [#30](https://github.com/ledger-nexus/revenue-rec/pull/30) | 24 deps pinned |
| integrations | [#20](https://github.com/ledger-nexus/integrations/pull/20) | 22 deps pinned |

Independent — merge in any order. Each is a clean `package.json` + `package-lock.json` diff with no version churn.

## Phase 3: ledger-core engineering closures (5 PRs) — 5 minutes

These close deficiency #4 portfolio-wide at the ledger-core layer and capture the day's institutional record:

| Order | PR | What |
|---|---|---|
| 1 | [#95](https://github.com/ledger-nexus/ledger-core/pull/95) | ledger-core npm pinning (23 deps) — completes #4 portfolio closure (5/5) |
| 2 | [#84](https://github.com/ledger-nexus/ledger-core/pull/84) | RLS Phase 3 design + bypass-role runbook |
| 3 | [#85](https://github.com/ledger-nexus/ledger-core/pull/85) | RLS Phase 3 prereq B (entity scoping) |
| 4 | [#86](https://github.com/ledger-nexus/ledger-core/pull/86) | RLS Phase 3 prereq A (drop probes + 15th-pass HIGH fix) |
| 5 | [#88](https://github.com/ledger-nexus/ledger-core/pull/88) | Deficiency #28 closure (createFixedAsset tenant-scope) |

## Phase 4: Phase 3 RLS implementation (PR #89) — OPERATOR ACTION REQUIRED

**Gated on Decision C operator approval.** Do not merge this PR until you've reviewed and acknowledged the 5-item checklist in `docs/runbooks/rls-phase-3-bypass-roles.md`:

1. Operator confirms which read-only audit access paths need BYPASSRLS role
2. Operator provisions `revrec_audit_reader` Postgres role per migration SQL skeleton
3. Operator stores role credentials in Vercel env per secrets management policy
4. Operator schedules 90-day rotation for the role credentials per access-control.md
5. Operator acks the staged 3-stage rollout (dev → smoke-test → prod) per `docs/architecture/rls-phase-3-design.md`

Once Decision C is acked, [PR #89](https://github.com/ledger-nexus/ledger-core/pull/89) can merge. Post-merge: apply migration to dev first, run `RLS_FORCE_ENABLED=1 npx vitest run tests/rls-phase-3-cross-tenant.test.ts` for 6-category cross-tenant verification, smoke-test every page, then production cutover.

## Phase 5: Doc-pentagon stack (19 PRs) — 15 minutes

The doc-pentagon stack is **stacked**, not parallel — each version amendment builds on the prior version. Merge in order within each document:

**Deficiency log** (5 PRs):
```
PR #54  → PR #58 → PR #87 → PR #96 → PR #100 → PR #105 → PR #110
v2.1     v2.3     v2.5     v2.6     v2.7     v2.8     v2.9
```

**SOC2_READINESS** (5 PRs):
```
PR #49  → PR #55 → PR #59 → PR #91 → PR #97 → PR #101 → PR #106 → PR #111
v2.1     v2.2     v2.3     v2.5     v2.6     v2.7     v2.8     v2.9
```

**Risk register** (3 PRs):
```
PR #50 → PR #64 → PR #92 → PR #109 → PR #112
v2.1    v2.2    v2.3     v2.4      v2.5
```

**MERGE_ORDER** (6 PRs):
```
PR #51 → PR #56 → PR #60 → PR #94 → PR #98 → PR #102 → PR #107 → PR #113 → PR #117 → PR #121 → PR #124
v6      v7      v8      Group U   Group V   Group W   Group X   Group Y   Group Z   amended   amended
```
(Wait — this is just the MERGE_ORDER version trajectory. Each stacks on the prior. Final state: v14.)

**PROJECT_STATUS** (5 PRs):
```
PR #61 → PR #93 → PR #103 → PR #108 → PR #114 → PR #118 → PR #122 → PR #125
sprint   RLS arc  v1 cap    v2        v3        v4        v5        v6
```

If GitHub's "Update branch" button complains about merge conflicts, you can amend each PR's branch with `git rebase main` and force-push. The conflicts are usually just stale version-number lines and resolve cleanly.

## Phase 6: Institutional memory (5 PRs) — 5 minutes

CLAUDE.md amendments across the portfolio. All independent (off main per repo):

| Repo | PR | What |
|---|---|---|
| ledger-core | [#119](https://github.com/ledger-nexus/ledger-core/pull/119) | PR #10 splitting recipe + re-audit pattern |
| fa-amort | [#24](https://github.com/ledger-nexus/fa-amort/pull/24) | Re-audit pattern |
| recon | [#27](https://github.com/ledger-nexus/recon/pull/27) | Re-audit pattern |
| revenue-rec | [#31](https://github.com/ledger-nexus/revenue-rec/pull/31) | Re-audit pattern |
| integrations | [#21](https://github.com/ledger-nexus/integrations/pull/21) | Re-audit pattern |

## Final verification (post-merge)

```bash
cd /Users/hosungson/Code/ledger-core
git checkout main
git pull
npx tsc --noEmit                                        # Should be clean
npx vitest run tests/csp-nonce.test.ts                  # 9/9 pass
npx vitest run tests/audit-log-append-only.test.ts      # 3/3 pass (requires dev DB)
npx vitest run tests/soc2-helpers.test.ts               # 19/19 pass
npx vitest run tests/monitoring.test.ts                 # 6/6 pass
curl localhost:3000/api/health | jq                     # Returns valid JSON
```

After Phase 1-6 land, the portfolio's auditable state matches the doc-pentagon claims:
- 14/28 deficiencies Closed, 3/28 Remediated
- Critical-Open=0 (the session-defining milestone)
- 5/5 repos with monitoring shim, npm pinning, re-audit pattern in CLAUDE.md

## Reverting (if something breaks)

Each PR is small + independently revertible. To revert any:
```bash
gh pr edit <PR_NUMBER> --add-label "reverted"
git revert <merge_commit_sha>
git push
```

The doc-pentagon stack PRs are doc-only, so reverting them only affects the documentation versioning — no code impact. Engineering PRs (#95, #99, #115, #116, #120, #123) have tests + tsc checks; if a revert is needed, the test failure or tsc error tells you what regression to fix.

## What's NOT in this runbook

- **Operational items** (deficiencies #3 backup drill, #6 MFA, #7 access review, #8 vendor SOC 2 receipts, #10 training records) — these require your direct action outside the merge train (login to Vercel and enable MFA, etc.)
- **Customer #2 onboarding triggers** — Phase 2 audit log replication ships when triggered
- **Phase 3 RLS production cutover** — gated on Decision C ack + dev verification (Phase 4 above)

## Total time estimate

- Phase 1 (PR #10 splits): 5 min
- Phase 2 (companion npm): 5 min
- Phase 3 (ledger-core closures): 5 min
- Phase 4 (PR #89 — when ready): operator-paced
- Phase 5 (doc-pentagon stack): 15 min
- Phase 6 (institutional memory): 5 min
- **Total**: ~35 minutes of focused merge work + Phase 4 when Decision C is acked
