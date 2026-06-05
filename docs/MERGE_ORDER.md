# Merge order — 2026-05-25 → 2026-06-05 SOC 2 hardening sprint + continuation + NS sprints

**Updated 2026-06-05.** The sprint (2026-05-25 → 2026-06-03) left 35
open PRs; the 2026-06-04 continuation arc added 15 more (50+ total);
the 2026-06-05 NS sprints + #26 closure + doc-triangle added **15 more**,
for **65+ total** across the 5-repo portfolio. This file documents
the dependency order so the founder can land them efficiently when
ready.

Most PRs are independent and can land in any order. The stacked
groups are explicitly called out below.

---

## TL;DR — if you only have 30 minutes

Merge these 5 to get the auditor-entry-point surface live on `main`:

1. **ledger-core PR #14** — portfolio data locations (the auditor's
   first read)
2. **ledger-core PR #22** — SOC2_READINESS v2.0 → then **#49** for v2.1 delta (`≈75%`)
3. **ledger-core PR #15** — risk register v2.0 → then **#50** for v2.1 delta
4. **ledger-core PR #20** — security policy v2.0 (CC1 umbrella TOC)
5. **ledger-core PR #32** — PROJECT_STATUS sprint capture

All 5 are doc-only, off `main`, independent. Each takes < 1 minute
to merge. The v2.1 delta PRs (#49, #50, plus deficiency-log **#48**)
should land after their v2.0 bases on the same branch.

After those land, the public face of the SOC 2 framework is current
and an auditor can walk the directory from the top.

### TL;DR — if you have an additional 30 minutes (the DSR end-to-end loop)

The 2026-06-04 continuation arc closes the Privacy TSC commitment.
Merge the **10 DSR-loop PRs** in this order:

1. **4 producer helpers** (Group I.1): integrations #14, recon #15, fa-amort #15, revenue-rec #14
2. **ledger-core consumer**: PR #46 (Group I.2)
3. **4 HTTP endpoints** (Group I.3): integrations #15, recon #16, fa-amort #16, revenue-rec #15
4. **e2e smoke + runbook**: PR #47 (Group I.4)

Then the three docs PRs (Group J: **#48, #49, #50**) to reflect closure
in the SOC 2 evidence chain.

### TL;DR — if you have another 30 minutes (the substantive engineering arcs)

The 2026-06-05 work landed two full NetSuite ingestion flows + closed deficiency #26 end-to-end. Merge the **15 PRs** in this order:

1. **revenue-rec NS sprint** (Group K): revenue-rec #17 → #18 → #19 → #21 → #22 → #23 (stack). revenue-rec #20 is independent — can interleave.
2. **recon NS sprint** (Group L): recon #17 → #18 → #19 → #20 → #21 (stack)
3. **Deficiency #26 closure remainder** (Group M.b, M.c): revenue-rec #24 → #25 (after Group K's #21 lands)
4. **Doc-triangle 2026-06-05** (Group N): **#53, #54, #55** to reflect closure in the SOC 2 evidence chain

After all merge: the substrate accepts NetSuite data for revenue arrangements + bank reconciliation, with cross-repo lineage triple architecturally proven against real Postgres; revenue-rec attribution helper is 4/5 wired + 1 documented audit_log delegation.

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

## Group H — Validator → shipping trilogy (2026-06-04 continuation, ledger-core PRs #39-#45)

Shipped 2026-06-04 morning. Validator outputs across 4 domains + downstream shipping of the GL-substrate + fa-amort findings.

| PR | What | Base | Notes |
|---|---|---|---|
| **#39** | revenue-rec NetSuite validation — `PerformanceObligation` schema additions (allocatedAmount + fairValueMethod + quantity) captured as a sequenced backlog | `main` | Doc PR — sequenced backlog only; no code shipped |
| **#40** | fa-amort NetSuite validation — 87/90 Fleet sample assets translatable; 3 method gaps documented | `main` | Doc PR — downstream shipping is **fa-amort PR #14** |
| **#41** | GL substrate NetSuite validation — bootstrap layer was the missing piece | `main` | Doc PR — downstream is ledger-core PRs #43-#45 |
| **#42** | recon NetSuite validation — denormalized → normalized ReconciliationMatch captured as backlog | `main` | Doc PR — model-translation work deferred |

### Group H stack — ledger-core bootstrap shipping (depends on Group H above)

| PR | Branch | Base |
|---|---|---|
| **#43** | `netsuite-bootstrap-mapper` — types/mappers/orchestrators for Subsidiary → LegalEntity, AccountingBook → Book, AccountingPeriod → Period (~530 lines) | `main` |
| **#44** | `netsuite-bootstrap-wire-into-importFromNs` — composition helper `importFromNsWithBootstrap()` (~170 lines) | #43 |
| **#45** | `netsuite-bootstrap-integration-test` — 11 tests vs real Neon | #44 |

Merge in order #43 → #44 → #45.

---

## Group I — DSR companion-attribution arc (2026-06-04 continuation, 10 PRs)

The Privacy TSC procedure (Group C, PR #13) committed to companion-attribution counts in DSR exports. Today shipped the entire wire-up: producer helpers → consumer → HTTP endpoints → e2e smoke + runbook.

### Group I.1 — Producer helpers (4 companion repos)
**All independent. Branch off each repo's `dsr-procedure` branch (PR #11).** Order doesn't matter within this row.

| Repo | PR | Branch | Wiring |
|---|---|---|---|
| `integrations` | #14 | `connections-export-wired` | Full wire — `Connection.createdBy` |
| `recon` | #15 | `recon-attribution-wired` | Full wire — `BankStatement.uploadedBy` + `ReconciliationMatch.approved/rejectedBy` |
| `fa-amort` | #15 | `fa-attribution-wired` | Honest-zero — schema gap delegated to ledger-core audit_log |
| `revenue-rec` | #14 | `rr-attribution-wired` | Hybrid 2/5 — `ContractDocument.uploadedBy` + `RecognitionEvent.postedBy` |

### Group I.2 — Consumer in ledger-core
**Depends on Group I.1 being merged (cite references).**

| PR | Branch | Base |
|---|---|---|
| **#46** | `companion-attribution-wire` | `dsr-procedure` |

### Group I.3 — HTTP endpoints (4 companion repos)
**Each stacks on its repo's Group I.1 branch.** Order: within each repo, I.1 → I.3.

| Repo | PR | Base | What |
|---|---|---|---|
| `integrations` | #15 | `connections-export-wired` (I.1) | `POST /api/internal/dsr/attribution` |
| `recon` | #16 | `recon-attribution-wired` (I.1) | Same endpoint |
| `fa-amort` | #16 | `fa-attribution-wired` (I.1) | Same endpoint |
| `revenue-rec` | #15 | `rr-attribution-wired` (I.1) | Same endpoint |

### Group I.4 — E2E verification (ledger-core)
**Stacked on Group I.2.**

| PR | Branch | Base |
|---|---|---|
| **#47** | `dsr-e2e-smoke` | `companion-attribution-wire` (I.2) |

Includes `docs/runbooks/dsr-e2e-test.md` operator guide.

---

## Group J — Doc-triangle catch-up (2026-06-04 continuation, 3 PRs)

Captures today's work in the canonical SOC 2 evidence chain. All independent doc-only PRs; merge in any order; **prefer late in the day** so PR citations are stable.

| PR | Doc | Cite source |
|---|---|---|
| **#48** | `control-deficiency-log.md` v2.0 → v2.1 — closes #17/#19/#21 + adds DSR arc #24 + new low-severity #25/#26 | All groups |
| **#49** | `SOC2_READINESS.md` v2.0 → v2.1 — readiness 70 → 75%; Delta section + CC2/CC4/CC8/CC9 row updates | PR #48 + Group H + Group I |
| **#50** | `risk-register.md` v2.0 → v2.1 — #16 end-to-end + #26 partial close + new #31 token rotation | PR #48 + Group I |

---

## Group K — revenue-rec NetSuite revenue-arrangement sprint (2026-06-05, 7 PRs end-to-end)

Shipped 2026-06-05 as a 5-layer end-to-end sprint per the validator backlog (ledger-core PR #39). **Merge in stack order** — each PR base-branches on the previous.

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| 1 | revenue-rec **#17** | `po-schema-additions` | `main` | ASC 606 ¶77+¶78 schema: `allocatedAmount` + `allocationMethod` + `fairValueMethod` + `quantity` on `PerformanceObligation` |
| 2 | revenue-rec **#18** | `netsuite-mapper-foundation` | #17 | Types + pure mappers + 22 unit tests |
| 3 | revenue-rec **#19** | `netsuite-mapper-import` | #18 | Orchestrator + 10 mocked-Prisma tests |
| 4 | revenue-rec **#20** | `schedule-usage-milestone-accept` | `main` | `schedule.ts` accepts USAGE + MILESTONE (independent of the stack; can merge first) |
| 5 | revenue-rec **#21** | `schema-mirror-tenantid` | #19 | `RevenueContract.tenantId` + `Party.tenantId` schema-mirror + 3 integration tests vs real Postgres |
| 6 | revenue-rec **#22** | `ns-revenue-server-action` | #21 | Server Action wrapper + 11 unit tests |
| 7 | revenue-rec **#23** | `ns-import-ui` | #22 | UI page at `/import/netsuite` + sidebar link |

**Sprint output:** ~3000 lines, +54 tests (42 → 96), cross-repo lineage triple architecturally proven.

---

## Group L — recon NetSuite bank-reconciliation sprint (2026-06-05, 5 PRs end-to-end)

Shipped 2026-06-05 as a 5-layer end-to-end sprint per the validator backlog (ledger-core PR #42). **Merge in stack order.**

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| 1 | recon **#17** | `netsuite-mapper-foundation` | `main` | Types + pure mappers + 19 unit tests. **Load-bearing translation rule** — NS denormalized `matched_transaction_id` → recon `ReconciliationMatch { source: MANUAL, status: APPROVED }` |
| 2 | recon **#18** | `netsuite-mapper-import` | #17 | Orchestrator + 10 mocked-Prisma tests. **Cross-repo lineage-triple lookup** that resolves `matched_transaction_id` → ledger-core `JournalLine.id` |
| 3 | recon **#19** | `netsuite-mapper-integration` | #18 | 4 integration tests vs real Postgres proving the lineage-triple lookup completes end-to-end |
| 4 | recon **#20** | `ns-recon-server-action` | #19 | Server Action with `prefer BANK-subtype line` heuristic + 11 unit tests |
| 5 | recon **#21** | `ns-import-ui` | #20 | UI page at `/import/netsuite` with distinctive 8-stat grid (incl. `Matches deferred`) |

**Sprint output:** ~2000 lines, +44 tests (47 → 91), graceful-degradation path proven (line lands when GL doc not yet imported; recoverable later).

---

## Group M — Deficiency #26 closure arc (2026-06-05, 3 PRs)

Closes v2.1 control-deficiency-log entry #26 (revenue-rec attribution schema gap). **Merge in stack order; (a) overlaps with Group K's #21.**

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| (a) | revenue-rec **#21** | `schema-mirror-tenantid` | `netsuite-mapper-import` | (same row as Group K #5 — listed here for the closure narrative) |
| (b) | revenue-rec **#24** | `ai-extraction-decision-schema` | `main` | `acceptedBy`/`rejectedBy` columns on `AiExtractionSuggestion` + `approveExtractionAction` wired (tenant-safe via `updateMany({id, contractId})`) + 4 integration tests |
| (c) | revenue-rec **#25** | `rr-attribution-full-wire` | #24 | `rr-attribution.ts` flips from hybrid (2/5) → full-wire (4/5 wired + 1 documented audit_log delegation) |

After all three merge: `revenueRecAttribution` returns real counts for 4 of 5 fields; v2.2 deficiency log marks #26 Closed.

---

## Group N — Doc-triangle catch-up (2026-06-05 continuation, 3 PRs)

Captures 2026-06-05 closures in the canonical SOC 2 evidence chain. All independent doc-only PRs; merge in any order; **prefer late in the day**.

| PR | Doc | Cite source |
|---|---|---|
| **#53** | `PROJECT_STATUS.md` — captures both NS sprints + #26 closure arc; cumulative PRs 63+ → 76+ | Groups K + L + M |
| **#54** | `control-deficiency-log.md` v2.1 → v2.2 — closes #26 (+11% closed-state) | Group M + PR #25 |
| **#55** | `SOC2_READINESS.md` v2.1 → v2.2 — Delta — 2026-06-05 section; readiness stays 75% (explicitly justified) | PR #54 + Groups K + L |

---

## Suggested batched merge order

**Day 1 (foundation + encryption stack):**
1. PR #10 (foundation)
2. PR #24 → #25 → #26 → #27 (encryption stack, in order)

**Day 2 (retention + DSR + portfolio map, then sweeps):**
3. PR #12 → #13 → #14 (Group C, in order)
4. Sweep all Group D + Group F in parallel (any order)

**Day 3 (auditor entry-point + bootstrap):**
5. Group E (#22, #23, #32 — cite-fix once everything else lands)
6. Group H bootstrap: PR #43 → #44 → #45 in order

**Day 4 (companion repos + DSR producer helpers):**
7. All companion repo PRs from Group G (no inter-PR deps within each)
8. Group I.1 — 4 companion-repo attribution helpers (independent — can batch)

**Day 5 (DSR consumer + endpoints + verification):**
9. Group I.2 — ledger-core PR #46 (consumer)
10. Group I.3 — 4 companion-repo HTTP endpoints (each stacked on its I.1 base)
11. Group I.4 — ledger-core PR #47 (e2e smoke + runbook)
12. Group J — three doc-triangle catch-up PRs (#48, #49, #50)

**Day 6 (revenue-rec NS sprint):**
13. Group K — revenue-rec PRs #17 → #18 → #19 → #21 → #22 → #23 (stack order)
14. revenue-rec PR #20 (`schedule.ts` USAGE+MILESTONE) — independent; can merge any time

**Day 7 (recon NS sprint + deficiency #26 closure):**
15. Group L — recon PRs #17 → #18 → #19 → #20 → #21 (stack order)
16. Group M.b — revenue-rec PR #24 (decision schema)
17. Group M.c — revenue-rec PR #25 (helper full-wire)
18. Group N — three doc-triangle catch-up PRs (#53, #54, #55)

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
