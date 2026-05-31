# SOC 2 control matrix — evidence map

**Version:** 1.0
**Effective date:** 2026-05-29
**Owner:** Hosung Son (founder)
**Framework:** SOC 2 Trust Services Criteria 2017 (revised 2022)

This is the **positive evidence map** an auditor asks for first.
Each row maps a Common Criterion subcontrol to the specific
location in the codebase or docs that satisfies it. Distinct from
`SOC2_READINESS.md` (gap analysis) — this is the "show me where
control X lives" document.

When a new feature ships work that satisfies a control, add a row
here citing the file + line + test. The auditor's job is then to
spot-check; ours is to make spot-checking easy.

## How to read this

Each row has:

- **Control** — the Common Criterion subcontrol id
- **Statement** — what the criterion requires
- **Evidence** — file:line in the codebase + test(s) that prove it
- **Status** — Mitigated / Partial / Open (mirrors risk-register taxonomy)

Code paths use module-relative form (`src/lib/...`); tests use the
`tests/...` form. Repo prefixes (`ledger-core`, `recon`, etc.) only
when crossing repo boundaries.

---

## CC1 — Control Environment

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC1.1 | Integrity and ethical values | `docs/policies/security.md` + this file | Partial |
| CC1.2 | Board oversight | N/A — solo founder; `docs/SOC2_READINESS.md` documents compensating controls | Partial |
| CC1.3 | Organizational structure | `.github/CODEOWNERS` documents directory ownership; `docs/policies/access-control.md` documents roles | Mitigated |
| CC1.4 | Commitment to competence | Test suites (647+ passing) + property-based + invariant tests; `docs/universal-schema.md` documents architectural rationale | Mitigated |
| CC1.5 | Accountability | Every commit attributed via git; every privileged action attributed via `audit_log` | Mitigated |

## CC2 — Communication & Information

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC2.1 | Internal communication | `CLAUDE.md` per repo + `docs/*.md`; CLAUDE.md auto-loads at every Claude session | Mitigated |
| CC2.2 | External communication | `public/.well-known/security.txt` (responsible disclosure) | Mitigated |
| CC2.3 | Information quality | Test invariants on every accounting path (`tests/invariants.test.ts`, `tests/property-based.test.ts`) | Mitigated |

## CC3 — Risk Assessment

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC3.1 | Specifies objectives | `CLAUDE.md` non-negotiables in each repo | Mitigated |
| CC3.2 | Identifies risks | `docs/policies/risk-register.md` (21 scored risks) | Mitigated |
| CC3.3 | Fraud risk | Risk register items #9 (period-close bypass), #18 (insider threat), #21 (privileged-action bypass) — all mitigated via `audit_log` + maker-checker workflow | Mitigated |
| CC3.4 | Significant change | `docs/policies/change-management.md` documents the procedure; git commit messages cite Common Criteria when security-relevant | Mitigated |

## CC4 — Monitoring Activities

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC4.1 | Ongoing evaluations | `.github/workflows/security.yml` runs gitleaks + npm audit + CodeQL on every PR and weekly schedule | Mitigated |
| CC4.2 | Communicates deficiencies | `docs/policies/control-deficiency-log.md` template; populated as issues arise | Partial |

## CC5 — Control Activities

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC5.1 | Selects controls | This document + `docs/policies/*` | Mitigated |
| CC5.2 | Deploys via policies | `docs/policies/` directory (9 policy documents) | Mitigated |
| CC5.3 | Reviews controls | Risk register reviewed annually (see header); `docs/policies/control-deficiency-log.md` tracks ad-hoc reviews | Partial |
| — | **Audit log append-only** | `prisma/sql/audit-log-append-only.sql` — Postgres RULE silently no-ops UPDATE/DELETE on `audit_log`; verified by `tests/audit-log-append-only.test.ts` | Mitigated |

## CC6 — Logical & Physical Access Controls

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC6.1 | Logical access (auth) | `src/lib/auth/clerk.ts` (Clerk integration); dev stub gated by `NODE_ENV` via `src/lib/auth/current-user.ts` | Mitigated |
| CC6.1 | **Multi-tenant isolation (IDOR)** | `src/lib/soc2/index.ts` exports `assertTenantScope`; audit-pass 2026-05-29 (commits `1435559` → `f279111`) swept every report + mapper + seed + UI; `tests/pen-test-tenant-isolation.test.ts` covers cross-tenant attempts | Mitigated |
| CC6.2 | New user provisioning | `/admin/team` invite flow → `TenantInvite` with single-use token + 14-day TTL; `src/app/actions/accept-invite.ts` | Mitigated |
| CC6.3 | Role-granular access | `src/lib/auth/policy.ts` — 16 named permissions × 4 roles (OWNER/ADMIN/MEMBER/VIEWER); every Server Action calls `requirePermission(...)` | Mitigated |
| CC6.4 | Restricts access to data | Per-tenant scope on every customer-data query (CC6.1 entry); per-role policy gate (CC6.3 entry) | Mitigated |
| CC6.5 | Asset disposal | N/A — cloud-only; covered by vendor responsibilities (Neon, Vercel) | Mitigated |
| CC6.6 | Network boundary | `next.config.js` — security headers (HSTS, X-Frame, nosniff, Referrer-Policy, Permissions-Policy); `src/middleware.ts` — per-request CSP with nonce + `strict-dynamic`, blocks framing + plugins, forces HTTPS upgrade (tests: `tests/csp-nonce.test.ts` 9/9); internal HTTP boundaries token-gated via `INTERNAL_API_TOKEN` | Mitigated |
| CC6.7 | Restricts transmission (secrets) | `src/lib/env.ts` — boot-time validation refuses to boot in production with missing secrets; `scripts/pre-commit-secrets-scan.sh` blocks committing secrets; `src/lib/soc2/index.ts` exports `constantTimeEqual` for token comparison | Mitigated |
| CC6.8 | Endpoint protection | N/A — cloud-only | N/A |
| — | **Webhook signature verification** | Plaid: `integrations/src/lib/connectors/plaid/webhook-verification.ts` (ES256 JWT, 15 tests); Stripe: `src/app/api/billing/webhook/route.ts` (HMAC-SHA256) | Mitigated |

## CC7 — System Operations

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC7.1 | Detects anomalies | `GET /api/health` returns DB connectivity + schema fingerprint + monitoring presence | Mitigated |
| CC7.2 | Monitors components | `src/lib/monitoring/index.ts` — Sentry shim with `redactPii` running before transmit; falls back to console when DSN absent | Mitigated (DSN provisioning pending) |
| CC7.3 | Evaluates security events | `audit_log` table + `auditPrivilegedAction` helper; `tests/audit-log-append-only.test.ts` proves integrity | Mitigated |
| CC7.4 | Responds to incidents | `docs/policies/incident-response.md` runbook | Mitigated |
| CC7.5 | Identifies and remediates | Risk register tracks open items; Dependabot opens upgrade PRs for CVEs | Mitigated |
| — | **PII redaction in logs** | `src/lib/soc2/index.ts` exports `redactPii`; `src/lib/monitoring/index.ts` runs it before every emit; `tests/soc2-helpers.test.ts` covers field-name redaction including nested + arrays | Mitigated |
| — | **Information disclosure defense** | `src/lib/soc2/index.ts` exports `sanitizeError`; `tests/soc2-helpers.test.ts` covers error-message length cap + code-derivation + correlation-id pass-through | Mitigated |

## CC8 — Change Management

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC8.1 | Authorizes changes | Git-based; `.github/CODEOWNERS` documents review routing; commit messages cite Common Criteria when security-relevant | Mitigated |
| — | **Pre-commit hook** | `scripts/pre-commit-secrets-scan.sh` blocks commits with hardcoded payment / API keys, PII spilling to console.log, or staged .env files; installed via `.git/hooks/pre-commit` symlink | Mitigated |
| — | **Schema-drift detection** | `src/lib/soc2/index.ts` exports `schemaFingerprint`; `GET /api/health` surfaces the hash so a deploy mismatch is observable | Mitigated |

## CC9 — Risk Mitigation

| Control | Statement | Evidence | Status |
|---|---|---|---|
| CC9.1 | Identifies/develops mitigations | `docs/policies/risk-register.md` (21 risks, 14 Mitigated / 5 Partial / 2 Open) | Mitigated |
| CC9.2 | Manages vendor risk | `docs/policies/vendor-management.md` (10 vendors with trust portal links + DPA status) | Mitigated |

## Trust Service Criteria outside CC1-CC9

### Availability TSC

| Control | Evidence | Status |
|---|---|---|
| Backup integrity | Neon Launch tier — 7-day PITR; restore procedure in `docs/policies/business-continuity.md`; quarterly restore drill (not yet exercised) | Partial |
| Capacity | Vercel auto-scales; Neon auto-scales with paid tier | Mitigated |
| Recovery | RTO / RPO documented in `docs/policies/business-continuity.md` | Partial — doc populated but no DR-test evidence yet |

### Processing Integrity TSC — **strongest area of the portfolio**

| Control | Evidence | Status |
|---|---|---|
| Substrate invariants | `src/lib/accounting/post-journal.ts` (debits = credits enforced atomically); `tests/invariants.test.ts`, `tests/property-based.test.ts` (54 cases × 10 runs each) | Mitigated |
| Idempotent posts | `/api/internal/journal-entries` — partial unique index on `(sourceSystem, sourceRecordType, sourceRecordId)` dedupes repeat posts | Mitigated |
| Transactional depreciation | `/api/internal/fixed-asset/record-depreciation` — N JE posts + book-attrs update in one $transaction | Mitigated |
| Penny-perfect rounding | Allocator + schedule generator round per-element and absorb residual on last element; verified by tests | Mitigated |

### Confidentiality TSC

| Control | Evidence | Status |
|---|---|---|
| Data classification | `docs/policies/data-classification.md` (field-by-field) | Mitigated |
| Encryption at rest | Neon Postgres encryption at rest by default (volume-level); field-level helper (`src/lib/soc2/field-encryption.ts` + 15 tests); transparent Prisma extension (`src/lib/db/encrypted-fields-extension.ts` + 3 DB-roundtrip tests); first column `JournalEntry.memo` rolled out (`scripts/encrypt-journal-entry-memos.ts` for backfill) | Mitigated |
| Encryption in transit | TLS 1.3 via Vercel + Neon defaults; HSTS via `next.config.js` | Mitigated |
| Data loss prevention | Audit log every export; tenant scope on every export query | Mitigated |

### Privacy TSC

Portfolio handles minimal PII (User.email, User.displayName, Party.displayName). Becomes critical once a customer in EU/California scope onboards.

| Control | Evidence | Status |
|---|---|---|
| GDPR Art. 15 (right of access) | `src/lib/privacy/user-data.ts buildUserDataExport`; UI at `/admin/data-subject-requests` (self-export available to any member) | Mitigated |
| GDPR Art. 17 (right to erasure) | `src/lib/privacy/user-data.ts eraseUserPii`; OWNER-only Server Action; financial records preserved (legal-retention exemption per Art. 17(3)(b/e)); audit-logged as `DATA_ERASURE` | Mitigated |
| Data retention | `docs/policies/data-classification.md` retention table | Mitigated |

---

## Standing-reference artifacts (cross-criterion)

| Artifact | Common Criteria served |
|---|---|
| `src/lib/soc2/index.ts` | CC5, CC6, CC7, CC8, Confidentiality |
| `src/lib/monitoring/index.ts` | CC7.2 |
| `src/lib/env.ts` + `src/instrumentation.ts` | CC6.7 |
| `src/app/api/health/route.ts` | CC7.1, CC8 |
| `prisma/sql/audit-log-append-only.sql` | CC5.1, CC7.3 |
| `.claude/commands/soc2-check.md` | CC8.1 (gate before merge) |
| `.claude/skills/soc2/SKILL.md` (user-scope) | CC2.1 (internal communication: brings the framework into every Claude session) |
| `scripts/pre-commit-secrets-scan.sh` | CC6.7, CC8.1 |

## Companion-repo mirrors

The helper module + slash command + pre-commit hook are mirrored in
all 4 companion repos. The audit log lives only in `ledger-core`;
companion repos emit audit rows by POSTing to ledger-core's
`/api/internal/audit-log` endpoint. The append-only rule on the
`audit_log` table protects writes from any source.
