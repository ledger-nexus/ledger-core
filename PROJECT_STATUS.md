# Project Status

Running log of where this project is, what's next, and key decisions. Updated at the end of each working session so the next session (whether by me or by Claude Code) can pick up without re-explaining context.

---

## Where we are

**Last updated:** 2026-06-05 (evening — fa-amort #25 closure arc + 13th adversarial pass)

**Current state:** **SOC 2 ≈76% + DSR portfolio-wide attribution-completeness + 13th adversarial pass closed + TWO NetSuite sprints end-to-end with UI.**

The portfolio architecture (v1.0) was complete on 2026-05-21. The
2026-05-25 → 2026-06-03 sprint added the SOC 2 layer the v1.0
accounting substrate didn't have: per-tenant RBAC + Clerk auth,
field-encryption-at-rest portfolio-wide, append-only audit-log,
automated retention engine, DSR procedure + executable code, and
**v2.0 reality-checked rewrites of every policy doc** (security,
access-control, change-management, incident-response, data-
classification, data-subject-requests, vendor-management, risk-
register, business-continuity, control-deficiency-log).

The continuation pass shipped a second batch: trust-surface evidence
(security.txt, customer-trust questionnaire), CI gates (schema-
fingerprint drift detection, SBOM generation), MERGE_ORDER guidance,
the NetSuite Fleet reference doc, and the **validator-to-shipping
trilogy** — a 4-layer pattern (validator → pure mappers → orchestrator
→ integration test) applied to revenue-rec, fa-amort, GL substrate,
and recon. Two of those (fa-amort + GL substrate) shipped downstream
in the same session: fa-amort PR #14 (5 commits, 63 new tests, 121
total) and ledger-core PRs #43-#45 (bootstrap mappers + composition
helper + 11 integration tests vs real Neon).

Cumulative: **90+ reviewable PRs across the 5-repo portfolio**
(was 84+ this morning; +6 from the evening: fa-amort PRs #18 / #19 / #20 +
ledger-core PRs #58 / #59 / #60). `SOC2_READINESS.md` v2.3 (ledger-core
PR #59) stands at `≈76% to Type 1 audit-ready, 0 CRITICAL gaps`. The
remaining 24% is dominated by **customer-trigger gates** + the **Type 2
6-month observation window** — both explicitly called out in the v2.3
readiness assessment.

**Portfolio-wide milestones reached 2026-06-04:**
- `tsc --noEmit` clean across 5/5 repos (closes deficiency #13)
- DSR attribution loop wired end-to-end (closes deficiency #24)
- Three CI gates live (schema-fingerprint, SBOM, security.txt deploy)

**Substrate milestones reached 2026-06-05:**
- **Two NetSuite mapper sprints end-to-end** (revenue-rec + recon)
- Cross-repo lineage triple mechanically proven against real Postgres
- ASC 606 ¶77+¶78 schema additions shipped + migrated (revenue-rec)
- **v2.1 deficiency #26 closed in v2.2** via 3-PR arc (revenue-rec #21+#24+#25) — helper flipped from hybrid (2/5) → full-wire (4/5 + 1 documented audit_log delegation)
- **Universal-schema "validate by mapping" thesis mechanically demonstrated for both NS domains** — reverse exporters (revenue-rec #26 + recon #22) read frozen `sourcePayload`/`rawPayload` back + `diffNsRevenueExports`/`diffNsReconExports` helpers prove semantic-equality roundtrip
- Substrate accepts NetSuite data: 17 new companion PRs, 5 UI surfaces, 117 new tests (was 12/5/98 earlier today)

**Privacy TSC + adversarial-pass milestones reached 2026-06-05 EVENING:**
- **v2.2 deficiency #25 closed in v2.3** via 2-PR arc (fa-amort #18 attribution-schema + #19 helper wire-up) — helper flipped from honest-zero → 5/5 wired. Same playbook as the morning #26 closure, applied to fa-amort.
- **`FixedAsset.tenantId` Prisma-mirror gap silently closed inside fa-amort PR #18** — parallel to revenue-rec PR #21's `RevenueContract.tenantId` closure. Both mirror gaps are sub-issues of deficiency #11 (already Closed).
- **Both DSR attribution schema-gap items (#25 + #26) are now Closed** — Privacy TSC attribution-completeness thesis is closed at the **column-level** layer across all 4 companion repos (integrations 1/1, recon 5/5, fa-amort 5/5, revenue-rec 4/5+1).
- **13th adversarial-pass audit landed + fully closed** (fa-amort PR #20) — found 1 HIGH (silent stamp-failure CC7.3 violation in `run-depreciation.ts`) + 2 MEDIUM (tenant-scope ambiguity doc + null-userId guard in `fa-attribution.ts`) + 2 LOW (strict-equality test + race-comment). All 5 closed in a single follow-up PR with +5 tests (79/79 vitest, 0 tsc).
- Readiness % ticks `≈75%` → `≈76%` (SOC2_READINESS v2.3 in ledger-core PR #59). Closed-state count: 10 → 11. Remaining 24% is dominated by **customer-trigger gates** + **Type 2 6-month observation window** — both unmovable without operational triggers.

**Repo:** https://github.com/ledger-nexus/ledger-core

---

## What's done

### v1.x — SOC 2 hardening sprint (2026-05-25 → 2026-06-03)

**Auditor entry-point documents (read first):**
- [x] `docs/SOC2_READINESS.md` v2.0 (PR #22) — `≈70% to Type 1, 0 CRITICAL` (down from `0-10% to Type 2, 8 CRITICAL` in v1.0)
- [x] `docs/SOC2_CONTROL_MATRIX.md` — CC1-CC9 + 4 TSCs evidence map with file paths
- [x] `docs/architecture/portfolio-data-locations.md` (PR #14) — portfolio-wide map; the auditor opens this to understand the 5-repo system before drilling in

**Policy directory — every document now at v2.0:**
- [x] `security.md` v2.0 (PR #20) — CC1 umbrella + 6-principle tone-at-the-top + 13-row standing-reference-artifact table + AI contributor rules section
- [x] `access-control.md` v2.0 (PR #17) — CC6.1-CC6.3 + 4-role × 16-permission catalog + 4-token service-token inventory + offboarding procedure
- [x] `change-management.md` v2.0 + `bypass-log.md` skeleton (PR #16) — CC8 + 11-row "what counts as a change" + 8-row required-gates with file paths + solo-dev compensating controls
- [x] `data-classification.md` (sprint commits) — DSR + automated retention checkboxes flipped
- [x] `data-subject-requests.md` NEW (PR #13) — Privacy TSC + GDPR Art. 15/17/16/20/21 + CPRA equivalents + 3 channels + 30-day SLA
- [x] `incident-response.md` v2.0 (PR #21) — CC7.3 + CC7.4 + policy/runbook split + GDPR Art. 33/34 privacy-incident overlay + 8-section postmortem requirement
- [x] `vendor-management.md` v2.0 (PR #19) — CC9 + 11-vendor inventory + 3-tier classification + subprocessor disclosure
- [x] `risk-register.md` v2.0 (PR #15) — CC3 + 30 reality-checked rows (22 Mitigated + 7 Partial + 1 Open) + 10 new risks
- [x] `business-continuity.md` v2.0 (PR #18) — CC7 + Availability TSC + trigger-driven RTO/RPO + 7 scenario runbooks + 8-row delegation matrix
- [x] `control-deficiency-log.md` v2.0 (PR #30) — CC4 + reality-checked v1.0 12 rows + 9 new deficiencies surfaced by the sprint

**Operational evidence skeletons (PR #23):**
- [x] `docs/incidents/README.md` — per-incident + tabletop file format
- [x] `docs/dr-drills/README.md` — quarterly restore + tabletop + real-DR-event formats
- [x] `docs/policies/vendor-receipts/README.md` + PDFs gitignored
- [x] `docs/policies/access-review-template.md` — quarterly template
- [x] `docs/policies/annual-acknowledgement-template.md` — annual template

**Foundation code (PR #10 — soc2-hardening-rollout):**
- [x] `src/lib/soc2/index.ts` — `assertTenantScope`, `auditedMutation`, `constantTimeEqual`, `redactPii`, `sanitizeError`, `schemaFingerprint`
- [x] `src/lib/env.ts` + `src/instrumentation.ts` — boot-time env validation; fails closed on missing required env in production
- [x] `src/middleware.ts` — CSP nonce + strict-dynamic + HTTPS upgrade + Clerk auth boundary
- [x] `src/lib/monitoring/index.ts` — Sentry shim with `redactPii` before transmit; console fallback when DSN absent
- [x] `src/app/api/health/route.ts` — DB ping + schema fingerprint + encryption status + monitoring presence
- [x] `prisma/sql/audit-log-append-only.sql` — Postgres RULE silently no-ops UPDATE + DELETE on `audit_log`
- [x] `scripts/pre-commit-secrets-scan.sh` — secrets + console.log PII scan; symlinked as `.git/hooks/pre-commit`
- [x] `.claude/commands/soc2-check.md` — slash command for per-diff SOC 2 audit
- [x] `.claude/skills/soc2/SKILL.md` — auto-surfaces the framework into every Claude session

**Encryption-at-rest rollout (PRs #24-#27 stack):**
- [x] Design doc (PR #24) — `docs/design/deterministic-encryption.md` (359 lines) — AES-256-GCM transparent extension + HMAC search hash with 2-key separation
- [x] Phase 1 (PR #25) — `src/lib/soc2/deterministic-encryption.ts` HMAC helper + `/api/health` deterministicEncryption block + regression-pinned test suite
- [x] Phase 2 (PR #26) — `User.email` encrypted + `emailHash` schema column + auth-path migration + backfill script
- [x] Phase 3 (PR #27) — `TenantInvite.email` + `JournalEntryNote.authorEmail` + per-tenant duplicate-invite-refusal migration
- [x] Json-mode encryption — `AuditLog.metadata`, `JournalEntry.sourcePayload`, `AiSuggestion.candidatesJson`, `AiAssetSuggestion.outputJson`
- [x] **26+ encrypted columns across 5 repos** with the same extension; `looksEncrypted` 5-check defense against plaintext false-positives
- [x] Post-deploy verifier (PR #28) — `scripts/verify-encryption-rollout.sh` with per-column 3-check

**Automated data retention engine (PR #12):**
- [x] `src/lib/retention/policies.ts` — declarative 4-policy registry (notification.seen 365d / notification.unseen_stale 730d / tenant_invite.terminal 30d / email_delivery.transient 90d)
- [x] `src/lib/retention/purge.ts` — per-policy try/catch with `sanitizeError`
- [x] `src/app/api/cron/retention/route.ts` — `CRON_SECRET`-gated; audit-logs `CONFIG_CHANGE/retention.purge` per run
- [x] 17 unit tests covering policy registry, cutoff math, failure isolation, route auth gating, audit emission
- [x] Vercel Cron schedule `0 3 * * *` in `vercel.json` (on the branch; main intentionally omits until merge)

**Multi-tenant isolation (pre-sprint hardening, now Mitigated):**
- [x] `tenantId @db.Uuid` on every customer-data table; 26 tables migrated to `NOT NULL`
- [x] `src/lib/auth/policy.ts` 4-role × 16-permission catalog; every Server Action calls `requirePermission(...)`
- [x] 4 pen-test passes (cross-tenant read/write `72c164b`, reassign + internal fixed-asset `185902f`, CSV injection + TOCTOU + token timing `3c6d0a2`, middleware fail-closed `b99bbb4`)
- [x] `tests/pen-test-tenant-isolation.test.ts` covers cross-tenant attempts portfolio-wide

**Companion-repo DSR procedures (per-repo PR #11):**
- [x] `recon` — DSR procedure scoped to bank statements + reconciliation data; `src/lib/privacy/recon-attribution.ts` typed stub + 5 tests
- [x] `fa-amort` — DSR procedure scoped to fixed-asset register + depreciation; `src/lib/privacy/fa-attribution.ts` typed stub + 5 tests
- [x] `revenue-rec` — DSR procedure scoped to contracts + recognition; `src/lib/privacy/rr-attribution.ts` typed stub + 5 tests (counterparty PII in `ContractDocument.rawText` is the highest-sensitivity column in the portfolio)
- [x] `integrations` — DSR procedure scoped to OAuth tokens + connections; `src/lib/privacy/connections-export.ts` typed stub + 5 tests with HARD INVARIANT (interface has NO `credentials|tokens|accessToken|refreshToken` field — Art. 15(4) rights-of-others carve-out)

**SECURITY.md sweep (5 PRs, one per repo):**
- [x] Resolved `REPO` placeholder in GitHub security-advisory URL per repo
- [x] Updated SOC 2 framework section to point at v2.0 policy directory + control matrix + portfolio data location map
- [x] Added Incident handling section with GDPR Art. 33 72h SLA cited

**Incident response runbook (PR #29):**
- [x] `docs/runbooks/incident-response.md` (264 lines) — operational steps the on-call engineer reads; pairs with the policy in PR #21

### v1.x — Post-sprint sweeps + validator → shipping cycle (PRs #33-#45, 2026-06-03 continued)

**Trust-surface evidence + CI gates:**
- [x] `public/.well-known/security.txt` (PR #33) — RFC 9116 vulnerability disclosure pointer; closes deficiency #17
- [x] Schema-fingerprint CI gate (PR #34) — `.github/workflows/schema-fingerprint.yml` runs `schemaFingerprint` on every PR; fails closed if Prisma schema drifts without a migration; closes deficiency #21
- [x] SBOM CI (PR #35) — CycloneDX SBOM generation on every PR + signed release artifact; closes deficiency #19
- [x] `docs/MERGE_ORDER.md` (PR #36) — explicit merge sequence for the 46 open PRs portfolio-wide; the change-management v2.0 procedure made this load-bearing
- [x] `docs/sales/customer-trust-questionnaire.md` (PR #37) — CSA CAIQ v4 pre-filled answers + condensed sales sheet; the "send this when prospects ask for SOC 2" artifact
- [x] `docs/reference/netsuite-fleet-master-data.md` (PR #38) — schema notes + field-by-field translatability map from the 1k-row Fleet NetSuite extract the owner attached for study

**Validator → shipping trilogy (4-layer pattern: validator → pure mappers → orchestrator → integration test):**
- [x] revenue-rec NetSuite validation (PR #39) — schema-additions needed: `allocatedAmount` + `fairValueMethod` + `quantity` on `PerformanceObligation` to absorb NS revenue-arrangement allocations; ~1-2 weeks of engineering captured as a sequenced backlog
- [x] fa-amort NetSuite validation (PR #40) — 87/90 Fleet sample assets fully translatable; 3 method gaps (150% DB, SYD, Amortization) map to NONE with `unmappedMethodNote`; downstream shipping landed in fa-amort PR #14 (4-layer + 63 tests)
- [x] GL substrate NetSuite validation (PR #41) — bootstrap layer (Subsidiary/AccountingBook/AccountingPeriod) was the missing piece; downstream shipping is PRs #43-#45 below
- [x] recon NetSuite validation (PR #42) — denormalized `matched_transaction` → normalized `ReconciliationMatch` is the model-translation gap; ~1 week of engineering captured as a sequenced backlog

**ledger-core bootstrap-mapper shipping (closes the gap PR #41 surfaced):**
- [x] Bootstrap mappers (PR #43) — `src/lib/mappers/netsuite/bootstrap.ts` (~530 lines): types + pure mappers + idempotent orchestrators for `Subsidiary` → `LegalEntity`, `AccountingBook` → `Book`, `AccountingPeriod` → `Period`. Code conventions: `NSSUB-{id}`, `NSBOOK-{id}`, `{entityCode}-CAL-{calendarName}`. NetSuite-only fields (`isElimination`, `consolidationMethod`) preserved in `extensions JSONB` per existing pattern.
- [x] Composition helper (PR #44) — `bootstrap-and-import.ts` (~170 lines): `importFromNsWithBootstrap()` orchestrates subs → books → periods → tx in one call. Resolves `entityCode`/`bookCode`/`fiscalCalendarCode` from `primarySubsidiaryId`/`primaryBookId`. Throws if `primarySubsidiaryId` not in `bootstrap.subsidiaries`.
- [x] Integration test (PR #45) — 11 tests against real Neon Postgres covering idempotency, namespacing, multi-sub hierarchies, `FiscalCalendar.entityId` per-entity scoping, `BookBasis` enum mapping (unknown → `STATUTORY`), all green in 7s. Uses `getDefaultTenantId(prisma)` helper to satisfy `Tenant.ownerUserId` requirement; cleanup scoped to `NSSUB-ITEST-*` and `NSBOOK-ITESTBOOK-*` prefixes.

### v1.x — DSR end-to-end + portfolio tsc-clean (PRs #46-#51 + 11 companion-repo PRs, 2026-06-04 continuation)

**DSR companion-attribution arc (10 PRs end-to-end):**
- [x] **Producer helpers** (4 companion repos): integrations `connectionsAttribution` (PR #14 — full wire via `Connection.createdBy`), recon `reconAttribution` (PR #15 — full wire via `BankStatement.uploadedBy` + `ReconciliationMatch.approved/rejectedBy`), fa-amort `faAmortAttribution` (PR #15 — honest-zero; schema gap delegated to ledger-core audit_log), revenue-rec `revenueRecAttribution` (PR #14 — hybrid 2/5 wired)
- [x] **Consumer** (ledger-core PR #46) — `fetchCompanionAttribution()` + bundle schema v1 → v2 with per-companion `{ reachable, data? | error? }` wrapper; 5s `AbortController` timeout per companion; failure-tolerant — partial outages produce partial-but-complete bundles
- [x] **HTTP endpoints** (4 companion repos) — token-gated `POST /api/internal/dsr/attribution` per repo, mirrors recon's `/api/internal/bank-lines` envelope (503 fail-closed / 401 constant-time / 400 / 500 / 405-GET); integrations #15, recon #16, fa-amort #16, revenue-rec #15
- [x] **E2E verification** (ledger-core PR #47) — opt-in cross-process smoke test gated by `E2E_DSR_TEST=1` + `INTERNAL_API_TOKEN`; asserts schemaVersion 2 + every companion `reachable: true` + HARD INVARIANTS (no `credentials`/`accesstoken`/`rawtext`/`rawpayload` substrings); includes `docs/runbooks/dsr-e2e-test.md` 6-terminal operator guide + failure triage
- [x] Total: ~60 new tests across three layers (unit + integration vs real Postgres + opt-in smoke). Privacy TSC commitment now mechanically + procedurally complete.

**Doc-triangle catch-up (PRs #48-#51):**
- [x] `control-deficiency-log.md` v2.0 → v2.1 (PR #48) — closes #17 / #19 / #21 with PR references + adds DSR arc closure #24 + 2 new low-severity entries (#25 fa-amort schema gap, #26 revenue-rec schema gap, both documented compensating controls). Closed-state count: 5 → 9 (+80%). No new Critical or High.
- [x] `SOC2_READINESS.md` v2.0 → v2.1 (PR #49) — readiness `≈70%` → `≈75%`. Delta section at top with 10-PR DSR table + four closures (Privacy TSC, CC2.2 security.txt, CC8 schema-fingerprint CI, CC9 SBOM). Remaining 25% dominated by **customer-trigger gates** + Type 2 6-month observation window (both explicit).
- [x] `risk-register.md` v2.0 → v2.1 (PR #50) — #16 (right-to-deletion) upgraded to "Mitigated end-to-end"; #26 (replica drift) downgraded gap (companion endpoints provide verification surface); new #31 cross-repo `INTERNAL_API_TOKEN` rotation drift (L 3 / I 3 / Mitigated operator-attested via runbook).
- [x] `docs/MERGE_ORDER.md` (PR #51) — Groups H (validator+bootstrap), I (DSR end-to-end), J (doc-triangle catch-up) added; portfolio open PRs count 35 → 50+; second TL;DR paragraph for the 10-PR DSR loop.

**Portfolio-wide tsc-clean (closes deficiency #13):**
- [x] integrations PR #16, fa-amort PR #17, revenue-rec PR #16 — `expectResponse()` helper mirrors recon PR #14 (the canonical version) across the remaining 3 repos. Narrows `Response | undefined` middleware return type. After merge, **all 5 repos pass `npx tsc --noEmit` cleanly** for the first time.

### v1.x — Two NetSuite mapper sprints (2026-06-05, 12 companion-repo PRs end-to-end)

The substantive engineering arc that the validator trilogy (ledger-core PRs #39-#42) sequenced as ~3 weeks of focused work landed in a single session as two parallel mapper sprints. Both consume NetSuite Fleet sample data via ledger-core's universal NS bootstrap (PR #43-#45) and follow the same 5-layer pattern: pure mappers → orchestrator → integration tests vs real Postgres → Server Action → UI.

**revenue-rec NS revenue arrangements sprint (7 PRs, end-to-end):**
- [x] revenue-rec PR #17 — Schema additions: `allocatedAmount` + `allocationMethod` (PROPORTIONAL/RESIDUAL/MANUAL) + `fairValueMethod` (ESP/VSOE/TPE/RESIDUAL) + `quantity` on `PerformanceObligation`. ASC 606 ¶77+¶78. All NULL-tolerant or DEFAULT 1 for back-compat. Idempotent SQL migration. **Closes deficiency #26 documented half.**
- [x] revenue-rec PR #18 — Foundation: `types.ts` (NS revenue-arrangement shapes, snake_case, preserves custom_columns/custom_body) + `mappers.ts` (pure functions: `mapElement`, `mapArrangement`, recognition-template translation, allocation/fair-value method enum translation, `allocatedAmount=null` when SSP-equal for back-compat, $0.01 reconciliation tolerance) + 22 unit tests.
- [x] revenue-rec PR #19 — Orchestrator `importFromNsRevenue` with lineage-triple idempotency + transactional per-arrangement discipline + resolver-callback pattern (resolveEntityId, resolveCustomerPartyId) + per-arrangement error isolation + warnings propagation. 10 mocked-Prisma unit tests.
- [x] revenue-rec PR #20 — `schedule.ts` accepts `OVER_TIME_USAGE` + `OVER_TIME_MILESTONE` (returns empty schedule; event-driven recognition). Was throwing ScheduleError; unblocks the mapper's USAGE/MILESTONE patterns. Adds compile-time exhaustiveness check via `const _: never = pattern`. +4 / -2 tests net.
- [x] revenue-rec PR #21 — Schema-mirror gap closure for `RevenueContract.tenantId` + `Party.tenantId` (DB columns existed since 2026-05-31; mirror was stale, forcing raw-SQL escape hatches). Orchestrator updated to require tenantId at the boundary (CC6.1). Seed updated. **3 integration tests vs real Neon Postgres prove the schema-mirror gap is genuinely closed.**
- [x] revenue-rec PR #22 — Server Action `importNsRevenueAction` with `requireCurrentTenant()` + `NSSUB-{id}` entity resolver + `NS-CUST-{id}` customer-party upsert resolver. JSON parse/validation + result envelope + actionable auth-error messages. 11 unit tests.
- [x] revenue-rec PR #23 — UI page at `/import/netsuite`. Server Component chrome with annotated sample JSON + ImportPanel client component with textarea + tone-coded 6-stat result grid + collapsible per-arrangement detail + errors-open-by-default. Sidebar link.

**Sprint output**: ~3000 lines of code, +54 tests (was 42 at sprint start, 96 at end), 5 layers proven, end-to-end from PR #17's schema migration all the way to the rendered Import button. The "1-2 weeks of focused engineering" the validation backlog (PR #39) estimated is done.

**recon NS bank reconciliation sprint (5 PRs, end-to-end):**
- [x] recon PR #17 — Foundation: `types.ts` (NS bank statement + line + matched_transaction shapes) + `mappers.ts` (pure functions: `mapBankAccount`, `mapStatementLine`, `mapStatement`, `mapForImport`, $0.01 reconciliation tolerance, matched-ratio warning when statement has 3+ lines and <50% matched) + 19 unit tests. **The load-bearing translation rule** per validation doc: NS line WITH `matched_transaction_id` → `ReconciliationMatch { source: MANUAL, status: APPROVED }`. Preserves NS's human-approved match verbatim.
- [x] recon PR #18 — Orchestrator `importFromNsRecon` with filename-based idempotency + transactional per-statement + the **cross-repo lineage-triple lookup**: `resolveJournalLineId({ matchedTransactionType, matchedTransactionInternalId })` queries the GL substrate by lineage triple to find the JournalLine.id a NS matched_transaction_id resolves to. **Graceful degradation when GL document not yet imported**: bank line still lands, no match created, warning surfaced; recoverable on follow-up reconciliation pass. 10 mocked-Prisma unit tests.
- [x] recon PR #19 — **Integration tests vs real Postgres prove the cross-repo lineage-triple lookup completes end-to-end**: NS denormalized `matched_transaction_id` → resolver callback queries lineage triple → real seeded JournalLine.id → `ReconciliationMatch { source: MANUAL, status: APPROVED, journalLineId }` created in the DB. Plus filename-based idempotency, graceful-degradation null case, BankAccount upsert correctness. 4 integration tests.
- [x] recon PR #20 — Server Action `importNsReconAction` with `requireCurrentTenant()` + `NSSUB-{id}` entity resolver + lineage-triple Account resolver + lineage-triple JournalEntry resolver with **"prefer BANK-subtype line" heuristic** (`ReconciliationMatch.journalLineId` should reference the JE line that hits the bank account, not the AR/AP counterparty side; falls back to first-by-lineNo when no BANK subtype found). 11 unit tests.
- [x] recon PR #21 — UI page at `/import/netsuite`. Same skeleton as revenue-rec but with **distinctive 8-stat grid** including `Matches deferred` (tone-coded amber when >0) — the operator-facing reflection of the graceful-degradation path. Per-statement badge shows full outcome inline: "Created · 5 lines · 3 matches · 2 deferred". Sidebar link.

**Sprint output**: ~2000 lines of code, +44 tests (was 47 at sprint start, 91 at end), same 5-layer pattern proven for the second time. The "~3 days of focused work" the validation backlog (PR #42) estimated is done.

**Why two sprints in one day mattered**: the validator trilogy left two paths into the substrate via NetSuite ingestion blocked. Both are now end-to-end proven from JSON paste → DB writes → UI render. The cross-repo lineage triple — the architectural seam that connects denormalized source-system data (NS bank line's `matched_transaction_id`) to normalized substrate data (recon's `ReconciliationMatch` with FK to ledger-core's JournalLine) — is mechanically proven against real Postgres. **No more validator-only paper findings; the substrate accepts NetSuite data.**

### v0.2 — Universal substrate (Layer 1+2 + seams for 3–6)
- [x] Party + PartyRole (unified Customer/Vendor/Employee)
- [x] Item with itemType + costing method
- [x] Account with hierarchy, control-account flags, book-scope, lineage columns
- [x] JournalEntry / JournalLine with three-currency view + lineage + dimension slot
- [x] Dimension engine tables (no values seeded)
- [x] PostingRule table (no rules registered)
- [x] CustomFieldDefinition + `extensions Json` + GIN indexes
- [x] Multi-book scoped reports (TB, IS, BS) per (entity, book)
- [x] Invariant test suite with multi-book isolation

### v0.3 — Native sub-ledgers + Pattern 2 multi-book seed
- [x] ArOpenItem + ArApplication + lifecycle helpers (open / apply / write off / aging)
- [x] ApOpenItem + ApApplication (mirror of AR)
- [x] FixedAsset + FixedAssetBookAttributes with `runDepreciation` (STRAIGHT_LINE + MACRS_5_HY stub)
- [x] Lease + LeaseBookAttributes (ASC 842 classification slots) with `runLeaseStraightLineExpense` stub
- [x] RevenueContract + PerformanceObligation + RevenueContractBookAttributes with `runStraightLineRecognition`
- [x] Book-tax-difference report with heuristic permanent/temporary classification
- [x] Northwind seed rewritten — every entry posts to US_GAAP + US_TAX + IFRS in parallel
- [x] Northwind depreciation diverges: 36-mo SL (GAAP/IFRS) vs 60-mo SL (TAX) → $1,600 BTD by 6/30
- [x] Northwind Globex prepay diverges: accrual books defer, tax book recognizes immediately
- [x] Sub-ledger reconciliation invariants (sum of open = control account balance)
- [x] Schema ERD updated to two diagrams (core + sub-ledgers)

### v0.4 — Posting-rules engine + full ASC 842 + disposal + bad debt + fast-check
- [x] Posting-rules engine (`src/lib/accounting/posting-rules.ts`) with minimal `$.path` DSL, `${$.path}` interpolation, and `registerUniformRule` for the common multi-book case. Engine looks up the latest active rule per (sourceEventType, bookId), applies the template, and posts via `postJournalEntry`.
- [x] Full ASC 842 mechanics in `runLeaseAccounting`: lease commencement (Dr ROU, Cr Lease Liability at PV of payments), monthly amortization (combined JE Dr Lease Expense / Cr ROU / Cr Lease Liability), and cash payment (Dr Lease Liability / Cr Cash). Finance + cash-basis-tax classifications handled in the same function.
- [x] Fixed asset disposal flow (`disposeFixedAsset`) — catches up depreciation through disposal date, posts paired JE (Dr Cash, Dr Accum Dep, Cr Asset gross, Dr/Cr Gain-Loss), marks asset DISPOSED. Gain/loss diverges per book due to different accumulated depreciation balances.
- [x] AR bad debt write-off (`writeOffArItem`) now posts the paired JE (Dr Bad Debt Expense, Cr AR) so the AR-control = sum-of-open invariant holds after write-off.
- [x] Property-based tests via fast-check (`tests/property-based.test.ts`) covering: balanced entries always accepted with balancing TB; unbalanced entries always rejected; arbitrary sequences leave BS balanced; AR open-item invariant survives arbitrary application sequences.
- [x] New accounts wired: 1210 Allowance for Doubtful Accounts (contra-AR), 1600 ROU Asset, 2600 Lease Liability, 7400 Lease Expense — Operating, 7500 Bad Debt Expense, 8100 Gain/Loss on Disposal, 8200 Interest Expense.

### v0.5 — QBO mapping (validate-by-mapping milestone) + allowance-method bad debt
- [x] Sample QBO export fixture (`prisma/fixtures/qbo-sample.json`) modeled on the QBO REST API shape: Accounts, Customers, Vendors, Invoices, Bills, Payments, BillPayments, JournalEntries.
- [x] QBO type definitions (`src/lib/mappers/qbo/types.ts`) — hand-rolled from the QBO API docs to avoid the heavy SDK dependency.
- [x] Pure mapper functions (`src/lib/mappers/qbo/mappers.ts`): mapAccount, mapCustomer, mapVendor, mapInvoice, mapBill, mapPayment, mapBillPayment, mapJournalEntry. Side-effect-free; testable without a DB.
- [x] Import orchestrator (`src/lib/mappers/qbo/import.ts`): idempotent end-to-end. Imports accounts → parties → JEs → invoices (opens AR) → bills (opens AP) → payments (applies AR) → bill payments (applies AP). Layer 6 lineage on every row.
- [x] Reverse exporter (`src/lib/mappers/qbo/export.ts`): reads frozen sourcePayload from each lineage row and reassembles a QBO-shaped export. The roundtrip proof of the universal-schema thesis.
- [x] Allowance method for bad debt (`estimateBadDebtAllowance` + `writeOffArItem({ method: "ALLOWANCE" })`): build the allowance via Dr Bad Debt / Cr Allowance, then apply via Dr Allowance / Cr AR — no double-counting of bad debt expense.
- [x] Tests (`tests/qbo-mapping.test.ts`): structural invariants (counts, lineage populated, AR/AP sub-ledger sums match control account, idempotency), roundtrip equivalence via diffQboExports.
- [x] Allowance-method tests added to v0.4 features suite.
- [x] New doc `docs/qbo-mapping.md` explains the import/export flow + the lineage roundtrip guarantee.

### v0.6 — NetSuite mapping (ceiling test) + dimension engine exercise
- [x] Sample NetSuite fixture (`prisma/fixtures/netsuite-sample.json`) modeled on SuiteScript / SuiteAnalytics export shape with classes, departments, locations, a custom segment, custom fields on transactions/customers, invoices/bills/payments with line-level dimension assignments.
- [x] NS type definitions (`src/lib/mappers/netsuite/types.ts`).
- [x] Dimension engine helpers (`src/lib/mappers/netsuite/dimensions.ts`): `setupDimension`, `setupDimensionValue`, `getOrCreateDimensionSet` with deterministic order-insensitive hash. The first real workout of Layer 3.
- [x] Pure mappers (`src/lib/mappers/netsuite/mappers.ts`) covering account, customer, vendor, item, invoice, bill, customer payment, vendor payment, journal entry — each extracts line-level dimension assignments and entity-level custom fields.
- [x] Import orchestrator (`src/lib/mappers/netsuite/import.ts`): registers custom fields, sets up dimensions, then imports accounts → parties → items → JEs → invoices+AR → bills+AP → payments. Each line gets a `dimensionSetId` via the dedup engine.
- [x] Reverse exporter (`src/lib/mappers/netsuite/export.ts`) with the same lineage-replay pattern as QBO.
- [x] Tests (`tests/netsuite-mapping.test.ts`): hash determinism, structural counts, sub-ledger reconciliation, dimension-engine population assertions (4 dimensions, 9 values, 5 distinct DimensionSets including the dedup case where two identical JE lines share one set), per-line dimension assignments match input, aggregation-by-department produces correct revenue totals, custom-field round-trip, idempotency, full roundtrip equivalence.
- [x] New doc `docs/netsuite-mapping.md` — the ceiling-test companion to qbo-mapping.md.

### v0.7 — Next.js UI on top of the substrate
- [x] Tailwind config + global styles + accountant-friendly color palette (slate-leaning neutrals; emerald for positive numbers; red for negative).
- [x] Inline UI primitives (`src/components/ui/`): Card, Table, Button, Badge, Input, Select, EmptyState. No shadcn CLI dependency — kept inline so the bundle stays small and the components are auditable.
- [x] Singleton PrismaClient (`src/lib/db.ts`) compatible with Next.js HMR.
- [x] Scope cookie (`lc-scope` = `{entityCode, bookCode}`) read by Server Components via `getScope()`, written by the `setScopeAction` Server Action. Default scope: NORTHWIND / US_GAAP.
- [x] Root layout (`src/app/layout.tsx`) with sidebar nav + header showing the current scope and a BookSwitcher card.
- [x] Dashboard (`/`): KPI grid (Cash, AR open, AP open, Fixed-asset NBV, Revenue YTD, Expenses YTD, Net Income YTD, BTD vs US_TAX delta when scope = US_GAAP), recent journal entries table.
- [x] Chart of accounts (`/accounts`): grouped by AccountType, lineage badge per imported account, contra/control/bank flag badges.
- [x] Journal entries (`/journal-entries`): paginated table with date range filter via URL params; detail page (`/journal-entries/[id]`) shows balanced line table + the frozen `sourcePayload` JSON (the Layer 6 lineage payoff displayed verbatim).
- [x] Trial Balance (`/reports/trial-balance`): as-of date picker, balanced badge.
- [x] Income Statement (`/reports/income-statement`): period range, two-column revenue/expenses, net income panel.
- [x] Balance Sheet (`/reports/balance-sheet`): assets / liabilities / equity tables, A=L+E equation strip with balanced badge, retained earnings line.
- [x] Book–Tax Difference (`/reports/book-tax-difference`): from-book/to-book selector + period range, summary KPIs (book NI, tax NI, Δ), P&L and BS delta tables with classification badges (PERMANENT/TEMPORARY/UNCLASSIFIED).
- [x] Deployment guide (`docs/deployment.md`): Vercel + Neon end-to-end in ~10 minutes, including the Loom walkthrough script (6 beats, 2 minutes total).
- [x] `vercel.json` wires `prisma generate` into the build command.
- [x] Updated `.env.example` for Neon's `sslmode=require` connection string.

### v0.8 — Manual JE form + AR/AP application UI + demo reset
- [x] Seed refactored into a callable module (`src/lib/seed/northwind.ts`) exporting `seedNorthwind(prisma)`, `resetNorthwindData(prisma)`, and `resetAndReseedNorthwind(prisma)`. `prisma/seed.ts` becomes a thin script wrapper.
- [x] `/journal-entries/new`: Client Component (`new-entry-form.tsx`) with multi-line table, per-line side selector + account dropdown + party + description + amount, add/remove rows, live Σ Dr / Σ Cr / Δ totals memoized on every keystroke. Submit button disabled when unbalanced, missing accounts, or zero amounts. Backed by `createJournalEntryAction` Server Action which calls `postJournalEntry`, surfaces `UnbalancedEntryError` / `UnknownAccountError` / etc. inline, and redirects to `/journal-entries/[id]` on success.
- [x] `/ar` and `/ap` pages with per-row inline payment forms. Cash-account select (filtered to `isBank` accounts), amount (defaults to current balance), payment date. `applyArPaymentAction` and `applyApPaymentAction` post the cash JE and call `applyArPayment`/`applyApPayment` atomically.
- [x] `POST /api/admin/reset` endpoint gated by `ADMIN_TOKEN` env. Calls `resetAndReseedNorthwind(prisma)` and returns timing metrics. Fails closed with 503 if the token isn't set.
- [x] Sidebar nav extended with "New entry", "Open AR", "Open AP" links.
- [x] `docs/deployment.md` and `.env.example` updated for `ADMIN_TOKEN` usage + Vercel Cron schedule example.

### v0.9 — Cash Flow Statement + AR Aging + CSV exports
- [x] `getCashFlowStatement()` in `src/lib/accounting/reports/cash-flow.ts` — indirect method. Classification heuristic via account subtype + type: OPERATING_NONCASH (depreciation, amortization), OPERATING_WC (AR, AP, inventory, prepaid, accrued, deferred revenue, allowance, sales tax), INVESTING (fixed asset cost, accum dep contra, intangible, ROU), FINANCING (equity, lease liability, debt). Anything the heuristic can't place surfaces in an `uncategorized` array.
- [x] Reconciliation tie-out: computed netCashFlow vs actual Δ cash from the BS. `reconciles` boolean + `reconcilingDifference` decimal in the result. Mismatches surface in the page's badge + the uncategorized panel.
- [x] `/reports/cash-flow` page with Operating / Investing / Financing sections, reconciliation strip at the top, uncategorized panel when relevant.
- [x] `/reports/ar-aging` page using existing `arAging()` function. Bucket KPI cards + detail table with per-row days-overdue + bucket badges. Links to `/ar` for apply-payment.
- [x] CSV utility (`toCsv` in `src/lib/utils/csv.ts`) — RFC 4180-ish escaping for cells with commas / quotes / newlines.
- [x] CSV route handlers for all six reports: `/api/reports/{trial-balance,income-statement,balance-sheet,book-tax-difference,cash-flow,ar-aging}/csv?<params>`. Use the same scope cookie and search params as the corresponding pages.
- [x] "Download CSV" link on every report page.
- [x] Sidebar nav gains Cash flow and AR aging.
- [x] Tests (`tests/cash-flow.test.ts`): capital infusion only, all-AR no-collection (NI offsets Δ AR), capex + cash sale, depreciation add-back. All assertions verify `reconciles === true`.

### v1.0 — Multi-entity consolidation + AP aging + M-1/M-3 detail
- [x] `apAging()` function in `src/lib/accounting/sub-ledgers/ap.ts` (mirror of `arAging`).
- [x] `/reports/ap-aging` page + `/api/reports/ap-aging/csv` route — bucket KPI cards + detail with days-overdue badges, link out to `/ap` for paying bills.
- [x] Four new intercompany accounts in the chart: `1300 Due from Affiliates`, `2400 Due to Affiliates`, `4900 Intercompany Revenue`, `5900 Intercompany Expense` — with subtypes (DUE_FROM_AFFILIATE / DUE_TO_AFFILIATE / INTERCOMPANY_REV / INTERCOMPANY_EXP) that the consolidation engine recognizes for elimination.
- [x] `seedConsolidationDemo()` in `src/lib/seed/consolidation-demo.ts` — sets up ACME_GROUP parent + ACME_US + ACME_UK subs with capital, external revenue, and a $3k intercompany sale. Bundled into `pnpm db:seed`.
- [x] `getConsolidatedTrialBalance()` in `src/lib/accounting/reports/consolidation.ts` — walks `LegalEntity.parentEntityId` hierarchy, aggregates per-entity TBs, eliminates intercompany subtype accounts. Returns per-entity contributions + elimination summary + post-elim totals + `netIcImbalance` (non-zero = one side recorded without its counterparty).
- [x] `/reports/consolidation` page + `/api/reports/consolidation/csv` — per-entity contribution columns, IC elimination summary, consolidated TB with sign-corrected balances.
- [x] `getM3Detail()` in `src/lib/accounting/reports/m3-detail.ts` — wraps `getBookTaxDifference` and groups deltas by Form 1120 Schedule M-3 line (Depreciation, Bad debt, Lease accounting, Deferred revenue, Accrued liabilities, Inventory, Stock comp, Meals, State tax, Charitable, Other timing, Other permanent, Unclassified). Subtype-driven so QBO/NS imports work without code changes.
- [x] `/reports/m3-detail` page + `/api/reports/m3-detail/csv` — Permanent / Temporary / Unclassified summary cards, per-M3-line group cards with row detail.
- [x] Sidebar nav updated with Consolidation, AP aging, M-3 detail links.
- [x] Tests (`tests/consolidation.test.ts`): aggregation across subs, IC elimination (DUE_FROM + DUE_TO + IC Rev + IC Exp all cancel), IC imbalance detection, non-IC accounts pass through unchanged.

**Deliberately deferred (post-v1.0):**
- NS Accounting Books (multi-book parallel posting from one NS transaction) — niche refinement; deferred because it requires fixture + mapper expansion with low portfolio payoff.
- ASC 842 cash flow presentation polish — the indirect method shows the right total but mis-classifies lease principal. Real-world refinement, not a portfolio differentiator.

---

## v1.0 is the portfolio milestone. Beyond:

### v1.1 — Loom script + autocomplete polish (shipped 2026-05-21)
- [x] `docs/deployment.md` Loom walkthrough updated to 8 beats — adds the consolidation IC elimination demo (beat 7) and the M-3 depreciation grouping (beat 8). Total run time still ~3 minutes.
- [x] Account autocomplete on `/journal-entries/new` via native `<datalist>` (no new deps). Same datalist pattern for the party selector. User types code OR name and the browser filters; no need to scroll a 35-account dropdown.

### v1.2+ — ergonomics + polish (deferred)
- [ ] Keyboard shortcut for "+ Add line" (Tab from last cell)
- [ ] Recurring journal entry templates
- [ ] AR / AP aging with sortable columns
- [ ] Multi-currency revaluation
- [ ] FX gain/loss accounts wired into journal lines properly

---

## Open decisions

- **PostingRule template schema** — v0.4 ships a minimal `$.path` DSL. Resolved at the level needed for the seed; an expression sublanguage with arithmetic (`$.a + $.b * 0.1`) is a v0.5 candidate when QBO/NetSuite mapping needs it.
- **Cash flow statement** — deferred. Indirect method is the lift; direct method is non-trivial too. Probably v0.6.
- **Audit log with hash chaining** — out of scope until a real customer asks for it. The `JournalEntry.status = REVERSED` + immutability rule covers GAAP-level audit trail.
- **Auth** — still nothing. Portfolio demo gates discussion until UI lands.
- **Demo data reset** — once live demo is up, decide whether to reset to clean Northwind nightly so random visitors can't mess up the public demo.

---

## Decision log

- **2026-05-21** — Rebrand: `mini-ledger` → `ledger-core`. Repo rename in place; old URL auto-redirects. Reframes the project from "tiny correct ledger" to "universal substrate."
- **2026-05-21** — Locked: US + IFRS only (no per-country statutory); own sub-ledgers natively; QBO-floor, NetSuite-ceiling.
- **2026-05-21** — Locked: multi-book Pattern 2 (full parallel posting). Pattern 1 (derive other books from a primary) rejected.
- **2026-05-21** — Surrogate keys are UUIDs (`gen_random_uuid()`), not cuid. Currency PK is the ISO 4217 code (stable across systems).
- **2026-05-21** — v0.3 sub-ledger expansion: AR/AP open items are keyed per (entity, book). Cash-basis tax customers need per-book open-item lifecycles even when GAAP and TAX are usually identical.
- **2026-05-21** — Revenue recognition math: month-based, not day-based. Day-based drifts by pennies per period and breaks clean BTD demos.
- **2026-05-21** — Posting-rules engine DSL is intentionally minimal: `$.path` lookups + `${$.path}` interpolation. Arithmetic and conditionals are OUT. If a rule needs them, author it in TS directly. The rules engine exists to make ERP-event → GL mapping declarative + auditable, not to be a general-purpose computation language.
- **2026-05-21** — Bad debt write-off shipped with both methods. DIRECT remains the default for simplicity; ALLOWANCE is opt-in via `method: "ALLOWANCE"` and pairs with `estimateBadDebtAllowance` for full GAAP-conforming flow. Initial v0.4 plan was DIRECT-only; promoted ALLOWANCE forward in v0.5 because the schema (account 1210) was already wired.
- **2026-05-21** — QBO Account codes get the `Q` prefix in `code` to avoid colliding with the native chart (`1000`, `2000`, …). Original QBO Id is preserved in `sourceRecordId` for roundtrip integrity. Unified-chart imports (mapping QBO → native codes) are a manual reclassification step, not part of the automatic mapper.
- **2026-05-21** — `exportToQbo` is a lineage-replay function: it reads `sourcePayload` and reconstructs the export. No re-translation from ledger-core data because the original payload is preserved verbatim. This is the practical demonstration of why Layer 6 lineage requires the frozen raw payload (not just IDs).
- **2026-05-21** — NS dimension engine: dedup happens at the line scope via stable hash of sorted `(dimensionCode, valueCode)` pairs. The hash is the dedup key on `DimensionSet`, so two lines with identical assignments share one row. Hashing is plain string concatenation (`dim1:val1|dim2:val2|...`) not crypto — collision risk is essentially zero at our scale and the strings remain human-readable for debugging.
- **2026-05-21** — NS custom segments map to `Dimension` rows keyed by the uppercased internalid (`custcol_region` → `CUSTCOL_REGION`). Same engine handles built-in (CLASS/DEPARTMENT/LOCATION) and custom dimensions uniformly — no fixed columns, no schema migration needed when an NS tenant adds a 9th custom segment.
- **2026-05-21** — `dimensionSetId` is attached to `JournalLine` rows via a post-write update (`attachDimensionSets`) because `postJournalEntry` doesn't accept it in its input shape. Adding `dimensionSetId` to the input is a v0.7 enhancement; until then the NS orchestrator owns this small denormalization.
- **2026-05-21** — UI is read-only in v0.7. The manual journal-entry form needs a real-time debit/credit balance indicator + client-side reactivity, which warrants its own batch with proper interactive testing. Shipping the read-only surface first means the live demo is useful immediately for recruiters who just want to click around.
- **2026-05-21** — Multi-book / multi-entity switcher uses a single `lc-scope` cookie + a Server Action (`setScopeAction`) + `revalidatePath`. No client state, no URL params for scope — the cookie persists across sessions; URL params are reserved for report-specific filters (date ranges, book pairings on the BTD page).
- **2026-05-21** — Inlined UI primitives (Card/Table/Button/Badge/Input) instead of running the shadcn CLI. Trade-off: less polish, but the bundle stays tiny, the components are auditable, and there's no interactive setup step blocking `pnpm install`.
- **2026-05-21** — The new-entry form serializes its dynamic lines array to a single hidden `linesJson` input on every keystroke. Alternative was `name="lines[0][accountCode]"` style FormData, which requires more parsing logic in the Server Action and doesn't survive `FormData.getAll` ordering. JSON serialization is one line in the client, one parse in the action — net simpler.
- **2026-05-21** — `POST /api/admin/reset` fails closed when `ADMIN_TOKEN` is unset (503, not 401). Reasoning: a 401 implies the endpoint is operational but the token is wrong; 503 communicates "this endpoint is intentionally disabled in this deployment." Helps debug a missing env var faster.
- **2026-05-21** — Seed extracted to `src/lib/seed/northwind.ts` with `prisma` passed as a parameter. The script wrapper at `prisma/seed.ts` is the same shape as before — just 30 lines instead of 670. The reset endpoint imports the same module so there's exactly one Northwind definition.
- **2026-05-21** — Cash flow classification uses subtype-driven heuristics, not hard-coded account codes, so QBO/NS-imported charts work without code changes. The `uncategorized` panel is the safety net — any BS change the heuristic can't place surfaces in the UI with a note pointing at `src/lib/accounting/reports/cash-flow.ts` for the fix. Trade-off: classification is best-effort, not authoritative.
- **2026-05-21** — Decided NOT to add a `cashFlowCategory` enum column to `Account`. Reason: would either be redundant with `subtype` (which already drives this) or would require constant tuning per ERP import. Heuristic on `subtype + type + isBank` covers ~95% of normal accounts; the `uncategorized` panel handles the long tail explicitly.
- **2026-05-21** — Cash flow tests use controlled fixtures (capital infusion only / all-AR no collection / capex + sale / depreciation add-back) rather than the full Northwind seed because Northwind has the ASC 842 lease complications. The fixtures isolate one mechanic at a time and assert `reconciles === true` on each.

---

## Notes for the next session

**The 2026-05-25 → 2026-06-03 SOC 2 sprint + validator-to-shipping
continuation left 46+ PRs open across the 5-repo portfolio.** They
are all reviewable change packets per the `change-management.md`
v2.0 procedure; merge order is documented in `docs/MERGE_ORDER.md`
(PR #36) and in each PR's "Stacked on" line.

### Read this first
- `docs/SOC2_READINESS.md` v2.0 — the auditor's first-read; what's
  shipped vs what's customer-trigger-gated
- `docs/architecture/portfolio-data-locations.md` — the portfolio-
  wide data map
- `docs/policies/security.md` v2.0 — the umbrella that points at
  every sub-policy

### Headline build/test commands
- `pnpm test` — vitest suite (invariants + sub-ledgers + retention +
  encryption + soc2-helpers + pen-test-tenant-isolation + DSR
  attribution + companion-attribution wire-up)
- `node_modules/.bin/tsc --noEmit` — type check; **clean across all 5
  repos as of 2026-06-04** (recon PR #14 + integrations/fa-amort/
  revenue-rec tsc-middleware-test PRs closed the last TS18049 holdouts;
  deficiency-log #13 v2.0 → Closed in v2.1)

### Customer-event-gated upgrades (NOT in scope until trigger)
- First paying customer signs → Neon Launch ($19/mo) + PITR + `pg_dump`
  cron + quarterly DR drill (closes risk-register #19 + #6 + deficiency
  #3)
- First customer requiring negotiated terms OR first EU customer →
  signed (non-clickthrough) DPAs with Tier 1 vendors (closes
  deficiency #15)
- Customer requiring IP-anomaly alerting → paid Sentry DSN provisioning
  (closes deficiency #5)
- 10+ paying customers or EU customer → multi-region read replica
  + audit-log replication
- Second employee → separate Security Officer role; access-control
  solo-dev compensating-controls section flips off; quarterly access
  review now has two participants

### Open code-side deficiencies (close any time)
- ~~#13~~ — closed portfolio-wide via recon PR #14 + integrations PR #16 + fa-amort PR #17 + revenue-rec PR #16 (all on `tsc-middleware-test` branches)
- #14 — retention cron lives only on a branch (PR #12 merge closes
  this; load-bearing for the documented Privacy TSC retention claim)
- #16 — `/legal/subprocessors` page on marketing site
- ~~#17~~ — closed by PR #33 (`public/.well-known/security.txt`)
- ~~#19~~ — closed by PR #35 (SBOM CI)
- ~~#21~~ — closed by PR #34 (schema-fingerprint CI gate)
- ~~#24~~ — closed by 10-PR DSR end-to-end arc (new in v2.1 deficiency log)
- #25 — fa-amort schema lacks user-attribution columns (NEW, Low; honest-zero delegation documented)
- #26 — revenue-rec schema partially lacks attribution columns (NEW, Low; hybrid 2/5 documented)

### Substantive engineering deferred to dedicated sprints
- ~~**revenue-rec NetSuite schema additions**~~ — **SHIPPED 2026-06-05** as a 7-PR end-to-end sprint (PRs #17-#23). Schema additions (`allocatedAmount` + `allocationMethod` + `fairValueMethod` + `quantity`) + pure mappers + orchestrator + integration tests + Server Action + UI. Closes the deficiency #26 documented half. The follow-up "`acceptedBy`/`rejectedBy` on `AiExtractionSuggestion` to flip the hybrid attribution helper from 2/5 wired to 5/5" remains the trailing item.
- ~~**recon model-translation work**~~ — **SHIPPED 2026-06-05** as a 5-PR end-to-end sprint (PRs #17-#21). Denormalized NS `matched_transaction_*` → normalized recon `ReconciliationMatch { source: MANUAL, status: APPROVED }` via cross-repo lineage-triple lookup against ledger-core's JournalLine. Integration tests vs real Postgres prove the lookup completes end-to-end. UI surfaces the distinctive "matches deferred" outcome for the graceful-degradation case (GL document not yet imported).
- ~~**`connections-export.ts` typed-stub wiring**~~ — **shipped 2026-06-04** in the DSR end-to-end arc (integrations PR #14 + recon PR #15 + fa-amort PR #15 + revenue-rec PR #14 producer helpers; ledger-core PR #46 consumer; 4 HTTP endpoint PRs; ledger-core PR #47 e2e smoke). Helpers now walk live tables with per-companion shape and graceful-degradation flags. Closes the original "typed stub" item end-to-end.

### Remaining substantive backlog (post-2026-06-05)
- **fa-amort attribution wire-up** — full closure of deficiency #25 requires schema additions (`createdBy` on FixedAsset; `acceptedBy`/`rejectedBy` on AiAssetSuggestion; a DepreciationRun audit table). The honest-zero helper today delegates to ledger-core's audit_log; trigger to close is "fa-amort grows data the audit_log can't capture" (e.g., AI capex-decision audit).
- ~~**revenue-rec AI-decision schema for AiExtractionSuggestion**~~ — **SHIPPED 2026-06-05 evening** as a 3-PR closure arc (revenue-rec #21 + #24 + #25). v2.1 deficiency #26 marked **Closed** in v2.2 deficiency log (ledger-core PR #54). Helper flipped from hybrid (2/5 wired) → full-wire (4/5 wired + 1 documented audit_log delegation). The remaining 1 (`revenueContractsCreated`) is genuinely delegated to ledger-core's audit_log; AI-extraction-approved contracts surface via `approveExtractionAction`'s audit emission.
- ~~**NS reverse exporters**~~ — **SHIPPED 2026-06-05 evening** for BOTH NS domains: revenue-rec #26 + recon #22. Reads `sourcePayload`/`rawPayload` back + reconstructs the original NS bundle; `diffNsRevenueExports` / `diffNsReconExports` helpers prove semantic-equality roundtrip. **The universal-schema "validate by mapping" thesis is now mechanically demonstrated for both NS domains.** Lineage break safety: 3 explicit failure modes handled gracefully (non-NS filename → skipped, JSON.parse failure → counted, non-`NS-BANK-` prefix → skipped + warned). Documented exemptions: `exported_at` + template `rec_method` not recoverable + `(unresolved)` placeholder when GL Account / Subsidiary weren't bootstrapped via NS.
- **OVER_TIME_USAGE + OVER_TIME_MILESTONE recognition implementations** — `schedule.ts` accepts the patterns (PR #20) and returns empty; the actual usage-event-driven + milestone-driven recognition engine is ~2 days each.

### Substrate notes (still current)
- Architecture canon: `docs/universal-schema.md`. Schema visual:
  `docs/schema-erd.md`.
- Tests need a live Postgres at `DATABASE_URL`.
- Seed data dependencies: `pnpm db:push && pnpm db:seed`. Reset with
  `pnpm db:reset`.
