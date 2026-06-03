# Merge order — 2026-05-25 → 2026-06-03 SOC 2 hardening sprint

The sprint left **35 open PRs** across the 5-repo portfolio. This
file documents the dependency order so the founder can land them
efficiently when ready.

Most PRs are independent and can land in any order. The stacked
groups are explicitly called out below.

---

## TL;DR — if you only have 30 minutes

Merge these 5 to get the auditor-entry-point surface live on `main`:

1. **ledger-core PR #14** — portfolio data locations (the auditor's
   first read)
2. **ledger-core PR #22** — SOC2_READINESS v2.0 (`0 CRITICAL`)
3. **ledger-core PR #15** — risk register v2.0 (30 rows, reality-checked)
4. **ledger-core PR #20** — security policy v2.0 (CC1 umbrella TOC)
5. **ledger-core PR #32** — PROJECT_STATUS sprint capture

All 5 are doc-only, off `main`, independent. Each takes < 1 minute
to merge.

After those land, the public face of the SOC 2 framework is current
and an auditor can walk the directory from the top.

---

## Group A — Foundation (merge first; many depend on it)

| PR | Branch | Independent? | Notes |
|---|---|---|---|
| **#10** | `soc2-hardening-rollout` | off `main` | Helper module, env validator, CSP, audit-log RULE, Sentry shim, /soc2-check, pre-commit hook, soc2 skill, /api/health. **Multiple later PRs reference paths from this PR.** Merge first if possible. |

---

## Group B — Encryption stack (must merge sequentially)

A 4-PR stack. Each base-branches on the previous.

| Order | PR | Branch | Base |
|---|---|---|---|
| 1 | **#24** | `deterministic-encryption-design` | `main` |
| 2 | **#25** | `deterministic-encryption-phase-1` | `soc2-hardening-rollout` (PR #10) |
| 3 | **#26** | `deterministic-encryption-phase-2-user-email` | Phase 1 |
| 4 | **#27** | `deterministic-encryption-phase-3` | Phase 2 |

**Dependencies on this stack:**
- PR #12 (retention engine) was branched off Phase 3
- PR #13 (DSR) was branched off retention
- PR #14 (portfolio map) was branched off DSR

So if you want to merge #12-#14 without rebasing them onto `main`,
Group B should land first.

---

## Group C — Retention + DSR + portfolio map stack

| Order | PR | Branch | Base |
|---|---|---|---|
| 1 | **#12** | `automated-retention-engine` | Phase 3 |
| 2 | **#13** | `dsr-procedure` | Retention |
| 3 | **#14** | `portfolio-data-locations` | DSR |

If Group B is merged first, this stack rebases cleanly onto `main`
and merges in order.

If Group B is NOT merged yet, GitHub's "Update branch" button on
each PR will pull in main + the Group B branch state — works but
the PR diff inflates. Cleaner to land Group B first.

---

## Group D — Policy refresh (every doc at v2.0)

**These are all independent. Branch off `main`. Order doesn't matter.**

| PR | Doc | Criterion |
|---|---|---|
| #15 | `risk-register.md` v2.0 | CC3 |
| #16 | `change-management.md` v2.0 + bypass log | CC8 |
| #17 | `access-control.md` v2.0 | CC6.1-CC6.3 |
| #18 | `business-continuity.md` v2.0 | CC7 + Availability |
| #19 | `vendor-management.md` v2.0 | CC9 |
| #20 | `security.md` v2.0 | CC1 umbrella |
| #21 | `incident-response.md` v2.0 | CC7.3-CC7.4 |
| #30 | `control-deficiency-log.md` v2.0 | CC4 |

You can batch-merge all 8 with no rebase risk — none touch the same
file as any other.

---

## Group E — Auditor entry-point docs

**Branch off `main`. Cite specific PRs from Groups A-D in their text.**

These reference PR numbers from groups A-D. Cite-only references —
no rebase risk even if a referenced PR hasn't merged yet (the
references just become "will be PR #X when merged").

| PR | Doc | Cite source |
|---|---|---|
| #22 | `SOC2_READINESS.md` v2.0 | All groups |
| #23 | Operational evidence skeletons (5 dirs/templates) | Group D |
| #32 | `PROJECT_STATUS.md` sprint capture | All groups |

---

## Group F — Sweeps + runbooks

**Independent. Branch off `main`. Merge in any order.**

| PR | What |
|---|---|
| #28 | `scripts/verify-encryption-rollout.sh` post-deploy verifier |
| #29 | `docs/runbooks/incident-response.md` (operational pair to policy PR #21) |
| #31 | SECURITY.md sweep (resolved REPO placeholder + v2.0 framework reference) |
| #33 | `.well-known/security.txt` (RFC 9116) |
| #34 | Schema-fingerprint CI gate |
| #35 | SBOM generation workflow |

---

## Group G — Companion repo PRs (4 × DSR + 4 × SECURITY.md + 4 × security.txt + 1 × tsc fix)

Each companion repo has its own PR list. **All independent within
each repo.** Order doesn't matter.

| Repo | PRs |
|---|---|
| `integrations` | #11 DSR procedure + stub + tests · #12 SECURITY.md · #13 security.txt |
| `recon` | #11 DSR · #12 SECURITY.md · #13 security.txt · #14 tsc fix |
| `fa-amort` | #11 DSR · #12 SECURITY.md · #13 security.txt |
| `revenue-rec` | #11 DSR · #12 SECURITY.md · #13 security.txt |

---

## Suggested batched merge order

**Day 1 (foundation + encryption stack):**
1. PR #10 (foundation)
2. PR #24 → #25 → #26 → #27 (encryption stack, in order)

**Day 2 (retention + DSR + portfolio map, then sweeps):**
3. PR #12 → #13 → #14 (Group C, in order)
4. Sweep all Group D + Group F in parallel (any order)

**Day 3 (auditor entry-point):**
5. Group E (#22, #23, #32 — cite-fix them if needed once everything else lands)

**Day 4 (companion repos):**
6. All companion repo PRs (Group G) — none have inter-PR dependencies

This sequence keeps each day's review surface manageable + each
day's deploy risk bounded to one logical group of changes.

---

## What's NOT in any PR (open deficiencies)

See `docs/policies/control-deficiency-log.md` v2.0 (PR #30) for the
canonical list. Summary as of 2026-06-03:

- **Customer-trigger gated:** #3 backup restore drill, #12 RLS, #15
  signed DPAs (these are explicit "wait for the signal" rows, not
  unfinished work)
- **Cross-repo (marketing site):** #16 `/legal/subprocessors` page
  on `cpaura` or `revrecengine`
- **Operational:** #20 1Password emergency kit physical verification
- **Closes on PR #12 merge:** #14 retention cron lives only on a
  branch (will be live once Group C lands)

---

## Pre-merge sanity checklist

For each PR before clicking Merge:

- [ ] CI green (the schema-fingerprint gate in PR #34 will start
      catching schema drift once it merges; until then, runtime tests
      are the gate)
- [ ] Pre-commit hook ran clean (visible in the commit footer of
      every session commit)
- [ ] If a doc PR: verify the cited file paths still resolve on
      `main` (or the referenced PR has merged)
- [ ] If a code PR: verify the test suite still passes

---

## Annual review

This doc is sprint-specific and should be deleted after the sprint
merges complete. It is NOT a standing process artifact like the
policy directory.
