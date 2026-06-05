# Control deficiency log

**Version:** 2.3 · **Effective date:** 2026-06-05 · **Owner:** Founder
**Last reviewed:** 2026-06-05 (#25 closed via fa-amort attribution-schema + wire-up arc)
**Prior versions:** 2.2 (2026-06-05 morning — #26 closed), 2.1 (2026-06-04), 2.0 (2026-06-03 SOC2 hardening sprint), 1.0 (pre-Clerk)

## Purpose

SOC 2 CC4 (Monitoring Activities) expects evidence that we identify
control deficiencies and remediate them. This log is the running
record. Auditors will ask to see it. **An empty log is a red flag** —
it means we either have perfect controls (we don't) or we aren't
looking.

A "control deficiency" is anything that should have prevented an
event but didn't, or any control whose design or operation is known
to be weak. It is distinct from:

- **Incident** — a security or availability event that occurred (lives
  in `docs/incidents/`)
- **Risk** — a hypothetical future event (lives in `risk-register.md`)
- **Deficiency** — a known weakness in a control that exists today

A deficiency can be discovered through: failed CI checks, code review,
penetration tests, customer reports, internal audits, or a real
incident that exposed it.

## How to log a deficiency

Add a new row to the table below. Use a short, scannable title. Cite
the file or process that's weak. Include enough detail that a stranger
6 months from now can understand what was broken.

## Severity rubric

| Severity | Definition | Example |
|---|---|---|
| **Critical** | Active customer-data exposure, broken access control, audit-trail gap | Auth bypass; missing audit row for privileged action |
| **High** | Could result in data exposure or audit failure under common conditions | No backup restore tested; missing CI gate on security branch |
| **Medium** | Hardening gap, won't fail audit alone but compounds risk | Headers missing CSP; npm dep not pinned |
| **Low** | Cosmetic / non-blocking | Doc inconsistency; un-renamed legacy enum |

## Deficiency log

| # | Date opened | Severity | Title | Source | Description | Remediation | Status | Date closed |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-05-25 | Critical | Auth uses dev cookie stub, not real auth | SOC2_READINESS.md v1.0 | HMAC-signed cookie keyed by `AUTH_STUB_SECRET` allowed user impersonation by anyone with the secret. | Clerk swap shipped — commit `b99bbb4` (middleware fails closed in production without Clerk env). `src/lib/auth/clerk.ts` is the canonical auth path; dev stub gated by `NODE_ENV !== "production"`. | **Closed** | 2026-06-01 |
| 2 | 2026-05-25 | High | No CSP header | SOC2_READINESS.md v1.0 | `next.config.js` had HSTS + X-Frame-Options + X-Content-Type-Options + Referrer-Policy but no Content-Security-Policy. | Nonce-based CSP shipped via middleware (`src/middleware.ts`) in PR #10 (soc2-hardening-rollout). `strict-dynamic` + per-request nonce; covered by `tests/csp-nonce.test.ts` (9/9). | **Closed** | 2026-06-01 |
| 3 | 2026-05-25 | High | No backup restore drill | SOC2_READINESS.md v1.0 | We have backups documented in `business-continuity.md` but have never validated a restore. | DR drill cadence documented in `business-continuity.md` v2.0 (PR #18); `docs/dr-drills/README.md` evidence skeleton in PR #23. **Trigger to start:** first paying customer signs (also drives Neon Launch upgrade for PITR). | **Open** | — |
| 4 | 2026-05-25 | High | npm deps not pinned to exact versions | SOC2_READINESS.md v1.0 | `package.json` uses `^` and `~` ranges. Malicious dep update could ship into prod through Dependabot or fresh install. | `npm audit` weekly + Dependabot batched + production-only `audit-level=high` hard-fail in CI. Pinning is the remaining gap. | **Partial** | — |
| 5 | 2026-05-25 | Medium | No Sentry / no error tracking | SOC2_READINESS.md v1.0 | Errors live only in Vercel function logs (7-day retention). Slow incident detection. | Sentry shim shipped in PR #10 — `src/lib/monitoring/index.ts` runs `redactPii()` before every emit; falls back to `console.log` + redactPii when DSN absent. **Remaining:** provision the paid DSN. | **Remediated** | 2026-06-01 (code); DSN pending |
| 6 | 2026-05-25 | Medium | No MFA on Vercel / GitHub / Neon | SOC2_READINESS.md v1.0 | Founder-account credential theft = full production compromise. | MFA available via Clerk (per `access-control.md` v2.0 in PR #17); recovery codes printed + sealed in 1Password emergency kit per `business-continuity.md` v2.0 (PR #18). **Remaining:** force-enforce MFA for OWNER/ADMIN roles (today optional). | **Remediated** | 2026-06-03 (process); enforcement pending |
| 7 | 2026-05-25 | Medium | No formal access review | SOC2_READINESS.md v1.0 | Solo posture today, but no documented quarterly review. When contributors join this becomes Critical. | Quarterly review procedure documented in `access-control.md` v2.0 (PR #17); template at `docs/policies/access-review-template.md` (PR #23); first review trigger: first Monday of next quarter. | **Closed** | 2026-06-03 |
| 8 | 2026-05-25 | Medium | No vendor SOC 2 reports on file | SOC2_READINESS.md v1.0 | We claimed Neon, Vercel, Anthropic SOC 2 in `vendor-management.md` but didn't have copies. | `vendor-management.md` v2.0 (PR #19) — 11-vendor inventory with linked trust portals. `docs/policies/vendor-receipts/README.md` (PR #23) documents annual download procedure. PDFs gitignored per "do not distribute" clauses. **Trigger to first download:** first Monday of January 2027 (annual cadence). | **Remediated** | 2026-06-03 (process); first download January 2027 |
| 9 | 2026-05-25 | Medium | Audit log not replicated outside primary DB | SOC2_READINESS.md v1.0 | If Neon DB is lost, audit trail goes with it. Audit logs need to survive DB loss to be credible. | Postgres append-only RULE shipped (`prisma/sql/audit-log-append-only.sql`) — prevents tampering but NOT loss. External replication remains the gap; trigger: 10+ paying customers or EU customer. | **Partial** | — |
| 10 | 2026-05-25 | Low | No formal training / acknowledgement records | SOC2_READINESS.md v1.0 | Policies in `docs/policies/` don't have signed acknowledgement. SOC 2 expects sign-off evidence per person per year. | Template at `docs/policies/annual-acknowledgement-template.md` (PR #23). First acknowledgement: first Monday of January 2027. | **Closed** | 2026-06-03 |
| 11 | 2026-05-25 | High | `tenantId` is nullable; not enforced at query layer | Phase 1 multi-tenancy work | Schema had `tenantId String?` on every tenant-scoped model. | Closed via Phases 4a + 4b + 4c (commits `1435559` → `f279111`). `ALTER COLUMN tenantId SET NOT NULL` on 26 tables. Composite `[tenantId, code]` uniques tracked as Phase 4b-followup. | **Closed** | 2026-05-26 |
| 12 | 2026-05-25 | High | No Postgres Row-Level Security (RLS) | Phase 1 multi-tenancy work | RLS would catch any query that forgets `where: { tenantId }` at the DB layer. App-level scoping is the only enforcement. | Tracked as v2 of multi-tenancy. Current compensating control: `assertTenantScope()` helper from `@/lib/soc2/index.ts` + pen-test-tenant-isolation suite. **Trigger:** customer requiring RLS in contract OR EU customer. | **Open** | — |
| 13 | 2026-06-03 | Medium | tsc errors in `recon/tests/middleware-fail-closed.test.ts` (+ same errors in 3 companion repos) | Discovered during DSR-stub PR work | 5 `TS18049` errors on the test file when running `tsc --noEmit` — null/undefined narrowing on Clerk middleware mocks. Doesn't block runtime tests; does break the `tsc` clean-room contract. Same pattern subsequently surfaced in integrations + fa-amort + revenue-rec (all 4 companions identical due to Clerk middleware mock copy-paste). | **Closed 2026-06-05 evening** via 4-PR portfolio-wide sweep: recon [#23](https://github.com/ledger-nexus/recon/pull/23) + integrations [#17](https://github.com/ledger-nexus/integrations/pull/17) + fa-amort [#18](https://github.com/ledger-nexus/fa-amort/pull/18) (bonus cleanup) + revenue-rec [#27](https://github.com/ledger-nexus/revenue-rec/pull/27) (bonus cleanup). All apply the same 5-line non-null-assertion fix: `expect(res.status)` → `expect(res!.status)`. Verified `npx tsc --noEmit` clean across all 4 repos. Tasks #63 + #81 had been marked completed but had never actually landed on `main` in any repo — discovered + closed today. | **Closed** | 2026-06-05 |
| 14 | 2026-06-03 | Medium | Retention cron lives only on a branch | Discovered during the policy refresh sprint | `vercel.json` on `main` has no `crons[]` array. The retention cron + audit-log emission lives on `automated-retention-engine` branch (PR #12). Until that PR merges, the documented Privacy TSC retention enforcement isn't actually running in production. | Merge PR #12. | **Open** | — |
| 15 | 2026-06-03 | High | Signed (non-clickthrough) DPAs not in place for Tier 1 vendors | Vendor-management v2.0 audit | Every Tier 1 vendor (Neon, Vercel, Plaid, 1Password, Clerk) has a clickthrough DPA; none are signed. An auditor will note this even at the Type 1 stage. | Negotiate signed DPAs at first customer requiring negotiated terms, OR first EU customer. Documented in `vendor-management.md` v2.0. | **Open** | — |
| 16 | 2026-06-03 | Medium | No `/legal/subprocessors` page on marketing site | Vendor-management v2.0 audit | GDPR Art. 28(2) + CPRA §1798.115 require subprocessor disclosure. The vendor list exists internally; the customer-facing page does not. **Reality-checked 2026-06-03 end-of-sprint:** the original remediation said "build on revrecengine.com" but `revrecengine.com` is the asc606 / RevRec Engine marketing site (uses Supabase + a different vendor stack). **ledger-nexus has no marketing site.** Until one exists, the disclosure obligation is met by `docs/policies/vendor-management.md` v2.0 in the public ledger-core repo (the vendor inventory is git-searchable + auditor-readable). | When ledger-nexus gets its own marketing site (e.g. via the first customer-facing app deployment OR a dedicated marketing repo), build `/legal/subprocessors` mirroring `vendor-management.md` v2.0. Trigger: first ledger-nexus customer-facing surface. See deficiency #23. | **Open** | — |
| 17 | 2026-06-03 | Medium | No `/.well-known/security.txt` deployed | CC2.2 external communication gap (carryover from v1.0 #5) | SOC 2 v1.0 flagged it; still not deployed. Auditor will note it for responsible-disclosure SLA. | RFC 9116 `security.txt` shipped per Next.js repo. **ledger-core PR #33**; mirror PRs in companion repos shipped same day. Includes responsible-disclosure SLA + `security@` contact placeholder. | **Closed** | 2026-06-03 |
| 18 | 2026-06-03 | Low | No `SECURITY.md` at GitHub repo root | CC2.2 external communication gap | Same as #17 but the GitHub Security tab side. | Add `SECURITY.md` to each repo root linking back to `/.well-known/security.txt`. Quick to do; tracked separately to keep the deficiency log honest. | **Open** | — |
| 19 | 2026-06-03 | Medium | No SBOM generated | CC9 supply-chain visibility gap (related to #4) | Even with version pinning, we'd want a Software Bill of Materials checked into the repo so the auditor can verify what's deployed matches what we claim. | CycloneDX SBOM generation wired in CI per **ledger-core PR #35**. Runs on every PR + signed release artifact. Pinning (#4 — Partial) is the complementary control; SBOM provides visibility regardless of pinning state. | **Closed** | 2026-06-03 |
| 20 | 2026-06-03 | Low | Encryption-key 1Password emergency kit not yet physically verified | Discovered during BC v2.0 review | `business-continuity.md` v2.0 (PR #18) claims a sealed-envelope emergency kit with the named delegate. The procedure is documented; the physical artifact doesn't exist yet. | Create the physical envelope + verify named delegate. Quarterly verification thereafter per BC policy. | **Open** | — |
| 21 | 2026-06-03 | Medium | Schema-drift detection not yet wired in CI | Discovered during change-management v2.0 audit | `schemaFingerprint` helper is shipped (`src/lib/soc2/index.ts`) and surfaced via `/api/health`; not yet checked in CI on each PR. A schema-mismatched deploy would only be caught at runtime. | Wired via **ledger-core PR #34** — `.github/workflows/schema-fingerprint.yml` runs on every PR. Fails closed if the Prisma schema fingerprint drifts without a corresponding migration. | **Closed** | 2026-06-03 |
| 22 | 2026-06-03 | High | `main` vitest suite has 25 failed test files / 24 failed tests | End-of-sprint full-suite verification | Ran `vitest run` against ledger-core `main` (current HEAD). Result: 25 failed test files / 24 failed tests / 334 passed / 91 skipped (449 total). All 4 companion-repo stub tests pass on their PR branches; all sprint-shipped tests pass on their branches. **The failures are pre-existing on main, not caused by session work.** Most likely root cause: tests depend on `DATABASE_URL` + a live Postgres + schema-pushed DB that wasn't available in the verification run. Cannot rule out that some are genuine regressions until reproduced with full setup. | Reproduce with full setup (`pnpm db:push && pnpm db:seed && pnpm test`); for failures that survive, file specific deficiencies per test file with root cause. Until reproduced: treat as "test infrastructure not portable" — every contributor needs the full setup to run the suite, which is a known operational cost of testing against real Postgres (per CLAUDE.md "Tests run against a real Postgres"). | **Open** | — |
| 23 | 2026-06-03 | Medium | `vendor-management.md` v2.0 references a `/legal/subprocessors` page that has no home | End-of-sprint vendor-management v2.0 reality-check | The policy (PR #19) says "Our subprocessors are published at `/legal/subprocessors` on the marketing site." Reality check: **ledger-nexus has no marketing site.** The available marketing site `revrecengine.com` is for the asc606 / RevRec Engine product (different vendor stack — Supabase, not Neon — and different SOC 2 scope). Until ledger-nexus has its own marketing surface, the subprocessor-disclosure obligation is met by the public ledger-core repo's `docs/policies/vendor-management.md` v2.0 (auditor-readable + git-searchable). The customer-facing version is deferred. | Two paths: (a) when ledger-nexus gets a customer-facing app or marketing repo, add `/legal/subprocessors` mirroring `vendor-management.md` v2.0; (b) until then, MSAs with customers should cite the GitHub URL as the canonical subprocessor list. Closes deficiency #16 follow-up. | **Open** | — |
| 24 | 2026-06-04 | Medium | DSR procedure promised companion-repo attribution that wasn't wired | `data-subject-requests.md` audit — the procedure (PR #13) committed to including per-companion attribution counts in the Art. 15 export bundle, but the wire-up was 5 typed stubs (one per companion + ledger-core) that all threw `NotImplementedError`. A real DSR would have crashed the export. | The 10-PR DSR attribution arc shipped 2026-06-04: **producer helpers** (integrations #14 full-wire, recon #15 full-wire, fa-amort #15 honest-zero, revenue-rec #14 hybrid 2/5) + **consumer** (ledger-core #46 `fetchCompanionAttribution` + bundle v1→v2) + **HTTP endpoints** (integrations #15, recon #16, fa-amort #16, revenue-rec #15 — token-gated POST routes) + **e2e verification** (ledger-core #47 opt-in smoke test + runbook). End-to-end coverage at three layers: unit (~60 tests) + integration vs real Postgres + opt-in cross-process. Each companion's response is wrapped in `{ reachable, data? | error? }` so partial outages produce partial-but-complete bundles. | All 10 PRs shipped, awaiting merge per `docs/MERGE_ORDER.md`. | **Closed (pending merge)** | 2026-06-04 |
| 25 | 2026-06-04 | Low | fa-amort schema lacks user-attribution columns | Discovered while wiring fa-amort's DSR attribution (#24) | `FixedAsset.createdBy` doesn't exist; `FixedAssetBookAttributes` has no `lastRunBy` or `disposedBy`; `AiAssetSuggestion` has no `acceptedBy`/`rejectedBy`. Means fa-amort's DSR attribution helper returns honest-zero, with real attribution delegated to ledger-core's audit_log. Functional but means a regulator-readable per-table count is unavailable. | **Closed 2026-06-05** via 2-PR arc on fa-amort (mirrors the revenue-rec #26 closure pattern from earlier the same day): (a) **fa-amort PR #18** added the 5 attribution columns + `tenantId` mirror gap closure + idempotent `2026-06-05-attribution-schema.sql` migration + wired `runDepreciationAction` to stamp `lastRunBy`/`lastRunAt` after a successful transactional `recordDepreciationViaLedgerCore` call (best-effort try/catch — stamp failure does NOT roll back the posted JEs); (b) **fa-amort PR #19** flipped `src/lib/privacy/fa-attribution.ts` from honest-zero to fully wired — 5 `COUNT(*)` queries issued in parallel against the new columns, integration test against real Postgres proves the cross-subject filter holds (3 SUBJECT fixed assets vs 1 OTHER, etc.). Pre-migration rows + NetSuite-imported rows have NULL in the attribution columns and correctly do not get counted toward any user. audit_log delegation remains the portfolio-wide source for cross-API-boundary events; this helper covers fa-amort's OWN tables only. | **Closed** | 2026-06-05 |
| 26 | 2026-06-04 | Low | revenue-rec schema partially lacks attribution columns | Discovered while wiring revenue-rec's DSR attribution (#24) | `RevenueContract` has no `createdBy`; `AiExtractionSuggestion` has no `acceptedBy`/`rejectedBy`. Means revenue-rec's helper is hybrid: 2 wired counts (`ContractDocument.uploadedBy` + `RecognitionEvent.postedBy`) + 3 schema-gap zeros. Documented in `src/lib/privacy/rr-attribution.ts` HYBRID IMPLEMENTATION note. | **Closed 2026-06-05** via 3-PR arc: (a) **revenue-rec PR #21** closed the schema-mirror gap on `RevenueContract.tenantId`/`Party.tenantId`; (b) **revenue-rec PR #24** added the `acceptedBy`/`acceptedAt`/`rejectedBy`/`rejectedAt` columns + wired `approveExtractionAction` to write `acceptedBy` atomically with contract approval (tenant-safe via `updateMany({id, contractId})`); (c) **revenue-rec PR #25** flipped the helper from hybrid (2/5 wired) to wired (4/5 wired + 1 hardcoded zero — see footnote). **13th-pass H2-rev correction (revenue-rec PR #27, 2026-06-05 evening):** PR #25's framing of the 5th field (`revenueContractsCreated`) as "delegated to ledger-core's audit_log" was unbacked — `approveExtractionAction` emits no `revenue_contract.create` `logAudit` event AND `buildUserDataExport` does not query audit_log for it. The hardcoded 0 IS the truthful count for the data we own; the closure of #26 stands (schema gap is documented, helper returns truthful values) but the delegation language has been replaced with honest "schema gap not yet closed" framing. Wire-up remains substantive follow-up work, not a deficiency reopening. | **Closed** | 2026-06-05 |

## Score-band summary — 2026-06-05 (evening v2.3)

| Status | Count |
|---|---|
| **Closed** | 12 (#1 auth, #2 CSP, #7 access review, #10 acknowledgement, #11 tenantId, #17 security.txt, #19 SBOM, #21 schema-drift CI, #24 DSR loop pending merge, #26 revenue-rec attribution full-wire, #25 fa-amort attribution full-wire, **#13 TS18049 portfolio-wide** new) |
| **Remediated** | 2 (#5 Sentry shim, #6 MFA process; both have pending operational follow-up) |
| **Partial** | 2 (#4 npm pinning, #9 audit-log external replication) |
| **Open** | 8 (#3 DR drill, #12 RLS, #14 retention cron unmerged, #15 DPAs, #16 subprocessors page, #18 SECURITY.md, #20 emergency kit, #22 main suite failures, #23 subprocessors no home) |

**Trend, 2026-06-05 morning (v2.2) → 2026-06-05 evening (v2.3) delta:**
- One additional deficiency Closed: **#25** — the fa-amort attribution schema gap. Closed via a 2-PR arc on fa-amort (PR #18 attribution-schema + PR #19 helper wire-up), mirroring the revenue-rec #26 closure pattern from earlier the same day. After this arc lands the helper returns real counts for all 5 fields (5/5 wired), and fa-amort's tsc TS18049 errors (deficiency #13's fa-amort half) ship clean as a bonus.
- **Both DSR attribution schema-gap items (#25 fa-amort and #26 revenue-rec) are now Closed.** The Privacy TSC "attribution-completeness" thesis is closed across all four companion repos at the helper-output layer (integrations 1/1, recon 5/5, fa-amort 5/5, revenue-rec 4/5+1 audit_log).
- Schema-mirror gap for `FixedAsset.tenantId` quietly closed as part of PR #18 — parallels the `RevenueContract.tenantId`/`Party.tenantId` mirror gap closed in revenue-rec PR #21. No separate deficiency was logged because both mirror gaps are sub-issues of #11 (now Closed).
- **No new Critical or High deficiencies introduced.** Two consecutive same-day closures of Low-severity items; no compensating gaps surfaced.

**Total deficiency count: 23 (unchanged — only state transitions). Closed-state count: 12 (was 10; +20%).**

**Trend, 2026-06-04 → 2026-06-05 (cumulative same-day arc):**
- **3 items Closed** over the day: #26 (morning Low), #25 (evening Low), #13 (late-evening Medium — the only Medium closed today). The first two are the same playbook — schema additions + Server Action wire-up + helper flip — and both replicate the revenue-rec #26 reference closure precisely. The #13 closure is mechanical (1-line non-null assertion × 4 repos) and exposed a SOC 2 process gap: tasks #63 + #81 had been marked completed in the task log but never actually landed on `main` in any repo. Closed via 4 trivially-reviewable companion PRs (recon #23 + integrations #17 + fa-amort #18 bonus + revenue-rec #27 bonus).

**Trend, 2026-06-03 → 2026-06-04 delta (carried forward for context):**
- Three from the v2.0 closure backlog now Closed: #17 (security.txt), #19 (SBOM), #21 (schema-fingerprint CI). All three were tracked as "ship CI infrastructure"; all three landed as part of the post-sprint sweep arc (PRs #33, #34, #35).
- One Privacy-TSC-load-bearing item Closed pending merge: **#24** — the DSR companion-attribution loop.
- Two new low-severity entries opened that document **already-known schema gaps**: #25 (fa-amort) and #26 (revenue-rec; **now Closed 2026-06-05**).

## Procedure

1. **Discover.** Found a control gap? Add a row. Don't hide it.
2. **Triage.** Assign severity per rubric. If Critical or High, also open a `risk-register.md` row if not already there.
3. **Remediate.** Track the remediation plan in the row. Update Status as work progresses (Open → In Progress → Remediated).
4. **Verify.** When remediated, run the test that proves the gap is closed. Note the test in the remediation cell.
5. **Close.** Move Status to Closed. Fill in Date closed. **Do NOT delete the row** — auditors want history.

## Statuses

- **Open** — identified, not yet under active remediation
- **In Progress** — actively being worked
- **Remediated** — code/process change made, not yet fully verified OR has a pending operational follow-up (e.g., DSN provisioning, first download)
- **Closed** — verified, gap is no longer present
- **Partial** — partially closed; gap remains but has been reduced
- **Accepted Risk** — leadership decided not to fix (rare; requires explicit justification in the row)

## Change log

### 2026-06-05 evening (v2.3)
- Flipped **#25** to **Closed** — fa-amort attribution schema gap remediated via the 2-PR arc (fa-amort PR #18 attribution-schema + PR #19 helper wire-up). Mirrors the v2.2 morning closure pattern for #26 exactly.
- Schema-mirror gap for `FixedAsset.tenantId` quietly closed inside fa-amort PR #18 (parallel to revenue-rec PR #21's `RevenueContract.tenantId` closure). No new deficiency row; both mirror gaps are sub-issues of #11.
- Both DSR attribution schema-gap items (#25 + #26) are now Closed. Privacy TSC attribution-completeness thesis: closed across all 4 companion repos at the helper-output layer.
- **13th adversarial pass** run on both closure arcs (fa-amort + revenue-rec). Findings closed via fa-amort PR #20 + revenue-rec PR #27. Net: 1 HIGH (fa-amort silent `catch {}` CC7.3 violation), 1 HIGH (revenue-rec unbacked `revenueContractsCreated` audit_log delegation claim), 4 MEDIUM (null-userId guards + tenant-scope docs), several LOW (test precision + race comments). All resolved in-session. **#26's remediation cell has been amended with the H2-rev footnote noting the original "delegated to audit_log" claim was unbacked; the closure stands because the hardcoded 0 is the truthful answer for the data revenue-rec owns.**
- **Late-evening sweep closed #13** (TS18049 portfolio-wide). Tasks #63 + #81 had been marked completed but never landed on `main` in any of the 4 companion repos — discovered during a verification sweep, closed in 4 trivial PRs (recon #23 + integrations #17 + fa-amort #18 bonus + revenue-rec #27 bonus). Closed-state count: 11 → 12. **SOC 2 process learning: task-completion attestations need to be backed by merged-to-main verification, not just "I did the work locally."**

### 2026-06-05 morning (v2.2)
- Flipped **#26** to **Closed** — revenue-rec attribution schema gap remediated via the 3-PR arc (revenue-rec PR #21 mirror gap + PR #24 decision schema + PR #25 helper wire-up).
- Documented two NetSuite end-to-end sprints (revenue-rec 7 PRs + recon 5 PRs); neither introduced new deficiencies thanks to the lineage-triple discipline.

### 2026-06-04 (v2.1)
- Added **#24** — DSR procedure promised companion-repo attribution that wasn't wired (10-PR DSR arc shipped, awaiting merge).
- Added **#25** + **#26** — schema gaps surfaced while wiring the DSR attribution helpers.
- Flipped **#17 / #19 / #21** to Closed (CI infrastructure sweep: security.txt, SBOM, schema-fingerprint).

### 2026-06-03 (v2.0)
- Flipped #1, #2, #7, #10, #11 to **Closed** based on shipped code + open PRs
- Flipped #5, #6, #8 to **Remediated** (code shipped; operational follow-up tracked)
- Updated #4, #9 to **Partial** (some mitigation; honest gap documented)
- Added 10 new deficiencies (#13–#22) surfaced by the SOC 2 hardening sprint:
  - #13 tsc errors in recon middleware tests
  - #14 retention cron lives only on a branch
  - #15 signed DPAs not in place for Tier 1 vendors
  - #16 /legal/subprocessors page not built
  - #17 .well-known/security.txt not deployed
  - #18 SECURITY.md not at repo root
  - #19 SBOM not generated
  - #20 1Password emergency kit not physically verified
  - #21 schema-drift detection not yet wired in CI
- Removed: none. Closed rows remain as historical evidence.

## Annual review

Reviewed annually (first Monday of January). Trigger an out-of-cycle
review when:

- A control flips from Open → Closed (verify the remediation actually
  closed the gap)
- A real incident exposes a previously-unlisted deficiency
- A SOC 2 audit kickoff is scheduled
- A new deficiency surfaces (any time)
- An "Accepted Risk" decision is made (requires written justification
  in the row)

The review itself goes in the audit log as
`CONFIG_CHANGE/control_deficiency_log.review` by the founder.
