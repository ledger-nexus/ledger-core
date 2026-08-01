# SOC 2 control matrix — evidence map

**Version:** 1.1
**Effective date:** 2026-08-01
**Owner:** Hosung Son (founder)
**Framework:** SOC 2 Trust Services Criteria 2017 (revised 2022)

This is the **positive evidence map** an auditor asks for first. Each row
maps a Common Criterion subcontrol to the specific location in the
codebase or docs that satisfies it. Distinct from
`docs/SOC2_READINESS.md` (gap analysis) — this is the "show me where
control X lives" document.

When a feature ships work that satisfies a control, add a row citing the
file and its test. The auditor's job is to spot-check; ours is to make
spot-checking easy — which means **every citation in this file must
resolve**. A matrix with three dead paths is worse than no matrix,
because it teaches the auditor to verify everything by hand.

## Read this first: what is NOT yet true

Two facts an auditor will find on their own within an hour. Better they
read them here.

**1. The system is not deployed and has never served a real user.**
No environment has `CLERK_SECRET_KEY` set. Every control below marked
Mitigated is *implemented and tested*, but none has **operated** in
production, because there is no production. A Type 1 report (design at a
point in time) is in scope; a Type 2 (operating effectiveness over a
period) is not, and will not be until the system is deployed and has
accumulated an observation window.

**2. Row Level Security is enabled but inert.**
`prisma/sql/2026-06-05-rls-phase-1-policies.sql` enables RLS and defines
per-table policies. Nothing is `FORCE`d, and the application's connection
role owns the tables — so Postgres bypasses every policy for that role.
Verified against a live database 2026-07-18: **52 policies, 52 tables
with RLS enabled, 0 forced.** Tenant isolation is therefore enforced by
application-level `WHERE tenantId` clauses, not by the database. That is
a real control with real tests, but it is a different control from the
one "RLS enabled" implies. Tracked as deficiency #12.

## How to read this

- **Control** — the Common Criterion subcontrol id
- **Statement** — what the criterion requires
- **Evidence** — path in this repo plus the test(s) that prove it
- **Status** — Mitigated / Partial / Open (mirrors risk-register taxonomy)

Paths are repo-relative. Repo prefixes (`recon`, `integrations`, …) only
when crossing repo boundaries; those cannot be spot-checked from here.

---

## CC1 — Control Environment

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC1.1 | Integrity and ethical values | `docs/policies/security.md` + this file | Partial |
| CC1.2 | Board oversight | N/A — solo founder; `docs/SOC2_READINESS.md` documents compensating controls | Partial |
| CC1.3 | Organizational structure | `.github/CODEOWNERS` documents directory ownership; `docs/policies/access-control.md` documents roles | Mitigated |
| CC1.4 | Commitment to competence | 1,307 tests across 156 files, run against a real Postgres, incl. property-based and accounting-invariant suites; `docs/universal-schema.md` documents architectural rationale | Mitigated |
| CC1.5 | Accountability | Every commit attributed via git; every privileged action attributed via `audit_log` | Mitigated |

## CC2 — Communication & Information

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC2.1 | Internal communication | `CLAUDE.md` per repo + `docs/*.md`; CLAUDE.md auto-loads at every Claude session | Mitigated |
| CC2.2 | External communication | `public/.well-known/security.txt` (responsible disclosure) | Mitigated |
| CC2.3 | Information quality | Accounting invariants on every posting path (`tests/invariants.test.ts`, `tests/property-based.test.ts`) | Mitigated |

## CC3 — Risk Assessment

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC3.1 | Specifies objectives | `CLAUDE.md` non-negotiables in each repo | Mitigated |
| CC3.2 | Identifies risks | `docs/policies/risk-register.md` | Mitigated |
| CC3.3 | Fraud risk | Risk-register items on period-close bypass, insider threat, and privileged-action bypass. Mitigated by `audit_log` plus **maker-checker approval** for journal entries: `src/lib/accounting/approval.ts`, queue at `/journal-entries/pending`, tenant policy `Tenant.requireJeApproval` + `jeApprovalMinAmount`; `tests/je-approvals.test.ts` | Mitigated |
| CC3.4 | Significant change | `docs/policies/change-management.md`; commit messages cite Common Criteria when security-relevant | Mitigated |

## CC4 — Monitoring Activities

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC4.1 | Ongoing evaluations | `.github/workflows/security.yml` runs gitleaks + npm audit + CodeQL on every PR and weekly | Mitigated |
| CC4.2 | Communicates deficiencies | `docs/policies/control-deficiency-log.md` | Partial |

## CC5 — Control Activities

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC5.1 | Selects controls | This document + `docs/policies/` | Mitigated |
| CC5.2 | Deploys via policies | `docs/policies/` (13 policy documents) | Mitigated |
| CC5.3 | Reviews controls | Risk register reviewed annually; `docs/policies/control-deficiency-log.md` tracks ad-hoc reviews | Partial |
| — | **Audit log append-only** | Postgres RULE pair silently no-ops UPDATE/DELETE on `audit_log` (migration 0015, mirrored in `prisma/sql/migration-mirror.sql`); `tests/audit-log-append-only.test.ts`, `tests/period-reopen-log-append-only.test.ts` | Mitigated |

## CC6 — Logical & Physical Access Controls

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC6.1 | Logical access (authentication) | Clerk integration at `src/lib/auth/clerk.ts`, dispatched from `src/lib/auth/current-user.ts` when `CLERK_SECRET_KEY` is set. **`src/middleware.ts` fails closed**: in production without Clerk, every non-public route returns 503 rather than falling through to the HMAC dev-cookie stub. **Designed and fail-closed, but never operated — Clerk is not provisioned in any environment.** | **Partial** |
| CC6.1 | **Multi-tenant isolation** | Application-level scoping: `getCurrentScope()` / `requireCurrentTenant()` derive `tenantId` from session, never client input; `src/lib/soc2/index.ts` exports `assertTenantScope`; `tests/pen-test-tenant-isolation.test.ts` covers cross-tenant attempts. **Enforced in the application, NOT by RLS — see "what is not yet true" above.** | Mitigated (application layer) |
| CC6.2 | New user provisioning | `/admin/team` invite flow → `TenantInvite` with single-use token and 14-day TTL (`INVITE_TTL_DAYS`, `src/app/actions/team.ts`); acceptance state machine at `src/lib/team/accept-invite.ts`, UI at `src/app/invites/accept/page.tsx`; `tests/team-invites.test.ts` | Mitigated |
| CC6.3 | Role-granular access | `src/lib/auth/policy.ts` — 22 named permission predicates over 4 roles (OWNER / ADMIN / MEMBER / VIEWER). `requirePermitted` (`src/lib/auth/authorize.ts`) resolves the session, evaluates the permission, and writes an `ACCESS_DENIED` audit row on refusal. **Coverage is not universal: 13 of 39 Server Action modules gate on it today**; the rest are read-only or gate inline. `tests/authz-policy.test.ts` | **Partial** |
| CC6.4 | Restricts access to data | Per-tenant scope on every customer-data query (CC6.1); per-role gate where applied (CC6.3) | Partial |
| CC6.5 | Asset disposal | N/A — cloud-only; vendor responsibility (Neon, Vercel) | N/A |
| CC6.6 | Network boundary | `next.config.js` security headers (HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy); `src/middleware.ts` per-request CSP with nonce + `strict-dynamic`; internal HTTP boundaries token-gated via `INTERNAL_API_TOKEN`; `tests/csp-nonce.test.ts` | Mitigated |
| CC6.7 | Restricts transmission (secrets) | `src/lib/env.ts` boot-time validation refuses to boot in production with missing secrets; `scripts/pre-commit-secrets-scan.sh` blocks committing secrets; `constantTimeEqual` in `src/lib/soc2/index.ts` for token comparison; gitleaks in CI | Mitigated |
| CC6.8 | Endpoint protection | N/A — cloud-only | N/A |
| — | **Webhook signature verification** | Stripe: `src/lib/billing/verify-webhook.ts` — HMAC-SHA256 over the raw body with a 5-minute replay window and `timingSafeEqual` comparison; the id reaching `getSubscription` is shape-validated before entering a request path (SSRF hardening); `tests/stripe-webhook-verify.test.ts` (30 cases incl. forged MAC, tampered body, replay). Plaid: `integrations/` repo (cross-repo, not verifiable here) | Mitigated |

## CC7 — System Operations

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC7.1 | Detects anomalies | `GET /api/health` returns DB connectivity + schema fingerprint + monitoring presence | Mitigated |
| CC7.2 | Monitors components | `src/lib/monitoring/index.ts` — Sentry shim running `redactPii` before transmit; falls back to console when DSN absent | Partial (no DSN provisioned) |
| CC7.3 | Evaluates security events | `audit_log` + `logAuditEvent` / `auditPrivilegedAction` / `auditAccessDenied`; append-only integrity proven by `tests/audit-log-append-only.test.ts` | Mitigated |
| CC7.4 | Responds to incidents | `docs/policies/incident-response.md` | Partial (runbook written, never exercised) |
| CC7.5 | Identifies and remediates | Risk register tracks open items; Dependabot opens upgrade PRs for CVEs; CodeQL gates every PR | Mitigated |
| — | **PII redaction in logs** | `redactPii` in `src/lib/soc2/index.ts`, run by `src/lib/monitoring/index.ts` before every emit and by the pre-commit hook's console.log check; `tests/soc2-helpers.test.ts` | Mitigated |
| — | **Information disclosure defense** | `sanitizeError` in `src/lib/soc2/index.ts` — message length cap, code derivation, correlation-id pass-through; `tests/soc2-helpers.test.ts` | Mitigated |

## CC8 — Change Management

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC8.1 | Authorizes changes | Git-based with branch protection on `main`; `.github/CODEOWNERS` routes review; every change lands by PR | Mitigated |
| — | **Pre-commit hook** | `scripts/pre-commit-secrets-scan.sh` blocks hardcoded keys, PII reaching console.log, and staged `.env` files | Mitigated |
| — | **Schema-change acknowledgement** | `scripts/check-schema-fingerprint.sh` fails CI when `prisma/schema.prisma` changes without an explicit fingerprint update, forcing schema changes to be acknowledged in the PR | Mitigated |
| — | **Schema-drift detection** | `schemaFingerprint` in `src/lib/soc2/index.ts`, surfaced by `GET /api/health` so a deploy mismatch is observable | Mitigated |

## CC9 — Risk Mitigation

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC9.1 | Identifies/develops mitigations | `docs/policies/risk-register.md` | Mitigated |
| CC9.2 | Manages vendor risk | `docs/policies/vendor-management.md` (trust-portal links + DPA status) | Mitigated |

---

## Trust Service Criteria outside CC1–CC9

### Availability TSC

| Control | Evidence | Status |
|---|---|---|
| Backup integrity | Neon PITR; restore procedure in `docs/policies/business-continuity.md`; `docs/dr-drills/` | Partial — restore drill not yet exercised |
| Capacity | Vercel and Neon both auto-scale | Mitigated |
| Recovery | RTO / RPO in `docs/policies/business-continuity.md` | Partial — documented, no DR-test evidence |

### Processing Integrity TSC — strongest area of the portfolio

| Control | Evidence | Status |
|---|---|---|
| Substrate invariants | `src/lib/accounting/post-journal.ts` enforces debits = credits atomically and is the single write path for the ledger; `tests/invariants.test.ts`, `tests/property-based.test.ts` | Mitigated |
| Ledger-effect discipline | Only `POSTED` and `REVERSED` entries carry ledger effect (`LEDGER_EFFECTIVE_STATUSES`, `src/lib/accounting/types.ts`); every aggregation site filters on it, so a pending-approval entry cannot reach a report | Mitigated |
| Idempotent posts | Partial unique index on `(sourceSystem, sourceRecordType, sourceRecordId)` dedupes repeat posts | Mitigated |
| Transactional depreciation | `/api/internal/fixed-asset/record-depreciation` — N JE posts + book-attribute update in one `$transaction` | Mitigated |
| Penny-perfect rounding | Allocator and schedule generator round per element and absorb residual on the last; covered by tests | Mitigated |

### Confidentiality TSC

| Control | Evidence | Status |
|---|---|---|
| Data classification | `docs/policies/data-classification.md` (field-by-field) | Mitigated |
| Encryption at rest | Neon volume-level encryption by default. Column-level: transparent Prisma extension at `src/lib/db/encrypted-fields-extension.ts` over a registry of **17 columns** (incl. `User.email`, `User.displayName`, `JournalEntry.memo`, `Party.displayName`, `TenantInvite.email`, `EmailDelivery.toEmail`/`subject`/`bodyText`/`bodyHtml`, `JournalEntryNote.body`/`authorEmail`, `Tenant.name`, `LegalEntity.name`, `Notification.title`/`body`, `BankTransaction.description`, `BankRule.matchText`). Equality lookup on encrypted columns runs through deterministic HMAC search-hash columns. Backfill scripts under `scripts/` (e.g. `scripts/encrypt-user-emails.ts`); `scripts/verify-encryption-rollout.sh` | Mitigated |
| Encryption in transit | TLS via Vercel and Neon defaults; HSTS in `next.config.js` | Mitigated |
| Data loss prevention | `DATA_EXPORT` audit row on every export; tenant scope on every export query | Mitigated |

### Privacy TSC

The portfolio handles limited PII (user email and display name, party display
names, journal-entry note authorship). This becomes load-bearing the moment a
customer in EU or California scope onboards.

| Control | Evidence | Status |
|---|---|---|
| GDPR Art. 15 (right of access) | `buildUserDataExport` in `src/lib/privacy/user-data.ts`; UI at `/admin/data-subject-requests`; self-export available to any member, cross-member export requires ADMIN+; the `DATA_EXPORT` audit row carries counts, never content; `tests/data-subject-requests.test.ts` | Mitigated |
| GDPR Art. 17 (right to erasure) | `eraseUserPii` in `src/lib/privacy/user-data.ts`; OWNER-only, co-tenant-only, self-erasure refused. Redacts the `User` row, `EmailDelivery.toEmail`, and `JournalEntryNote.authorEmail` snapshots. Financial records and audit rows keep the bare user-id pointer under the Art. 17(3)(b/e) retention exemption. The `DATA_ERASURE` audit row carries a hash of the original email, never plaintext | Mitigated |
| Data retention | `docs/policies/data-classification.md` retention table. **Retention is documented but not automated** — no scheduled purge job exists | **Open** |

---

## Standing-reference artifacts (cross-criterion)

| Artifact | Common Criteria served |
|---|---|
| `src/lib/soc2/index.ts` | CC5, CC6, CC7, CC8, Confidentiality |
| `src/lib/auth/policy.ts` + `src/lib/auth/authorize.ts` | CC6.3 |
| `src/lib/monitoring/index.ts` | CC7.2 |
| `src/lib/env.ts` + `src/instrumentation.ts` | CC6.7 |
| `src/app/api/health/route.ts` | CC7.1, CC8 |
| `prisma/sql/migration-mirror.sql` (audit-log RULEs, RLS policies) | CC5.1, CC7.3 |
| `scripts/pre-commit-secrets-scan.sh` | CC6.7, CC8.1 |
| `scripts/check-schema-fingerprint.sh` | CC8.1 |

Two artifacts referenced by earlier versions of this matrix live **outside
the repository** and cannot be spot-checked by an auditor with repo access
alone: the `soc2-check` slash command and the `soc2` skill, both installed
at user scope on the founder's workstation. They are developer aids, not
controls, and are listed here only so their absence from the repo is not
mistaken for a missing control.

## Companion-repo mirrors

The SOC 2 helper module, pre-commit hook, and slash command are mirrored
across the companion repos (`recon`, `revenue-rec`, `fa-amort`,
`integrations`). The audit log lives only in `ledger-core`; companion
repos emit audit rows by POSTing to `/api/internal/audit-log`. The
append-only rule protects those writes regardless of source.

## Changelog

- **1.1 (2026-08-01)** — First revision against a verified codebase. Every
  cited path machine-checked to resolve. Four dead citations fixed: the
  invite-acceptance action (moved to `src/lib/team/accept-invite.ts` with
  its page at `src/app/invites/accept/page.tsx`), the journal-entry-memo
  backfill script (never landed under that name; the surviving backfill is
  `scripts/encrypt-user-emails.ts`), a bare readiness-doc reference (now
  `docs/SOC2_READINESS.md`), and the user-scope skill (moved to a
  footnote, since it is not in the repo). CC6.1 downgraded Mitigated → Partial (Clerk is
  designed and fails closed but has never operated). CC6.3 downgraded
  Mitigated → Partial (13 of 39 Server Action modules gate on
  `requirePermitted`, not all). Data retention marked Open. Added the
  "what is not yet true" preamble covering non-deployment and inert RLS.
  Test count corrected 647 → 1,307. Encryption updated from one column to
  the 17-column registry. Added maker-checker, ledger-effect discipline,
  and the schema-fingerprint gate.
- **1.0 (2026-05-29)** — Initial extraction.
