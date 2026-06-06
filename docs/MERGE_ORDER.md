# Merge order — 2026-05-25 → 2026-06-06 SOC 2 hardening sprint + continuation + NS sprints + RLS arc + pinning arc

**Updated 2026-06-06 (v8).** The sprint (2026-05-25 → 2026-06-03)
left 35 open PRs; the 2026-06-04 continuation arc added 15 more (50+ total);
the 2026-06-05 NS sprints + #26 closure + doc-triangle added **15 more**;
the evening **#25 closure + doc-triangle** added **4 more**; the late
evening **13th adversarial pass** added **2 more**; the **#13 portfolio-wide
sweep** added **2 more**; the late-evening **#18 verification close + new
#27 meta-deficiency** added **0 code PRs** (doc-only); the **#27 verification
automation** added **2 more** (PR #62 script + PR #63 URL backfill); the
**risk register v2.2** added **1 more**; the **even-later-evening Sentry shim
arc** added **4 more** (companion ports closing #5); the **14th adversarial
pass** added **4 more** (2nd commits on each shim PR); the **CLAUDE.md
institutional-memory arc** added **5 more** (one per repo); the **RLS arc**
(Group U) added **27 more** (Phases 1+2a+2b + Phase 3 design + Phase 3
prereqs + 15th adversarial pass + Phase 3 DRAFT + doc-pentagon institutional
record); the **2026-06-06 pinning arc** (Group V) added **7 more** (5
engineering PRs closing deficiency #4 portfolio-wide + 2 doc PRs amending
deficiency log + SOC2_READINESS to v2.6), for **125+ total** across the
5-repo portfolio. This file documents the dependency order so the
founder can land them efficiently when ready.

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

### TL;DR — evening capstone (8 more PRs, ~25 minutes)

The 2026-06-05 evening session closed deficiency #25 (fa-amort attribution), ran the 13th adversarial pass on BOTH same-day closure arcs, AND closed deficiency #13 portfolio-wide after discovering tasks #63 + #81 had been falsely marked complete. Merge the **8 PRs** in this order:

1. **fa-amort #25 closure arc** (Group O): fa-amort #18 → #19 (stack)
2. **13th adversarial-pass closures** (Group Q): fa-amort #20 (on top of #19) + revenue-rec #27 (on top of #25 — independent of Group O)
3. **#13 portfolio-wide sweep** (Group R): recon #23 + integrations #17 (both independent — can land in parallel with Groups O/Q)
4. **Doc-triangle 2026-06-05 evening v2.3** (Group P): **#58, #59** (after Groups O + Q + R land; doc PRs include footnote amendments from BOTH the 13th-pass closures AND the #13 portfolio-wide sweep)

After all merge: fa-amort attribution helper is 5/5 wired + revenue-rec helper is honest at 4/5 + 1 honest-zero; **both DSR attribution schema-gap items (#25 + #26) are Closed**; **#13 closed across all 5 repos** (`npx tsc --noEmit` clean portfolio-wide); readiness ticks 75% → 77%; **13th adversarial pass + #13 sweep both fully captured in CC4 monitoring evidence**.

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

## Group O — Deficiency #25 closure arc (2026-06-05 evening, 2 PRs on fa-amort)

Closes v2.2 control-deficiency-log entry **#25** (fa-amort attribution schema gap). Mirrors Group M's playbook for #26. **Merge in stack order.**

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| (a) | fa-amort **#18** | `attribution-schema` | `main` | Adds `createdBy`/`disposedBy` to `FixedAsset` + `lastRunBy`/`lastRunAt` to `FixedAssetBookAttributes` + `acceptedBy/At`/`rejectedBy/At` to `AiAssetSuggestion`. Closes the `FixedAsset.tenantId` Prisma-mirror gap (parallel to revenue-rec #21). Wires `runDepreciationAction` to stamp `lastRunBy`/`lastRunAt` post-success. Idempotent migration `2026-06-05-attribution-schema.sql`. +6 tests vs real Postgres. |
| (b) | fa-amort **#19** | `fa-attribution-wireup` | `attribution-schema` | `fa-attribution.ts` flips from honest-zero → **5/5 wired**. 5 `COUNT(*)` queries in parallel against the new columns. +3 integration tests against real Postgres + rewritten stub tests (74/74 total). |

After both merge: `faAmortAttribution` returns real counts for all 5 fields; v2.3 deficiency log (PR #58) marks #25 Closed. Both DSR attribution schema-gap items (#25 + #26) Closed across the portfolio.

---

## Group P — Doc-triangle evening catch-up (2026-06-05 evening, 2 PRs)

Captures the evening 2026-06-05 closure in the canonical SOC 2 evidence chain. Both independent doc-only PRs; **merge after Group N + Group O + Group Q lands** (the v2.3 docs were amended after the 13th-pass closures landed).

| PR | Doc | Cite source |
|---|---|---|
| **#58** | `control-deficiency-log.md` v2.2 → v2.3 — closes #25; closed-state goes 10 → 11 (amended with H2-rev footnote on #26) | Group O + Group Q |
| **#59** | `SOC2_READINESS.md` v2.2 → v2.3 — Delta — 2026-06-05 evening section; readiness 75% → 76% (amended with H2-rev footnote on revenue-rec row) | Group O + Group Q + PR #58 |

---

## Group S — Sentry shim portfolio-wide (2026-06-05 even-later evening, 4 PRs)

Closes deficiency **#5** (No Sentry / no error tracking) at the code layer across all 4 companion repos. After all 4 PRs merge + the paid DSN gets provisioned (operational, not code), the v2.3 deficiency-log row flips Remediated → Closed.

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| (a) | fa-amort **#21** | `monitoring-shim` | `main` | Ports the canonical ledger-core PR #10 shim. PII allowlist focused on asset descriptions + AI extraction surfaces. 14 dedicated tests. |
| (b) | recon **#24** | `monitoring-shim` | `main` | Ports the shim. PII allowlist focused on bank fields (accountNumber, bankName, description, rawPayload). 14 dedicated tests. |
| (c) | revenue-rec **#28** | `monitoring-shim` | `main` | Ports the shim. PII allowlist focused on `rawText` (load-bearing carve-out per data-classification.md), counterpartyName, signatories. 14 dedicated tests. |
| (d) | integrations **#18** | `monitoring-shim` | `main` | **Highest-stakes port** — `credentialsJson` + `accessToken` + `publicToken` + `rawRecord` allowlist. A leaked OAuth token here is a Critical incident. 14 dedicated tests pin `"plk-secret-abcdef-12345"` cannot reach console. |

All 4 PRs are independent (each based on its repo's `main`). Can merge in any order.

After all 4 merge: `captureError()` + `captureMessage()` exist in every companion repo with PII redaction running before every emit, console fallback when DSN absent. This is the **first Medium-severity deficiency closed by genuine new code this session.**

**14th adversarial pass closure (2nd commits on each Group S PR):** Pass found 1 HIGH (Error.stack PII leak via V8 preamble) + 3 MEDIUMs (err.code cap + revenue-rec + integrations allowlist gaps). All 4 closed in-session via 2nd commits on each of the 4 shim PRs. Tests delta: +28 (each PR went 14 → 21 tests). New helpers `stripStackPreamble()` + `sanitizeErrorForCapture()`. The shim arc is now mechanically defended at every layer: `.message`, `.stack`, `.code`, `extra`.

---

## Group T — CLAUDE.md institutional-memory arc (2026-06-05 night, 5 PRs)

Adds monitoring-shim non-negotiable + SOC 2 adversarial-pass cadence section to each repo's CLAUDE.md. Every future Claude Code session in each repo auto-loads the patterns shipped this evening. **Closes the falsely-completed-task class from a different angle than PR #62 — PR #62 catches drift at workflow-runtime; this arc delivers institutional memory at session-start.**

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| (a) | fa-amort **#22** | `claude-md-monitoring-disc` | `main` | Non-negotiable #9 (monitoring shim canonical) + SOC 2 adversarial-pass cadence with 13th-pass silent-catch + 14th-pass stack-leak citations |
| (b) | recon **#25** | `claude-md-monitoring-disc` | `main` | Non-negotiable #5 + BankStatementLine.description load-bearing column framing |
| (c) | revenue-rec **#29** | `claude-md-monitoring-disc` | `main` | Non-negotiable #5 + ContractDocument.rawText carve-out + 13th-pass H2-rev + 14th-pass M3 gap-fills |
| (d) | integrations **#19** | `claude-md-monitoring-disc` | `main` | Non-negotiable #6 + OAuth-token-leak Critical incident framing + 14th-pass M4 vendor-identifier gaps |
| (e) | ledger-core **#65** | `claude-md-monitoring-disc` | `main` | Non-negotiable #5 (substrate-tier) + portfolio-wide adversarial-pass finds (12th + 13th + 14th) + pointer to docs/policies/control-deficiency-log.md v2.3 + docs/SOC2_READINESS.md v2.3 |

All 5 PRs are independent — each branches off its repo's `main`, can merge in any order. After all 5 merge, every Claude Code session in every repo of the portfolio auto-loads the same patterns.

This is the final closure mechanism for the falsely-completed-task class. PR #62 + #63 + Group T together:
- **PR #62** — verification automation (workflow-runtime drift detection)
- **PR #63** — URL backfill (makes the verifier a real hard gate, not informational-only)
- **Group T** — institutional memory at session-start (auto-load + session inherits patterns without re-discovery)

---

## Group R — #13 portfolio-wide sweep (2026-06-05 late evening, 2 PRs)

Closes deficiency **#13** (TS18049 in middleware mock tests) across the 2 remaining companion repos. The fa-amort + revenue-rec halves were bonus cleanup inside Group O (fa-amort #18) and Group Q (revenue-rec #27). These 2 close the recon + integrations halves.

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| (a) | recon **#23** | `tsc-middleware-test-13` | `main` | 5-line `expect(res!.status)` non-null assertion fix. tsc clean after. |
| (b) | integrations **#17** | `tsc-middleware-test-13` | `main` | Same 5-line fix. tsc clean after. |

After both merge: `npx tsc --noEmit` clean across all 5 repos for the first time. Deficiency #13 fully Closed; closed-state count 11 → 12. **Independent of all other groups** — can merge in any order vs. Groups K-Q.

**CC4 process learning embedded in the closure narrative:** tasks #63 + #81 had been marked completed in the ledger-core task log but never actually landed on `main` in any repo. Going forward, task completion requires merged-to-main verification, not just local "done." Captured in the v2.3 deficiency-log change log (PR #58 third commit).

---

## Group U — RLS arc, deficiency #12 closure (2026-06-05 night, 27 PRs)

The full closure of deficiency #12 (no Postgres RLS — application-layer scoping was the only enforcement). **The most architecturally significant arc this session.** Splits into 5 sub-groups by phase.

### Group U.1 — Phase 1 + Phase 2a foundation (2 PRs, sequential)

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| 1 | **#66** | `rls-phase-1-policies` | `main` | 39 per-table RLS policies + `app_current_tenant_id()` SQL function. **Advisory only** until Phase 3 FORCE. |
| 2 | **#67** | `rls-phase-2-tenant-context` | #66 | `withTenantContext` helper — opens `prisma.$transaction` + parameterized `set_config('app.current_tenant_id', tenantId, true)`. Injection-safe (parameterized, not template-string). |

### Group U.2 — Phase 2b sweep (14 PRs, mostly independent — 7-shape catalog institutionalized)

The full migration of 23 Server Actions + 3 HTTP routes + 1 batch helper to `withTenantContext`. Each PR is a small, reviewable sweep over one shape from the catalog. **All branch off `#67` (Phase 2a).** Order within Group U.2 doesn't matter.

| Shape | Reference PR | What |
|---|---|---|
| **W1** (pure widening) | #69 (migration guide) + #70 (mark-notifications-read) | Helper takes a `Db` (PrismaClient \| TransactionClient) param; caller wraps in `withTenantContext`. |
| **W2** (helper already tx-aware) | (subsumed into W1 in mid-sweep) | Helper already accepts `Db`; only Server Action wraps. |
| **T1** (Class T single-helper split) | #71 (applyApPayment inner/outer split) | Helper opens internal `$transaction`; split into `innerInTx` (takes `TransactionClient`) + outer (opens tx, delegates). |
| **T2** (Class T multi-step) | #73, #74 (period-close, reassign) | Multi-step action with multiple early exits → outcome-variant tagged-union return pattern. |
| **E** (tenant-id-from-entity-lookup) | #75, #76 (entity-by-code resolves tenant first) | Entity lookup determines `tenantId`; `withTenantContext` opens *after* the lookup. |
| **M** (multi-tenant batch) | #79 (close-all-open-periods) | Action iterates tenants → calls `withTenantContext` per-tenant in the loop. |
| **P** (per-iteration batch helper) | #82 (`withTenantContextOptions` forwarder) | Long-running batch needs `maxWait`/`timeout`/`isolationLevel`; helper extended to forward options to `prisma.$transaction(fn, opts)`. |

Full sweep manifest (14 PRs): #69-#83 (per-shape sweeps + migration-guide amendments). See `docs/architecture/rls-phase-2b-migration-guide.md` for the canonical 7-shape catalog with reference PRs.

### Group U.3 — Phase 3 design + prereqs (3 PRs, mostly sequential)

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| 1 | **#84** | `rls-phase-3-design` | `main` | `docs/architecture/rls-phase-3-design.md` + `docs/runbooks/rls-phase-3-bypass-roles.md`. Resolves Decisions A (drop probes) + B (entity scoping) + D (crons) with recommendations. Leaves C (bypass roles) as operator coordination. |
| 2 | **#85** | `rls-phase-3-prereq-b-entity-scoping` | #84 | Decision B implementation: `period-close.ts` close + reopen actions scope `entity.findFirst({ code, tenantId })`. Embedded **15th-pass M2** (uncaught `NoTenantSelectedError`/`NoTenantMembershipError`) + **15th-pass M3** (multi-tenant-admin contract regression documented inline). |
| 3 | **#86** | `rls-phase-3-prereq-a-drop-probes` | #84 | Decision A implementation: `journal-entries/route.ts` + `fixed-asset/route.ts` drop cross-tenant probes; replaced with `auditTokenUse({success: false, reason: "Unknown entity (code does not exist in token's tenant)"})`. Embedded **15th-pass HIGH** (audit-bypass fix). |

### Group U.4 — Phase 3 implementation DRAFT (1 PR, gated)

| PR | Branch | Base | What | Gating |
|---|---|---|---|---|
| **#89** | `rls-phase-3-force-implementation` | #67 (Phase 2a) | `prisma/migrations/0008_rls_phase_3_force/migration.sql` — 37 ALTER TABLE FORCE statements (30 direct-tenantId tables + 7 child tables) + `tests/rls-phase-3-cross-tenant.test.ts` 6-category suite env-gated via `RLS_FORCE_ENABLED=1`. | **DRAFT.** Gated on (1) Phase 2b PRs merged, (2) Phase 3 prereqs (#85, #86) merged, (3) **operator ack on Decision C 5-item runbook checklist** (`docs/runbooks/rls-phase-3-bypass-roles.md`), (4) dev migration green, (5) production cutover per 3-stage rollout. |

### Group U.5 — Historical deficiency closure + doc-pentagon (5 PRs, mostly doc-only)

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| 1 | **#88** | `deficiency-28-fixed-asset-tenant-scope` | `main` | **15th-pass historical finding:** `createFixedAsset` `legalEntity.findFirstOrThrow({ where: { code } })` was tenant-blind. Added required `tenantId: string` to `CreateFixedAssetInput` + scoped lookup to `{ code, tenantId }`. 7 test sites updated. Closes new deficiency #28. |
| 2 | **#87** | `deficiency-log-v25-rls-arc` | `main` | `docs/policies/control-deficiency-log.md` v2.4 → v2.5 — #12 Remediated (full RLS-arc closure narrative across PRs #66-#86) + #28 Closed (PR #88). |
| 3 | **#90** | `claude-md-rls-arc-institutionalization` | `main` | `CLAUDE.md` — new "SOC 2 / RLS — multi-tenant query enforcement" subsection: 5-step migration recipe + 7-shape catalog + audit-emit-outside-tx rule + cross-tenant probe rule + scope-entity-by-code rule + adversarial-pass cadence prescription. |
| 4 | **#91** | `soc2-readiness-v25-rls-arc` | `main` | `docs/SOC2_READINESS.md` v2.4 → v2.5 — CC6.1 / CC7.4 posture upgrade narrative. |
| 5 | **#92** | `risk-register-v23-rls-arc` | `main` | `docs/policies/risk-register.md` v2.2 → v2.3 — Risk #17 (multi-tenant data leakage) Future → Mitigated (1×5=5, down from latent 4×5=20). New Risk #21 (Phase 3 FORCE flip data-disappearance) captured at 2×4=8 with mitigations. |
| 6 | **#93** | `project-status-rls-arc-capstone` | `main` | `PROJECT_STATUS.md` capstone for the RLS arc — completes the doc-pentagon (deficiency log + CLAUDE.md + SOC2_READINESS + risk register + PROJECT_STATUS). |

All 6 PRs in Group U.5 are **independent** doc-only (except #88 which is the historical-finding code PR) — each branches off its repo's `main`, can merge in any order.

### Group U merge sequence (suggested)

1. **U.1**: #66 → #67 (sequential foundation)
2. **U.2**: all 14 Phase 2b PRs in parallel after #67 lands
3. **U.3**: #84 → (#85 + #86 in parallel) after #67 + Phase 2b
4. **U.5**: #88 first (code), then doc-pentagon (#87, #90, #91, #92, #93) in any order
5. **U.4**: #89 LAST — gated on operator Decision C ack + all upstream PRs landed

After all 27 merge: deficiency #12 closed at the application layer (Phases 1+2a+2b) AND the database layer (Phase 3 FORCE). Multi-tenant isolation posture upgrades from "application-layer scoping is the only enforcement" to "application + DB-layer (load-bearing post-FORCE) + per-PR adversarial-pass cadence as CC4 monitoring evidence."

---

## Group V — npm pinning portfolio-wide, deficiency #4 closure (2026-06-06, 7 PRs)

Closes deficiency **#4** (HIGH severity, opened 2026-05-25) — npm deps not pinned to exact versions. Mirrors the Sentry-shim arc's playbook (Group S): one engineering PR per repo (5 total) + doc-pentagon amendments (2 total).

### Group V.1 — Engineering sweep (5 PRs, all independent)

Each PR strips `^`/`~` to the exact version currently in that repo's `package-lock.json`. No upgrades introduced. Each branches off its repo's `main` — order doesn't matter.

| Repo | PR | Deps pinned | Verification |
|---|---|---|---|
| ledger-core | **#95** | 23 | `grep -cE '"[~^]' package.json` = 0; `npx tsc --noEmit` clean |
| recon | **#26** | 24 | `grep -cE '"[~^]' package.json` = 0; lockfile clean |
| fa-amort | **#23** | 22 | `grep -cE '"[~^]' package.json` = 0; lockfile clean |
| revenue-rec | **#30** | 24 | `grep -cE '"[~^]' package.json` = 0; lockfile clean |
| integrations | **#20** | 22 | `grep -cE '"[~^]' package.json` = 0; lockfile clean |
| **Total** | **5 PRs** | **115 ranges** | |

### Group V.2 — Doc-pentagon amendments (2 PRs, stacked)

| Order | PR | Doc | Cite source | Base |
|---|---|---|---|---|
| 1 | **#96** | `control-deficiency-log.md` v2.5 → v2.6 | Group V.1 (5 PRs) | `deficiency-log-2026-06-05-v24` (PR #87) |
| 2 | **#97** | `SOC2_READINESS.md` v2.5 → v2.6 — readiness 80% → 81% | PR #96 + Group V.1 | `soc2-readiness-rls-arc-update` (PR #91) |

### Group V merge sequence (suggested)

1. **V.1**: all 5 engineering PRs in parallel (no inter-PR deps)
2. **V.2**: #96 first (deficiency log), then #97 (readiness) after Group V.1 lands + PR #87/#91 land

After all 7 merge: CC7.1 (vulnerability management) supply-chain control upgrades from "range + Dependabot review" to **"pinning + Dependabot review + npm audit CI"**. Silent-transitive-upgrade attack vector eliminated on every `npm ci` deploy. Closed-state count: 12 → 13 of 28 tracked.

**Note:** PR #95 (ledger-core engineering) caught a pre-existing deficiency #13 finding — TS18049 errors in `tests/middleware-fail-closed.test.ts` on `main` for recon (Group R closure PRs not yet merged). The pinning sweep is **orthogonal** to that gap; tsc errors are unchanged by version-string changes.

---

## Group Q — 13th adversarial-pass closures (2026-06-05 late evening, 2 PRs)

Cross-repo 13th adversarial pass run on both same-day closure arcs (fa-amort Group O + revenue-rec Groups K+M). Findings: 2 HIGHs (fa-amort silent `catch {}` CC7.3 + revenue-rec unbacked audit_log delegation claim) + 4 MEDIUMs + several LOWs. All closed in-session.

| Order | PR | Branch | Base | What |
|---|---|---|---|---|
| (a) | fa-amort **#20** | `attribution-13th-pass-fixes` | `fa-attribution-wireup` | Closes H1 silent catch (now emits structured `console.error`) + adds null-userId guard + adds tenant-scope DSR-semantics doc + strict-equality test + race comment. +5 tests (74 → 79 vitest). |
| (b) | revenue-rec **#27** | `rr-attribution-13th-pass-fixes` | `rr-attribution-full-wire` | Closes H2-rev (unbacked audit_log delegation claim — replaced with honest "schema gap not yet closed" framing) + adds null-userId guard + adds tx-bound rollback intent comment + tsc TS18049 fix (task #81's tail). +4 tests (55 → 59 vitest). |

After both merge: the closure arc is **MORE rigorous** than before — the helpers now return truthful counts (not overclaimed coverage), null-userId guards close the silent-inflation class, and CC7.3 monitoring evidence is captured for the silent-catch class. PRs #58 + #59 are amended to footnote the revenue-rec helper-coverage state change (4/5 + 1 audit_log → 4/5 + 1 honest-zero).

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
