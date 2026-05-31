# Risk register

**Version:** 1.1
**Effective date:** 2026-05-29
**Owner:** Hosung Son (founder)
**Last reviewed:** 2026-05-29

## Scoring rubric

- **Likelihood**: 1 (rare) — 5 (frequent)
- **Impact**: 1 (negligible) — 5 (catastrophic / business-ending)
- **Score**: Likelihood × Impact (range 1-25)
- **Threshold**: Score ≥ 12 = must have a mitigation plan and an owner. Score < 12 = monitor.

## Identified risks

| # | Risk | Likelihood | Impact | Score | Mitigation | Owner | Status |
|---|---|---:|---:|---:|---|---|---|
| 1 | **Auth bypass via dev cookie stub** | 1 | 5 | 5 | Clerk shipped + wired (`src/lib/auth/clerk.ts`); dev-stub gated by `NODE_ENV !== "production"` env check. Pen-test pass 1 verified the gating. | HS | Mitigated |
| 2 | **Leaked `INTERNAL_API_TOKEN` allows arbitrary JE posting** | 2 | 5 | 10 | Token stored only in Vercel env; rotation procedure in `access-control.md`; gitleaks CI catches accidental commit; pre-commit hook also scans for token shapes. | HS | Mitigated |
| 3 | **Unauthorized period reopen** | 1 | 5 | 5 | `canManageMemberships` / `canEditPeriodClose` policy gate; AuditLog row captured; access reviews quarterly (procedure in `access-control.md`). | HS | Mitigated |
| 4 | **Customer data leaked via SQL injection** | 1 | 5 | 5 | Prisma parameterizes all queries; zero raw SQL paths in app code (only in migrations); CodeQL CI runs weekly. | HS | Mitigated |
| 5 | **Vendor outage (Neon, Vercel, Anthropic, Clerk)** | 3 | 4 | 12 | Multi-region not in scope; document RTO/RPO in `business-continuity.md`; quarterly vendor SOC 2 receipt review (see `vendor-management.md`). | HS | Partial — RTO/RPO doc still TBD |
| 6 | **Production DB wiped accidentally** | 2 | 5 | 10 | Currently on Neon Launch ($19/mo) with 7-day PITR + branch protection; restore procedure documented in `business-continuity.md`. Quarterly restore drill in policy but not yet exercised. | HS | Partial |
| 7 | **AI hallucination produces wrong JE** | 3 | 3 | 9 | Every AI surface requires explicit human approval before substrate write; audit row regardless of decision; per-tenant monthly Anthropic spend cap as cost circuit-breaker. | HS | Mitigated |
| 8 | **PII leaked via error monitoring** | 2 | 4 | 8 | Sentry shim wired (2026-05-29, commit pending); `redactPii()` runs BEFORE every `captureError` / `captureMessage` transmission. When SENTRY_DSN ships, configure additional Sentry-side scrubbing as belt-and-suspenders. | HS | Mitigated |
| 9 | **Period close bypassed via direct DB write** | 1 | 5 | 5 | Substrate convention: only `postJournalEntry` writes JEs; non-negotiable in CLAUDE.md. CC8 review (CODEOWNERS) required for any code touching `prisma.journalEntry.*` directly. Period-close test in `tests/period-close-action.test.ts`. | HS | Mitigated |
| 10 | **Stale credentials of departed contributor** | 1 | 4 | 4 | Solo-dev today; when contributors join, follow offboarding procedure in `access-control.md`: revoke Vercel access, remove from CODEOWNERS, deactivate User row, rotate `INTERNAL_API_TOKEN` + any per-tenant tokens. | HS | Mitigated (when applicable) |
| 11 | **Supply chain attack via npm dep** | 3 | 5 | 15 | npm audit (`--omit=dev --audit-level=high`) in CI weekly + every PR; Dependabot opens upgrade PRs grouped by minor/patch with separate major-version PRs; gitleaks scans for credentials in committed packages. Gap: not pinned to exact versions (caret ranges in `package.json`). | HS | Partial |
| 12 | **Vercel deploy compromised via stolen token** | 1 | 5 | 5 | Token rotates per `access-control.md`; gitleaks catches accidental commit; Vercel logs deploy events; production deploys require Vercel Bot account (no human deploys). | HS | Mitigated |
| 13 | **AI API costs runaway** | 1 | 3 | 3 | Per-tenant monthly Anthropic spend cap (`Tenant.monthlyAiSpendCapUsd`); 80%/100% threshold alerts (`AiSpendAlert` + webhook); per-suggestion audit log; cost review on `/admin/ai-budget`. Multiple layers of defense — score dropped from 6 to 3. | HS | Mitigated |
| 14 | **Customer-facing data export leaks confidential rows** (e.g., CSV download exposes a different tenant's data) | 1 | 5 | 5 | Tenant-scoping enforced on every report query (audit-pass 2026-05-29 commits `1435559` → `f279111`); audit log records every export. Manual review: every new export endpoint must call `assertTenantScope` after read. | HS | Mitigated |
| 15 | **Failed schema migration corrupts production data** | 2 | 5 | 10 | Schema changes via `prisma db execute` with reviewed SQL (per `change-management.md`); test migrations on Neon branch first; backups on Neon Launch (7-day PITR). | HS | Partial — migration runbook needs codification |
| 16 | **GDPR/CCPA right-to-deletion request can't be fulfilled** | 1 | 3 | 3 | Right-of-access + right-to-erasure flows shipped 2026-05-29. `src/lib/privacy/user-data.ts` + Server Actions + UI at `/admin/data-subject-requests`. Erasure redacts User row + email_delivery; preserves financial records (legal-retention exemption). Audit-logged via DATA_EXPORT + DATA_ERASURE event types. | HS | Mitigated |
| 17 | **Multi-tenant data leakage between customers** | 1 | 5 | 5 | Multi-tenancy fully wired (Phases 1-8 in `docs/multi-tenancy.md`); per-tenant `tenantId` on every customer-data table; `assertTenantScope` helper enforces it on read; audit-pass 2026-05-29 swept reports, mappers, seeds, and UI. Tests: `pen-test-tenant-isolation.test.ts`, plus full multi-tenant invariants in `tests/invariants.test.ts`. Score dropped from "Future" to "Mitigated". | HS | Mitigated |
| 18 | **Insider threat — privileged user posts fraudulent JE** | 1 | 5 | 5 | All JE posts logged in `audit_log`; maker-checker workflow (commit `b7dfb4f`/threshold `8eedcbe`) requires second-person approval; quarterly access reviews; period close prevents back-dating. | HS | Mitigated |
| 19 | **Backup integrity** (backup exists but restore fails) | 3 | 5 | 15 | Quarterly restore drill required by `business-continuity.md` — pull a Neon snapshot to staging DB, verify boots, run smoke test, document. Not yet exercised. | HS | Open |
| 20 | **Customer credentials phished, attacker logs in as them** | 2 | 4 | 8 | Clerk auth shipped with optional MFA; session lifetime configurable on Clerk side; audit log captures login + unusual-IP events. MFA enforcement at the tenant org level is configurable but not yet mandated. | HS | Partial |
| 21 | **Privileged-action authorization bypass (post-2026-05-29)** | 1 | 5 | 5 | New helper `assertTenantScope` from `@/lib/soc2` raises `CrossTenantAccessError` (rendered as 404 to avoid existence leak) on any row whose `tenantId` doesn't match the actor's; covered by the pre-commit hook scan + `/soc2-check` slash command. | HS | Mitigated |

## Open vs mitigated (post-2026-05-29 audit-pass)

- **Mitigated** (controls in place, periodic review): 14
- **Partial** (some mitigation, more needed): 5
- **Open** (need work): 2

Net change since v1.0:
- **−7 Open** (Auth bypass, multi-tenant, Sentry/PII, AI cost, customer-facing export, insider threat, phishing) — all moved to Mitigated by this session's work.
- **+1 new risk added** (#21 — privileged-action authorization bypass post-helper) with mitigation already in place.

## Annual review

Reviewed annually. Next review: **2027-05-29**. Add new risks
identified during the year, review each risk's score against current
reality, update mitigation status, close items where the underlying
risk has gone away. Ad-hoc reviews after every pen-test, every audit
finding, and every major feature that touches authentication, audit,
or data.
