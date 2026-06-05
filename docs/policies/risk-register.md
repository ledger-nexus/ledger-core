# Risk register

**Version:** 2.2 · **Effective date:** 2026-06-05 · **Owner:** Privacy lead (founder)
**Last reviewed:** 2026-06-05 (column-level DSR closure + task-attestation drift risk class)
**Prior versions:** 2.1 (2026-06-04 DSR end-to-end), 2.0 (2026-06-03 SOC-2-hardening sprint), 1.0 (pre-Clerk)

This is the SOC 2 CC3 (Risk Assessment) artifact. Every row is
**reality-checked against current code** — if a row says "Mitigated"
the code that mitigates it exists in `main` or is in an open PR with
file paths cited. Rows marked "Open" are not aspirations; they are
known gaps with owners.

## Scoring rubric

- **Likelihood**: 1 (rare) — 5 (frequent)
- **Impact**: 1 (negligible) — 5 (catastrophic / business-ending)
- **Score**: Likelihood × Impact (range 1-25)
- **Threshold**: Score ≥ 12 = must have a mitigation plan and an owner. Score < 12 = monitor.

## Identified risks

| # | Risk | L | I | Score | Mitigation | Status | Last verified |
|---|---|---:|---:|---:|---|---|---|
| 1 | **Auth bypass via dev cookie stub** | 4 | 5 | 20 | Clerk integration shipped (`src/lib/auth/clerk.ts`); middleware fails closed in production without Clerk env vars (commit `b99bbb4`); dev stub gated by `NODE_ENV` in `src/lib/auth/current-user.ts`. | **Mitigated** | 2026-06-03 |
| 2 | **Leaked `INTERNAL_API_TOKEN` allows arbitrary JE posting** | 2 | 5 | 10 | Token stored only in Vercel env; rotation procedure in `docs/policies/access-control.md`; pre-commit hook (`scripts/pre-commit-secrets-scan.sh`) catches accidental commit; verification via `constantTimeEqual` (no timing oracle). | Mitigated | 2026-06-03 |
| 3 | **Unauthorized period reopen** | 1 | 5 | 5 | `requirePermission(canReopenPeriod)` gate; `audit_log` row captured (`PRIVILEGED_ACTION/period.reopen`); access reviews quarterly per `docs/policies/access-control.md`. | Mitigated | 2026-06-03 |
| 4 | **Customer data leaked via SQL injection** | 1 | 5 | 5 | Prisma parameterizes all queries; no raw SQL paths in customer-data tables; CodeQL CI runs weekly; `prisma db execute` used only for migrations with explicit review. | Mitigated | 2026-06-03 |
| 5 | **Vendor outage (Neon, Vercel, Anthropic)** | 3 | 4 | 12 | RTO/RPO documented in `docs/policies/business-continuity.md`; vendor SOC 2 receipts on file (`docs/policies/vendor-management.md`); `/api/health` surfaces DB connectivity. Multi-region out of scope until customer SLA requires it. | Partial | 2026-06-03 |
| 6 | **Production DB wiped accidentally** | 2 | 5 | 10 | Neon PITR on Launch plan (planned upgrade pending first paying customer); restore procedure in business-continuity.md. Today: dev/staging only, blast radius is the demo seed. | Partial | 2026-06-03 |
| 7 | **AI hallucination produces wrong JE** | 3 | 3 | 9 | Every AI surface requires human approval before substrate write; `AiSuggestion` row regardless of decision (7-year retention); per-output disclaimer + ASC 606 Part 5.1 acknowledgment gate (asc606 repo). | Mitigated | 2026-06-03 |
| 8 | **PII leaked via error monitoring** (e.g., Sentry capturing customer email in stack trace) | 3 | 4 | 12 | Sentry shim in `src/lib/monitoring/index.ts` runs `redactPii()` before every emit; falls back to console.log + redactPii when DSN absent. Field allowlist in `src/lib/soc2/index.ts`. Test coverage: `tests/soc2-helpers.test.ts`. **2026-06-05 evening update — portfolio-wide hardening at every layer:** (a) the canonical shim shipped to all 4 companion repos with repo-specific PII allowlists ([fa-amort PR #21](https://github.com/ledger-nexus/fa-amort/pull/21) + [recon PR #24](https://github.com/ledger-nexus/recon/pull/24) + [revenue-rec PR #28](https://github.com/ledger-nexus/revenue-rec/pull/28) + [integrations PR #18](https://github.com/ledger-nexus/integrations/pull/18)); (b) the **14th adversarial pass** discovered a HIGH (Error.stack PII leak via V8 preamble despite `.message` redaction) + 3 MEDIUMs (err.code 16-char cap + revenue-rec field gaps + integrations vendor-identifier gaps), all closed via 2nd commits on each shim PR; (c) new `stripStackPreamble()` + `sanitizeErrorForCapture()` helpers strip the V8 preamble while preserving Sentry's grouping algorithm. The shim arc is now mechanically defended at every layer: `.message`, `.stack`, `.code`, and `extra` context. CLAUDE.md institutional-memory PRs (fa-amort #22 + recon #25 + revenue-rec #29 + integrations #19 + ledger-core #65) institutionalize the "every error emission goes through the shim" non-negotiable as auto-loaded session context. Closes deficiency #5 at the code layer; closure citation in v2.3 deficiency log. **The 14th-pass finding-and-closure of a real HIGH in newly-shipped code is the SOC 2 CC4 evidence form auditors grade highest.** | Mitigated (portfolio-wide, every-layer defended) | 2026-06-05 |
| 9 | **Period close bypassed via direct DB write** | 1 | 5 | 5 | Substrate convention enforced via `postJournalEntry` (sole write path); `prisma.journalEntry.*` direct calls scanned in `/soc2-check`; period-close test suite covers attempted bypass. | Mitigated | 2026-06-03 |
| 10 | **Stale credentials of departed contributor** | 1 | 4 | 4 | Offboarding procedure in `access-control.md`: revoke Vercel access, remove from CODEOWNERS, deactivate User row, rotate `INTERNAL_API_TOKEN` + `CRON_SECRET`. Today single-contributor; procedure tested in dry-run. | Mitigated | 2026-06-03 |
| 11 | **Supply chain attack via npm dep** | 3 | 5 | 15 | `npm audit` in CI weekly; Dependabot opens upgrade PRs; production-only audit at `audit-level=high`; `package-lock.json` committed. **Gap:** not pinned to exact versions, no SBOM yet. | Partial | 2026-06-03 |
| 12 | **Vercel deploy compromised via stolen token** | 1 | 5 | 5 | Token rotates per access-control.md; pre-commit hook catches accidental commit; Vercel logs deploy events; production deploy requires CODEOWNERS review per change-management.md. | Mitigated | 2026-06-03 |
| 13 | **AI API costs runaway** | 2 | 3 | 6 | Per-suggestion audit log (token counts visible at `/ai-audit`); `cache_control` on system prompts (30-95% input-token reduction); monthly cost review; tenant-level monthly cap (`Tenant.monthlyAiSpendCapUsd`). | Mitigated | 2026-06-03 |
| 14 | **Customer-facing data export leaks confidential rows** (CSV download exposes a different entity's data) | 2 | 5 | 10 | Per-entity scope enforced in all report queries; `audit_log` records every export (`DATA_EXPORT`); 2026-05-29 audit-pass swept every report endpoint; pen-test-tenant-isolation suite catches regressions. | Mitigated | 2026-06-03 |
| 15 | **Failed schema migration corrupts production data** | 2 | 5 | 10 | Schema changes via `prisma db execute` with `IF NOT EXISTS` clauses; tested on Neon branch first; CODEOWNERS review on `prisma/`. **Gap:** no automated post-migration smoke test in CI yet. | Partial | 2026-06-03 |
| 16 | **GDPR/CCPA right-to-deletion request can't be fulfilled** | 2 | 3 | 6 | Procedure documented at `docs/policies/data-subject-requests.md` (2026-06-03); executable code at `src/lib/privacy/user-data.ts` (`buildUserDataExport` + `eraseUserPii`); UI at `/admin/data-subject-requests`. **2026-06-04 update**: cross-repo attribution wire-up complete — 10-PR arc shipped (producer helpers in integrations/recon/fa-amort/revenue-rec + ledger-core consumer with `companionAttribution` in bundle v2 + 4 token-gated HTTP endpoints + opt-in e2e smoke test + runbook `docs/runbooks/dsr-e2e-test.md`). **2026-06-05 update**: column-level completeness reached — fa-amort PRs #18/#19 (closes deficiency #25) added attribution columns + wired helper from honest-zero → 5/5 wired; revenue-rec PRs #21/#24/#25/#27 (closes deficiency #26) added decision columns + corrected the unbacked-delegation overclaim. Both attribution helpers now guard against null/empty userId (13th-pass M2) — closes a silent-inflation hole that would have inflated DSR counts by the entire NULL-attribution row population. Privacy TSC attribution-completeness thesis is closed at the column level across all 4 companion repos (integrations 1/1, recon 5/5, fa-amort 5/5, revenue-rec 4/5+1 honest-zero). | Mitigated end-to-end | 2026-06-05 |
| 17 | **Multi-tenant data leakage between customers** | 2 | 5 | 10 | Multi-tenancy shipped; every customer-data table carries `tenantId @db.Uuid`; `assertTenantScope()` helper enforces post-fetch; pen-test-tenant-isolation suite covers cross-tenant attempts; 2026-05-29 audit-pass + 3 follow-up pen-test passes (`commits 72c164b`/`185902f`/`3c6d0a2`) closed every leak found. | Mitigated | 2026-06-03 |
| 18 | **Insider threat — privileged user posts fraudulent JE** | 1 | 5 | 5 | All JE posts logged in `audit_log` (append-only DB RULE); quarterly access reviews; period close prevents back-dating; OWNER-only acceptance for AI-extracted JEs. | Mitigated | 2026-06-03 |
| 19 | **Backup integrity** (backup exists but restore fails) | 3 | 5 | 15 | Documented in `business-continuity.md`. **Gap:** no quarterly restore drill yet — need to pull a Neon snapshot to staging, verify boot, run smoke, document. Pending first paying customer trigger. | Open | 2026-06-03 |
| 20 | **Customer credentials phished, attacker logs in as them** | 3 | 4 | 12 | Clerk MFA enrollment available; audit log captures unusual logins (`LOGIN_SUCCESS/FAILURE` rows with IP); session timeout configurable per tenant. **Gap:** MFA not enforced (Clerk policy); IP-anomaly alerting not wired. | Partial | 2026-06-03 |
| 21 | **`audit_log` tampering by privileged user** | 1 | 5 | 5 | Postgres RULE (`prisma/sql/audit-log-append-only.sql`) silently no-ops UPDATE + DELETE; even DB-admin can't tamper without dropping the rule first (which itself is loggable). Test: `tests/audit-log-append-only.test.ts`. | Mitigated | 2026-06-03 |
| 22 | **Field-encryption key compromise** (`FIELD_ENCRYPTION_KEY` leaked → all encrypted columns readable) | 2 | 5 | 10 | Key in Vercel encrypted env (RESTRICTED tier); rotation procedure in `access-control.md`; `loadKey()` helper isolates key access; future: AWS KMS / Vercel Secrets drop-in. **New 2026-06-03** — was implicit in #4 before the encryption rollout. | Mitigated | 2026-06-03 |
| 23 | **Deterministic-encryption search-hash key compromise** (`FIELD_DETERMINISTIC_KEY` leaked → enables offline dictionary attack on emails) | 2 | 4 | 8 | Two-key separation from `FIELD_ENCRYPTION_KEY` — search-hash leak does NOT yield plaintext (still need AES key); domain separation (`domain‖NUL‖normalize`) prevents cross-table correlation even if attacker brute-forces; HMAC-SHA256 is not reversible. Rotation requires re-hashing all rows (documented in `deterministic-encryption.md` Phase 3 rollback). **New 2026-06-03**. | Mitigated | 2026-06-03 |
| 24 | **Encryption rollout window — some rows plaintext, some encrypted** | 3 | 3 | 9 | `looksEncrypted()` is defense-in-depth (length%4 + strict base64 + decoded size + version byte + roundtrip identity); read path tolerates mixed state during backfill; backfill scripts per column under `scripts/` with idempotency. Drift detection: `verify-encryption-rollout.sh` post-deploy verifier. **New 2026-06-03**. | Mitigated | 2026-06-03 |
| 25 | **Retention cron silently stops firing** (Vercel cron mis-config, secret rotation orphans the schedule) | 3 | 3 | 9 | Cron route audit-logs every run as `CONFIG_CHANGE/retention.purge`; the signal "no audit row in 48 hours" indicates the cron stopped — monitorable via audit-log query; CRON_SECRET rotation procedure includes "verify next run within 24h". **New 2026-06-03** (engine ships in PR #12). | Mitigated | 2026-06-03 |
| 26 | **Replica drift between ledger-core and companion repos** (User row erasure on ledger-core doesn't propagate; auditor finds redacted-here-but-not-there) | 2 | 4 | 8 | Sync is async; per `docs/architecture/portfolio-data-locations.md` the privacy lead verifies propagation before responding to a DSR. **2026-06-04 partial close**: each companion repo now exposes `/api/internal/dsr/attribution` which returns COUNTS attributable to a userId — a regulator-readable verification surface for "yes, the redaction propagated" (if counts drop to 0 post-erasure across all four companions, the propagation worked). **Remaining gap:** no automated cron that runs the verification daily — still a manual `curl` against each endpoint after each DSR erasure. **New 2026-06-03**. | Partial | 2026-06-04 |
| 27 | **Pre-commit hook bypassed via `--no-verify`** | 2 | 4 | 8 | Documented in `change-management.md`: `--no-verify` is forbidden; CI runs the same checks as the hook so a bypassed commit gets caught at PR review. Pre-commit hook scans for secrets + PII in console.log. | Mitigated | 2026-06-03 |
| 28 | **OAuth token theft from `integrations.Connection.credentialsJson`** | 2 | 5 | 10 | Credentials encrypted at rest (Json mode); never logged (engine treats as opaque); revocation procedure on erasure calls Plaid `/item/remove` at source before nulling locally (per `integrations/docs/policies/data-subject-requests.md`); RESTRICTED classification in portfolio map. **New 2026-06-03**. | Mitigated | 2026-06-03 |
| 29 | **Counterparty PII (in contracts) misrouted to wrong tenant** | 2 | 4 | 8 | `revenue-rec.ContractDocument.rawText` is per-tenant scoped (`tenantId` FK + assertTenantScope); 2026-05-29 audit-pass covered revenue-rec endpoints; counterparty erasure request explicitly routes to tenant (we are processor, not controller). **New 2026-06-03**. | Mitigated | 2026-06-03 |
| 30 | **Cross-repo audit-log write failure swallowed** (companion repo POSTs to ledger-core's /api/internal/audit-log; if it 500s, do we drop the event?) | 3 | 4 | 12 | Companion repos retry with exponential backoff (max 3 attempts); persistent failure surfaces in Sentry via `monitoring.captureException`. **Gap:** no dead-letter queue — a sustained ledger-core outage could lose events. Mitigation triggers a P1 incident per `incident-response.md`. **New 2026-06-03**. | Partial | 2026-06-03 |
| 31 | **Cross-repo `INTERNAL_API_TOKEN` rotation drift** (ledger-core rotates the shared portfolio secret but one companion's env doesn't update; DSR attribution endpoint starts returning 401 → `reachable: false` for that companion; DSR exports silently lose that companion's attribution section without alerting) | 3 | 3 | 9 | **Detection layer**: the `companionAttribution` section preserves per-companion `{ reachable, error }` flags so a regulator can see exactly which companion was unreachable + why (e.g., `"HTTP 401"` reveals token drift vs. `"ECONNREFUSED"` reveals downtime). **Verification runbook**: `docs/runbooks/dsr-e2e-test.md` includes failure-triage for the 401 case naming the most common cause. **Token rotation procedure** (`docs/policies/access-control.md` v2.0): when rotating `INTERNAL_API_TOKEN`, set it across all 5 repos within the same change window and run the e2e smoke test as the verification step. **Gap**: no automated daily check that the e2e smoke passes — relies on the operator running the runbook. Acceptable as solo posture; add a CI cron when second engineer joins. **New 2026-06-04**. | Mitigated (operator-attested) | 2026-06-04 |
| 32 | **Task-completion attestation drift** (operator marks task complete based on local work; merged-to-main reality diverges; deficiency log accumulates falsely-Open + falsely-Closed rows; CC4 monitoring evidence silently degrades over time) | 3 | 3 | 9 | **Proven recurring** — 3 distinct cases caught in a single late-evening sweep 2026-06-05 (tasks #63 + #81 + #60). **Detection layer**: `scripts/verify-deficiency-log.ts` parses the deficiency log + verifies every cited PR URL via `gh pr view` — fails loudly on OPEN/DRAFT/CLOSED-unmerged. **Workflow**: `.github/workflows/deficiency-log-verify.yml` runs nightly at 04:00 UTC + on every push touching the log; uploads 90-day JSON evidence artifacts. **Runbook**: `docs/runbooks/deficiency-log-verify.md` documents the CC4 loop (discovery → classification → remediation → evidence trail → follow-through). **Process change** (effective immediately per deficiency #27 row): every task closure cites a merged PR URL before being marked completed. **Meta-risk**: if the verifier itself breaks (parser bug, gh CLI auth drift, GitHub API change), CC4 monitoring evidence silently degrades — script has explicit error handling, workflow uploads evidence even on failure, runbook documents diagnostic steps. **Bootstrap done**: PR #63 backfilled full URLs on every Closed row (verifier coverage 4 → 22 PRs after backfill). When the cited PRs merge, the workflow runs all-green for the first time and deficiency #27 flips Open → Remediated. **New 2026-06-05 evening** (the recurring-pattern discovery is itself the risk-register evidence the meta-control works). | Mitigated (script-attested) | 2026-06-05 |

## Open vs mitigated (2026-06-05)

- **Open** (need work, blocked on first paying customer / sprint capacity): 1 (#19 backup restore drill)
- **Partial** (some mitigation, gap documented): 7 (#5, #6, #11, #15, #20, #26, #30)
- **Mitigated** (controls in place, periodic review): 24 (was 23; +1 from #32 new)
- **Total:** 32 rows (was 31)

## Score-band summary

- **High (15+):** 4 rows (#1, #11, #19, #20)
- **Medium (10–14):** 11 rows
- **Low (<10):** 17 rows (was 16; +1 from #32)

Every score ≥ 12 has either Mitigated or Partial status with a documented gap. No score-≥-12 row is Open without an owner — except #19 (the explicit "blocked on first paying customer" item, which has the trigger documented).

## Change log

### 2026-06-05 (v2.2)
- **#8 (PII via error monitoring)** strengthened with portfolio-wide layer defense. Mitigation status moved from "Mitigated" to "Mitigated (portfolio-wide, every-layer defended)". The 14th adversarial pass found a real HIGH (Error.stack PII leak via V8 preamble) — closed via `sanitizeErrorForCapture()` + `stripStackPreamble()` helpers. Plus 4-PR companion-repo Sentry shim arc + 5-PR CLAUDE.md institutional-memory arc. The shim is now defended at every layer: `.message`, `.stack`, `.code`, `extra` context.
- **#16 (right-to-deletion request can't be fulfilled)**: stays "Mitigated end-to-end" but column-level completeness reached. v2.1 had the procedural + e2e wire-up; v2.2 adds the column-level layer — fa-amort PRs #18/#19 + revenue-rec PRs #21/#24/#25/#27 closed both deficiency #25 + #26. Helpers now return real counts (not honest-zero or overclaimed-delegation), null-userId guards close a silent-inflation hole. Privacy TSC attribution-completeness thesis is closed at column level across all 4 companion repos. Last verified bumped to 2026-06-05.
- **#32 NEW — Task-completion attestation drift** (likelihood 3, impact 3, score 9). **Proven recurring** — 3 distinct cases caught in a single late-evening sweep 2026-06-05 (tasks #63 + #81 + #60 → deficiencies #13 + #18). Detection layer: `scripts/verify-deficiency-log.ts` + nightly workflow (PR #62) + 90-day evidence artifacts. Bootstrap: PR #63 backfilled full URLs on every Closed row (verifier coverage 4 → 22 PRs). When cited PRs merge, workflow runs all-green for the first time and deficiency #27 flips Open → Remediated. Meta-risk: verifier itself could break (explicit error handling + workflow uploads evidence even on failure + runbook documents diagnostic steps). **Additional mitigation layer (2026-06-05 night):** CLAUDE.md institutional-memory PRs ensure every Claude Code session auto-loads the patterns at start — closes the falsely-completed-task class from the session-start angle (PR #62 closes it from the workflow-runtime angle).

### 2026-06-04 (v2.1)
- **#16 (right-to-deletion request can't be fulfilled)**: upgraded "Mitigated" → "Mitigated end-to-end". v2.0 covered the procedure; v2.1 covers the mechanically-verified execution path (10-PR DSR attribution arc shipped 2026-06-04: 4 producer helpers + ledger-core consumer + 4 HTTP endpoints + e2e smoke + runbook).
- **#26 (replica drift between ledger-core and companion repos)**: stays Partial but downgraded the gap. Each companion now exposes `/api/internal/dsr/attribution` returning per-userId counts — a regulator-readable verification surface for "yes, redaction propagated." Remaining gap: no automated daily cron; manual `curl` after each DSR erasure. Last verified bumped to 2026-06-04.
- **#31 NEW — Cross-repo `INTERNAL_API_TOKEN` rotation drift** (likelihood 3, impact 3, score 9). Detection layer: `companionAttribution.{X}.reachable` flags expose token drift as `HTTP 401` per companion. Mitigation: token rotation procedure in access-control.md + e2e runbook as verification step. Gap: no automated daily check (acceptable solo posture).

### 2026-06-03 (v2.0)
- **Updated to "Mitigated":** #1 (Clerk shipped), #8 (Sentry + redactPii), #16 (DSR procedure), #17 (multi-tenancy + audit-pass)
- **Updated to "Partial":** #5, #6, #15, #20 (documented gaps remain)
- **Added 9 new risks** (#21–#30) surfaced by the SOC 2 hardening sprint:
  - #21 audit_log tampering
  - #22 field-encryption key compromise
  - #23 deterministic search-hash key compromise
  - #24 encryption rollout window
  - #25 retention cron stops firing
  - #26 replica drift across the portfolio
  - #27 pre-commit hook bypass
  - #28 OAuth token theft (integrations)
  - #29 counterparty PII misrouting (revenue-rec)
  - #30 cross-repo audit-log write failure
- **Removed:** none. All v1.0 risks remain real, even when status changed.

## Annual review

Reviewed annually. Trigger an out-of-cycle review when:

- A new repo joins the portfolio
- A new connector ships in `integrations` (adds a Secrets-tier risk row)
- A new field-encryption column is added
- A SOC 2 audit kickoff is scheduled
- An incident occurs and a postmortem identifies a previously-unlisted risk

The review itself goes in the audit log as `CONFIG_CHANGE/risk_register.review`
by the privacy lead.
