# Risk register

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}}

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
| 8 | **PII leaked via error monitoring** (e.g., Sentry capturing customer name in stack trace) | 3 | 4 | 12 | Sentry not yet wired — when added, configure scrubbing for `email`, `displayName`, `memo` fields. | {{NAME}} | Future |
| 9 | **Period close bypassed via direct DB write** | 1 | 5 | 5 | Substrate convention: only postJournalEntry writes JEs. Documented in CLAUDE.md as non-negotiable. CC8 review required for any code touching prisma.journalEntry.* directly. | {{NAME}} | Mitigated |
| 10 | **Stale credentials of departed contributor** | 1 | 4 | 4 | When a contributor leaves, immediately revoke Vercel access, remove from CODEOWNERS, deactivate User row, rotate any tokens they had access to. Procedure in access-control.md offboarding section. | {{NAME}} | Mitigated |
| 11 | **Supply chain attack via npm dep** | 3 | 5 | 15 | npm audit in CI weekly; Dependabot opens upgrade PRs; production-only audit at audit-level=high. Still gap: not pinned to exact versions. | {{NAME}} | Partial |
| 12 | **Vercel deploy compromised via stolen token** | 1 | 5 | 5 | Token rotates per access-control.md; gitleaks catches accidental commit; Vercel logs deploy events. | {{NAME}} | Mitigated |
| 13 | **AI API costs runaway** | 2 | 3 | 6 | Per-suggestion audit log (token counts visible at /ai-audit); cache_control on system prompts; monthly cost review. | {{NAME}} | Mitigated |
| 14 | **Customer-facing data export leaks confidential rows** (e.g., CSV download exposes a different entity's data) | 2 | 5 | 10 | Scope enforced in all report queries (entityId filter); audit log records every export. Manual review: every new export endpoint must verify scope. | {{NAME}} | Mitigated |
| 15 | **Failed schema migration corrupts production data** | 2 | 5 | 10 | Schema changes via raw SQL via `prisma db execute` (per change-management.md); test migrations on Neon branch first; backups on Neon Launch. | {{NAME}} | Partial |
| 16 | **GDPR/CCPA right-to-deletion request can't be fulfilled** | 2 | 3 | 6 | No procedure yet; financial records are explicitly excepted from right-to-deletion under most regulations but PII fields aren't. Need a documented response procedure (data-classification.md gap). | {{NAME}} | Open |
| 17 | **Multi-tenant data leakage between customers** | N/A yet | 5 | — | Currently single-tenant. When multi-tenancy lands, add `tenantId` to every model + RLS in Postgres + per-tenant tests. | {{NAME}} | Future |
| 18 | **Insider threat — privileged user posts fraudulent JE** | 1 | 5 | 5 | All JE posts logged in audit_log; quarterly access reviews; period close prevents back-dating. | {{NAME}} | Mitigated |
| 19 | **Backup integrity** (backup exists but restore fails) | 3 | 5 | 15 | Need quarterly restore drill — pull a Neon snapshot to a staging DB, verify it boots, run a smoke test, document. | {{NAME}} | Open |
| 20 | **Customer credentials phished, attacker logs in as them** | 3 | 4 | 12 | MFA when Clerk lands; audit log shows unusual login; session timeout. Today not mitigated; auth stub doesn't enforce any of this. | {{NAME}} | Open |

## Open vs mitigated

- **Open** (need work): 7
- **Partial** (some mitigation, more needed): 2
- **Mitigated** (controls in place, periodic review): 10
- **Future** (not in scope yet): 1

## Annual review

Reviewed annually on {{REVIEW_DATE}}. Add new risks identified during the year, review each risk's score against current reality, update mitigation status, close items where the underlying risk has gone away.
