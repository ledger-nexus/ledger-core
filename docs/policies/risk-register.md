# Risk register

**Version:** 2.4 · **Effective date:** 2026-06-06 · **Owner:** Chris

**v2.4 amendments (2026-06-06) — 2026-06-06 day capstone (4 deficiency closures):**
- **Risk #11 (Supply chain attack via npm dep)** Partial → Mitigated, score 15 (3 × 5) → 6 (2 × 3). The deficiency #4 portfolio-wide closure (Group V, 5 PRs pinning 115 ranges) eliminates the silent-transitive-upgrade attack vector on every `npm ci` deploy. Remaining likelihood (2) reflects social-engineering risk on a Dependabot PR review (we approve a malicious upgrade thinking it's a benign patch). Remaining impact (3) reflects that any compromised dep would still face encryption-at-rest + RLS + audit-log defense-in-depth.
- **Risk #8 (PII leaked via error monitoring)** Future → Mitigated, score 12 (3 × 4) → 6 (2 × 3). Sentry shim portfolio-wide (Group S, PRs #56-#59 — deficiency #5 closure) now wraps every emit with `redactPii` allowlist before transmit + `stripStackPreamble` defense against V8 preamble leaks (14th adversarial pass closure). PII allowlists are repo-specific (ledger-core: memo/displayName; recon: bank fields; revenue-rec: rawText carve-out; integrations: OAuth tokens + credentialsJson). 5/5 portfolio coverage.
- New **Risk #22 (XSS via inline script injection)** added with score 6 (2 × 3) — Mitigated. PR #99 CSP closure (Group W) ships per-request 16-byte base64url nonce + `strict-dynamic` script-src + `frame-ancestors 'none'` + `object-src 'none'` + `upgrade-insecure-requests`. Defense-in-depth with Next.js's framework-level escape + static security headers. Remaining likelihood (2) reflects that CSP can't catch every server-side templating bug; impact (3) is bounded by audit_log + encryption at rest.
- New **Risk #23 (Audit-trail loss on substrate failure)** added with score 8 (2 × 4) — Mitigated. PR #104 audit-log-replication design (Group X) captures Phase 1 architectural commitment to S3 + Object Lock compliance mode + 7-year retention. Phase 2 implementation deferred until customer #2 onboards. Pre-Phase-2 mitigation: substrate runs on Neon Launch tier with PITR (deficiency #6 in remediation plan); audit-log RULE on PR #10 prevents tampering within the live DB. Post-Phase-2 mitigation: substrate loss recoverable via S3 archive replay.

**v2.3 amendments (2026-06-05) — RLS arc closure:**
- **Risk #17 (Multi-tenant data leakage)** transitions from "Future" → "Mitigated" with score recomputed (4 × 5 = 20 was the latent worst-case once multi-tenancy lands; current state: 1 × 5 = 5). Mitigation chain: (a) Phase 4b applied NOT NULL on tenantId across 26 tables (deficiency #11 closure); (b) RLS Phase 1 (PR #66) shipped 39 per-table policies; (c) RLS Phase 2a+2b (PRs #67 + #69-#83) migrated 23 Server Actions + 3 HTTP routes + 1 batch helper to `withTenantContext`; (d) Phase 3 design + bypass-role runbook + decisions A/B/D resolved (PR #84); (e) Decision A/B prereqs landed (PRs #85, #86); (f) PR #88 closed the historical createFixedAsset tenant-blind lookup; (g) Phase 3 implementation DRAFT (PR #89) awaits operator ack on Decision C runbook for final FORCE flip. Audit-trail discipline: 15th adversarial pass found 1 HIGH + 3 MEDIUMs all closed in-PR before merge.
- New **Risk #21** (Phase 3 FORCE flip causes production data-disappearance bug if a missed call site goes unwrapped) added with score 2 × 4 = 8, mitigated by the 6-category cross-tenant test suite (env-gated via RLS_FORCE_ENABLED=1) PLUS the staged rollout per `docs/architecture/rls-phase-3-design.md`.

## Scoring rubric

- **Likelihood**: 1 (rare) — 5 (frequent)
- **Impact**: 1 (negligible) — 5 (catastrophic / business-ending)
- **Score**: Likelihood × Impact (range 1-25)
- **Threshold**: Score ≥ 12 = must have a mitigation plan and an owner. Score < 12 = monitor.

## Identified risks

| # | Risk | Likelihood | Impact | Score | Mitigation | Owner | Status |
|---|---|---:|---:|---:|---|---|---|
| 1 | **Auth bypass via dev cookie stub** | 4 | 5 | 20 | Replace with Clerk/NextAuth (see auth-swap.md). Currently mitigated by "not yet in production with real customers." | {{NAME}} | Open |
| 2 | **Leaked `INTERNAL_API_TOKEN` allows arbitrary JE posting** | 2 | 5 | 10 | Token stored only in Vercel env; rotation procedure in access-control.md; gitleaks CI catches accidental commit. | {{NAME}} | Mitigated |
| 3 | **Unauthorized period reopen** | 1 | 5 | 5 | requireAdmin gate; AuditLog row captured; access reviews quarterly. | {{NAME}} | Mitigated |
| 4 | **Customer data leaked via SQL injection** | 1 | 5 | 5 | Prisma parameterizes all queries; no raw SQL paths; CodeQL CI runs weekly. | {{NAME}} | Mitigated |
| 5 | **Vendor outage (Neon, Vercel, Anthropic)** | 3 | 4 | 12 | Multi-region not in scope; document RTO/RPO; vendor SOC 2 receipts on file. | {{NAME}} | Open |
| 6 | **Production DB wiped accidentally** | 2 | 5 | 10 | Neon free tier no PITR — upgrade to Launch for backups; document restore procedure. | {{NAME}} | Open |
| 7 | **AI hallucination produces wrong JE** | 3 | 3 | 9 | Every AI surface requires human approval before substrate write; audit row regardless of decision. | {{NAME}} | Mitigated |
| 8 | **PII leaked via error monitoring** (e.g., Sentry capturing customer name in stack trace) | 2 | 3 | 6 | **Mitigated 2026-06-06 via Sentry shim portfolio-wide** (Group S, PRs #56-#59 — closes deficiency #5). Wraps every emit with `redactPii` allowlist before transmit + `stripStackPreamble` defense against V8 preamble leaks (14th adversarial pass closure). PII allowlists are repo-specific. 5/5 portfolio coverage. | Chris | Mitigated |
| 9 | **Period close bypassed via direct DB write** | 1 | 5 | 5 | Substrate convention: only postJournalEntry writes JEs. Documented in CLAUDE.md as non-negotiable. CC8 review required for any code touching prisma.journalEntry.* directly. | {{NAME}} | Mitigated |
| 10 | **Stale credentials of departed contributor** | 1 | 4 | 4 | When a contributor leaves, immediately revoke Vercel access, remove from CODEOWNERS, deactivate User row, rotate any tokens they had access to. Procedure in access-control.md offboarding section. | {{NAME}} | Mitigated |
| 11 | **Supply chain attack via npm dep** | 2 | 3 | 6 | **Mitigated 2026-06-06 via pinning portfolio-wide** (Group V, 5 PRs pinning 115 ranges across all 5 repos — closes deficiency #4). npm audit in CI weekly; Dependabot opens upgrade PRs we then review; production-only audit at audit-level=high; exact-version pinning eliminates silent-transitive-upgrade vector on every `npm ci` deploy. Remaining likelihood (2) reflects social-engineering on Dependabot PR review; remaining impact (3) reflects encryption-at-rest + RLS + audit-log defense-in-depth bounds blast radius. | Chris | Mitigated |
| 12 | **Vercel deploy compromised via stolen token** | 1 | 5 | 5 | Token rotates per access-control.md; gitleaks catches accidental commit; Vercel logs deploy events. | {{NAME}} | Mitigated |
| 13 | **AI API costs runaway** | 2 | 3 | 6 | Per-suggestion audit log (token counts visible at /ai-audit); cache_control on system prompts; monthly cost review. | {{NAME}} | Mitigated |
| 14 | **Customer-facing data export leaks confidential rows** (e.g., CSV download exposes a different entity's data) | 2 | 5 | 10 | Scope enforced in all report queries (entityId filter); audit log records every export. Manual review: every new export endpoint must verify scope. | {{NAME}} | Mitigated |
| 15 | **Failed schema migration corrupts production data** | 2 | 5 | 10 | Schema changes via raw SQL via `prisma db execute` (per change-management.md); test migrations on Neon branch first; backups on Neon Launch. | {{NAME}} | Partial |
| 16 | **GDPR/CCPA right-to-deletion request can't be fulfilled** | 2 | 3 | 6 | No procedure yet; financial records are explicitly excepted from right-to-deletion under most regulations but PII fields aren't. Need a documented response procedure (data-classification.md gap). | {{NAME}} | Open |
| 17 | **Multi-tenant data leakage between customers** | 1 | 5 | 5 | **Mitigated 2026-06-05.** Layered defense: Phase 4b NOT-NULL tenantId (deficiency #11); RLS Phase 1 policies (PR #66, 39 policies); RLS Phase 2a+2b withTenantContext sweep across 23 Server Actions + 3 HTTP routes + 1 batch helper (PRs #67, #69-#83); Phase 3 design + bypass-role runbook (PR #84); Phase 3 prereqs A+B (PRs #85-#86); deficiency #28 createFixedAsset tenant-scope fix (PR #88); Phase 3 implementation DRAFT (PR #89) awaiting operator ack on Decision C runbook for FORCE. 7-shape migration catalog institutionalized in CLAUDE.md (PR #90) for future call sites. | Chris | Mitigated |
| 18 | **Insider threat — privileged user posts fraudulent JE** | 1 | 5 | 5 | All JE posts logged in audit_log; quarterly access reviews; period close prevents back-dating. | {{NAME}} | Mitigated |
| 19 | **Backup integrity** (backup exists but restore fails) | 3 | 5 | 15 | Need quarterly restore drill — pull a Neon snapshot to a staging DB, verify it boots, run a smoke test, document. | {{NAME}} | Open |
| 20 | **Customer credentials phished, attacker logs in as them** | 3 | 4 | 12 | MFA when Clerk lands; audit log shows unusual login; session timeout. Today not mitigated; auth stub doesn't enforce any of this. | {{NAME}} | Open |
| 21 | **Phase 3 RLS FORCE flip causes production data-disappearance** (a missed call site goes unwrapped → silent 0-row reads after FORCE) | 2 | 4 | 8 | 6-category cross-tenant test suite (env-gated via `RLS_FORCE_ENABLED=1`) covers fail-closed verification + every shape's regression (W1/W2/T1/T2/E/M/P). Staged 3-stage rollout per `docs/architecture/rls-phase-3-design.md` — apply migration to dev first, run full test suite under RLS_FORCE_ENABLED=1, smoke-test every page, watch Sentry + audit-log volume, only then production cutover with documented rollback (`ALTER TABLE NO FORCE`). Per-PR adversarial pass cadence (institutionalized in CLAUDE.md from 15th-pass closure) catches missed sites pre-merge. | Chris | Mitigated |
| 22 | **XSS via inline script injection** (attacker plants `<script>` in a user-controlled field that bypasses framework escape) | 2 | 3 | 6 | **Mitigated 2026-06-06 via PR #99** (Group W — closes deficiency #2). CSP middleware ships per-request 16-byte base64url nonce + `strict-dynamic` script-src + `frame-ancestors 'none'` + `object-src 'none'` + `upgrade-insecure-requests`. Defense-in-depth with Next.js's framework-level escape + static headers (HSTS, X-Frame-Options DENY, Referrer-Policy). Remaining likelihood (2) reflects server-side templating bugs that bypass CSP entirely; impact (3) bounded by audit_log + encryption-at-rest. | Chris | Mitigated |
| 23 | **Audit-trail loss on substrate failure** (Neon catastrophic loss or compromise destroys the audit_log table with no external backup) | 2 | 4 | 8 | **Mitigated 2026-06-06 via PR #104 design** (Group X — Phase 1 remediates deficiency #9). Architecture commitment: S3 + Object Lock compliance mode + 7-year retention. Phase 2 implementation deferred until customer #2 onboards. Pre-Phase-2: substrate runs on Neon Launch tier with PITR; audit-log RULE (in PR #10, splittable) prevents tampering within live DB. Post-Phase-2: substrate loss recoverable via S3 archive replay. | Chris | Mitigated |

## Open vs mitigated

- **Open** (need work): 7
- **Partial** (some mitigation, more needed): 1
- **Mitigated** (controls in place, periodic review): 15
- **Future** (not in scope yet): 0

## Annual review

Reviewed annually on {{REVIEW_DATE}}. Add new risks identified during the year, review each risk's score against current reality, update mitigation status, close items where the underlying risk has gone away.
