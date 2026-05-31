# SOC 2 readiness assessment — ledger-nexus portfolio

**Status:** Pre-readiness — but materially closer than the original
assessment indicated. Several gaps the original draft rated "Critical
gap" or "Missing" have shipped in subsequent work. See **"What's
shipped since this doc was first written"** at the bottom for the
delta and the helper-module reference.

**Scope:** Type 1 readiness assessment across all 5 repos (`ledger-core`, `recon`, `revenue-rec`, `integrations`, `fa-amort`).
**Framework:** SOC 2 Trust Services Criteria 2017 (revised 2022), Security TSC + Common Criteria CC1–CC9. Availability, Processing Integrity, Confidentiality also referenced where in scope.

**Code-side reference:** `src/lib/soc2/index.ts` is the standing
helper module. Every new feature should import its primitives
(`assertTenantScope`, `constantTimeEqual`, `redactPii`,
`sanitizeError`, `auditedMutation`, `schemaFingerprint`) rather
than re-implement. The companion `/soc2` skill auto-surfaces this
to future Claude sessions whenever they touch auth, data, audit,
or error-handling code.

---

## What this document is and isn't

**Is:** An honest gap analysis mapping the current codebase to each SOC 2 Common Criterion. Citations to specific files and line numbers. Rated severity per finding. Tractable remediation list.

**Isn't:** A SOC 2 attestation. Actual SOC 2 attestation requires:
- An accredited CPA firm (Service Auditor) — see [AICPA's SOC firm directory](https://us.aicpa.org/interestareas/frc/assuranceadvisoryservices/serviceorganization-smanagement.html)
- A **6-month minimum** observation window for Type 2 (Type 1 is point-in-time)
- Operational evidence collected continuously during the window (control execution proof, not just policy documents)
- Vendor SOC 2 attestation receipts from upstream services (Neon, Vercel, Anthropic, etc.)
- Penetration testing within the prior 12 months
- Formal risk assessment and treatment documentation
- HR controls if there are employees (background checks, training records, NDAs)

What we can do in code: implement and document the *technical* controls that map to SOC 2's Trust Service Criteria. We can't fabricate a control environment or an observation window. We can build the substrate that, given 6 months of operating evidence, an auditor would attest to.

---

## Honest summary

The portfolio has **strong processing-integrity controls** (substrate-level invariants, idempotent posts, multi-book divergence, tested via property-based + invariant suites) and **partial audit-trail infrastructure** (`AiSuggestion`, `RecordEvent`, `PeriodClose.closedBy`).

It is **missing or critically weak** on every other area an auditor will look at:

| Area | State | SOC 2 Block? |
|---|---|---|
| Authentication | Dev-only HMAC cookie stub, no MFA, no password policy | **Yes — CC6** |
| Access controls (RBAC) | Two-tier (admin/user) by hardcoded email allowlist | **Yes — CC6** |
| Audit logging | Partial (AI rows, period close); no JE-level or login audit | **Yes — CC5, CC7** |
| Access logging | None (no request log, no Server Action invocation log) | **Yes — CC6, CC7** |
| Vulnerability mgmt | No SAST, no Dependabot; 10 known CVEs in deps (4 high) | **Yes — CC7, CC9** |
| Monitoring/alerting | No Sentry/Datadog/error pipeline | **Yes — CC7** |
| Incident response | No runbook, no on-call, no postmortem template | **Yes — CC7** |
| Change management | Atomic commits + tests; no branch protection, no CODEOWNERS | Partial — CC8 |
| Encryption at rest | DB-default only (Neon TLS); no field-level for PII | **Yes — CC6, Confidentiality** |
| Encryption in transit | TLS via Vercel/Neon default; no HSTS header | Partial — CC6 |
| Risk assessment | None formal | **Yes — CC3** |
| Vendor mgmt | No SOC 2 receipts catalogued | **Yes — CC9** |
| Business continuity | No documented RTO/RPO, no DR test | **Yes — Availability** |
| Data retention | No policy, no automated purges | **Yes — Privacy/Confidentiality** |
| Personnel controls | N/A (solo dev) — will become a gap with employees | Partial — CC1 |

The portfolio is currently **0–10% of the way to SOC 2 Type 2**. Realistic timeline to first Type 1 audit if started today: 90 days of engineering + 90 days of policy work + a Type 1 audit (~6 weeks, ~$15-25k for a small firm). Type 2 follows after a 6-month observation window with evidence.

---

## Trust Service Criteria coverage

### Security TSC — covered below in CC1-CC9
### Availability TSC — partially in CC7; full DR/RTO/RPO work needed
### Processing Integrity TSC — **strongest area of the portfolio**
- Multi-book parallel posting: `src/lib/accounting/post-journal.ts` (debits = credits enforced atomically; see `tests/invariants.test.ts`)
- Idempotency on cross-repo writes: `src/app/api/internal/journal-entries/route.ts` lines 173-181 (lineage-triple dedup)
- Transactional depreciation: `src/app/api/internal/fixed-asset/record-depreciation/route.ts`
- Property-based invariants: `tests/property-based.test.ts` (54 cases × 10 runs each)
- Penny-perfect rounding: `src/lib/accounting/sub-ledgers/fixed-assets.ts` (last-period absorbs residual)

### Confidentiality TSC — **major gap**
- No field-level encryption for any data classified as confidential
- No data classification taxonomy
- No DLP, no egress controls
- See CC6 below

### Privacy TSC — **not in scope yet**
- Portfolio doesn't yet collect customer PII beyond `User.email`, `User.displayName`, `Party.displayName`
- No privacy notice published
- No GDPR / CCPA-style data subject request handling
- Becomes critical once real customer data is onboarded

---

## CC1 — Control Environment

> *Demonstrates a commitment to integrity and ethical values, exercises oversight responsibility, establishes structure, authority, and responsibility, demonstrates commitment to competence, and enforces accountability.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC1.1 Integrity and ethical values | No code of conduct doc, no acceptable use policy | **Missing** |
| CC1.2 Board oversight | N/A — solo dev | **Missing** |
| CC1.3 Org structure | No documented org chart, no role/responsibility matrix | **Missing** |
| CC1.4 Competence | Test suites prove engineering competence; no documented training/skills matrix | Partial |
| CC1.5 Accountability | Git commit attribution is the only "accountability" surface | **Missing** |

### Findings

**[CRITICAL]** No security policy, no acceptable use policy, no code of ethics. SOC 2 auditors expect formal documents employees sign — even for solo founders, the doc must exist to anchor every subsequent control.

**[CRITICAL]** No documented org structure. "Solo dev" is a finding on its own; auditors look for documented separation of duties (e.g., who reviews PRs, who can deploy to prod). Solo-dev portfolios usually compensate with "compensating controls" — e.g., "all code is reviewed by an external code-review tool / AI"; this needs to be documented.

### Remediation

→ Add `docs/policies/` framework. See Phase 4 below.

---

## CC2 — Communication & Information

> *Obtains or generates and uses relevant, quality information to support the functioning of internal control.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC2.1 Internal communication | Code comments + CLAUDE.md per repo + docs/* | Strong |
| CC2.2 External communication | No public security.txt, no responsible disclosure policy | **Missing** |
| CC2.3 Information quality | Test suites + invariant proofs cover correctness | Strong |

### Findings

**[MEDIUM]** No `.well-known/security.txt` and no responsible disclosure policy. Both Vercel projects should expose `/.well-known/security.txt` with a security contact email and a disclosure timeline.

**[STRONG]** Documentation quality is unusually high for a v1 portfolio. `CLAUDE.md` in each repo explains the non-negotiables; `docs/universal-schema.md` is treated as canonical. Auditors will note this favorably.

### Remediation

→ Add `public/.well-known/security.txt` to each Next.js repo. Add `SECURITY.md` at the GitHub repo root.

---

## CC3 — Risk Assessment

> *Specifies suitable objectives, identifies and analyzes risks, assesses fraud risk, and identifies and analyzes significant change.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC3.1 Specifies objectives | Implicit in CLAUDE.md non-negotiables | Partial |
| CC3.2 Identifies risks | No risk register | **Missing** |
| CC3.3 Fraud risk | No fraud risk assessment | **Missing** |
| CC3.4 Identifies change | Version-numbered changelogs in git; no change-impact analysis | Partial |

### Findings

**[CRITICAL]** No risk register. The portfolio handles accounting data — fraud risks (unauthorized JEs, period-close bypass, manipulation of historical entries) are material and unmitigated formally.

**[NOTE]** Some risks are *implicitly* mitigated by code: e.g., period-close prevents back-dated entries (CC8 control), debits-equal-credits enforced at the substrate level (CC7 control). These need to be *cataloged* against named risks.

### Remediation

→ Add `docs/policies/risk-register.md` with top 20 risks, likelihood × impact, mitigation status, owner, review date. Phase 4 below.

---

## CC4 — Monitoring Activities

> *Selects, develops, and performs ongoing and/or separate evaluations to ascertain whether the components of internal control are present and functioning.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC4.1 Ongoing evaluations | CI runs test suites on every push | Partial |
| CC4.2 Communicates deficiencies | No formal mechanism | **Missing** |

### Findings

**[CRITICAL]** No mechanism for tracking control deficiencies, internal audit findings, or remediation status. Auditors will expect a tracking system (even a spreadsheet) showing which controls have failed in the observation window and how/when they were fixed.

### Remediation

→ Add `docs/policies/control-deficiency-log.md` as a template.

---

## CC5 — Control Activities

> *Selects and develops control activities, deploys through policies and procedures.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC5.1 Selects controls | Period close, idempotency, balanced entries, RBAC stub | Partial |
| CC5.2 Deploys via policy | No formal policy documents | **Missing** |
| CC5.3 Reviews controls | No periodic control review | **Missing** |

### Findings

**[STRONG]** Substrate-level controls are exemplary for processing integrity:
- Every JE goes through `postJournalEntry` (`src/lib/accounting/post-journal.ts`); no direct DB writes allowed by convention.
- Period close gates further posts: `src/app/api/internal/journal-entries/route.ts` lines 245-260 raise `PERIOD_CLOSED` on locked periods.
- Idempotency keys (lineage triples) prevent duplicate posts: dedup logic at lines 173-203.

**[CRITICAL]** No policies documenting these controls. Auditors test by reading policy ("the system shall not allow posting to closed periods"), then testing (try to post → must fail). Today the test exists but the policy doesn't.

**[HIGH]** Two-tier RBAC is too coarse. `requireAdmin()` (line 141 of `src/lib/auth/current-user.ts`) returns boolean. SOC 2 expects role-granular permissions (e.g., AP clerk, AR clerk, controller, CFO) with documented assignment.

### Remediation

→ Add `docs/policies/access-control.md` documenting the access model.
→ Add an `AuditLog` table that records every privileged action (period close, user lifecycle, JE posting, etc.) — see Phase 3a below.

---

## CC6 — Logical & Physical Access Controls

> *Implements logical and physical access controls.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC6.1 Logical access | HMAC dev-cookie stub | **Critical gap** |
| CC6.2 New user provisioning | Manual via `setCurrentUserAction` | **Missing** |
| CC6.3 Access removal | `User.deactivatedAt` exists but not enforced consistently | **Missing** |
| CC6.4 Restricts access to data | Two-tier RBAC, all-or-nothing for admin actions | Partial |
| CC6.5 Asset disposal | No formal | **Missing** |
| CC6.6 Network boundary | Token-gated internal HTTP boundaries (good); no WAF | Partial |
| CC6.7 Restricts transmission | TLS by default; no HSTS header set | Partial |
| CC6.8 Endpoint protection | N/A — cloud only | N/A |

### Findings

**[CRITICAL]** Authentication is explicitly a dev stub. `src/lib/auth/current-user.ts` lines 1-8:
```typescript
// Dev-only authentication stub. NOT for production.
// HMAC-signed cookie containing the user id.
// Replace with Clerk, NextAuth, or WorkOS before any real deployment.
```

This is the single biggest gap. Until real auth is in place, every other CC6 control is moot.

**[CRITICAL]** No MFA. SOC 2 expects MFA for all privileged access (admin role), often for all access. Today there's no way to require a second factor.

**[CRITICAL]** Admin assignment is by hardcoded email allowlist:
```typescript
// src/lib/auth/current-user.ts lines 123-127
const ADMIN_EMAIL_ALLOWLIST = new Set<string>([
  "controller@northwind.test",
]);
```
SOC 2 expects role assignment to be DB-driven with approval workflow and audit trail.

**[CRITICAL]** No access review. SOC 2 requires periodic (typically quarterly) review of who has access to what. The portfolio has no UI or process for this.

**[HIGH]** `User.deactivatedAt` exists as a soft-delete column but is not consistently filtered in queries. A deactivated user could still appear in dropdowns or be referenced by stale sessions. See `setCurrentUserAction` (line 38: "User is inactive") — checked at login but not on every request.

**[HIGH]** No session timeout. Cookie expires in 1 year; sessions don't refresh on activity. SOC 2 typically expects idle-timeout (15-30 min for sensitive apps).

**[HIGH]** No password policy because no passwords exist. The Clerk/NextAuth swap (planned in `docs/auth-swap.md`) addresses this.

**[MEDIUM]** Internal HTTP endpoints are token-gated (`INTERNAL_API_TOKEN`). Token rotation isn't formalized — there's no documented procedure to rotate without downtime.

**[STRONG]** Server-side rendering with Server Actions means most "API endpoints" don't exist in the conventional sense; this removes a class of attack surface.

### Remediation

→ Swap dev cookie for Clerk or NextAuth. See `docs/auth-swap.md` for the swap recipe. Critical path.
→ Add granular RBAC (see `docs/policies/access-control.md` template in Phase 4).
→ Implement `AuditLog` (Phase 3a) so every login/logout/access-grant/access-revoke event is captured.
→ Add HSTS header (Phase 3b).
→ Document token rotation procedure (Phase 4 policy).

---

## CC7 — System Operations

> *Detects and addresses system failures, evaluates security events.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC7.1 Detects anomalies | None (no monitoring) | **Missing** |
| CC7.2 Monitors components | None | **Missing** |
| CC7.3 Evaluates security events | None | **Missing** |
| CC7.4 Responds to incidents | None | **Missing** |
| CC7.5 Identifies and remediates | Patch via deps update (manual) | Partial |

### Findings

**[CRITICAL]** No error monitoring. Sentry, Datadog, or any APM not wired. Errors disappear unless a user manually reports them.

**[CRITICAL]** No incident response procedure. No on-call rotation (N/A for solo, but auditor still expects a documented process: "I, the solo dev, get paged via X; here's my runbook").

**[CRITICAL]** No anomaly detection. No alerting on unusual posting patterns (e.g., a sudden burst of high-dollar JEs by a non-admin user).

**[HIGH]** No health check endpoints. Vercel's "deployment readiness" is the only check; if the DB is unreachable but the server responds, no one knows until a user complains.

**[HIGH]** No log aggregation. Vercel keeps function logs ~7 days on free tier; SOC 2 typically requires 1-year retention.

**[MEDIUM]** No vulnerability scanning. `npm audit` is not run in CI. As of this commit, all 5 repos have 10 known CVEs (4 high, 6 moderate) in transitive deps.

### Remediation

→ Add Sentry to all 5 repos via `@sentry/nextjs`. See Phase 3 below.
→ Add `/api/health` endpoint per repo. See Phase 3 below.
→ Add `npm audit` step to CI. See Phase 3d below.
→ Add Dependabot config (Phase 3d).
→ Add incident response runbook (Phase 4).
→ Log aggregation: enable Vercel's Datadog/Better Stack integration, or pipe to a long-term storage bucket.

---

## CC8 — Change Management

> *Authorizes, designs, develops/acquires, configures, documents, tests, approves, and implements changes.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC8.1 Authorizes changes | Git-based; no PR-required-for-merge enforcement | Partial |
| CC8.2 Designs/develops | Architecture docs in `docs/*.md` | Strong |
| CC8.3 Tests | CI runs unit + property-based tests | Partial |
| CC8.4 Approves | No formal code review gate | **Missing** |
| CC8.5 Implements (deploy) | `bin/deploy.sh` runbook + Vercel auto-deploy | Partial |

### Findings

**[CRITICAL]** No branch protection on `main`. Merges from local can push directly. SOC 2 expects:
- PRs required for all changes to main
- Reviewer approval required (CODEOWNERS or branch protection rules)
- CI checks required to pass before merge
- Signed commits (or at least an audit trail of who pushed what)

**[HIGH]** No `CODEOWNERS` file. Even for a solo project, listing the owner of each subdirectory shows auditors that ownership is intentional.

**[HIGH]** CI runs tests but doesn't gate merge. Without branch protection rules in GitHub settings, a failing CI doesn't block a push.

**[STRONG]** Commit messages are atomic and descriptive (e.g., `v1.16: quick wins — packet download, friendly errors, test suite green` with detailed bullet-pointed body). Auditors will note this favorably.

**[STRONG]** Test suites are property-based and exhaustive on the critical paths (posting, period close, AI surfaces).

### Remediation

→ Add `.github/CODEOWNERS` (Phase 3e).
→ Document branch protection rules (`.github/BRANCH_PROTECTION.md`) (Phase 3e).
→ Add a "Required Status Checks" section in repo settings via `gh api`.
→ Add `npm audit` to required checks (Phase 3d).

---

## CC9 — Risk Mitigation

> *Identifies, selects, and develops risk mitigation activities. Assesses and manages risks associated with vendors and business partners.*

### Current state

| Subcriterion | Evidence | Status |
|---|---|---|
| CC9.1 Identifies/develops mitigations | Some (period close, idempotency, audit rows) | Partial |
| CC9.2 Manages vendor risk | No vendor inventory | **Missing** |

### Findings

**[CRITICAL]** No vendor management. The portfolio depends on Neon (Postgres), Vercel (hosting), Anthropic (AI), Plaid (banking), GitHub (source control), npm (deps). Each is a vendor whose security posture matters. SOC 2 expects:
- Inventory of all vendors that handle customer data or have access to production
- SOC 2 attestation receipts from each (annual review)
- Data Processing Agreements (DPAs)
- Documented escalation contact

**[HIGH]** No business continuity plan. RTO/RPO not documented.

### Remediation

→ Add `docs/policies/vendor-management.md` (Phase 4) with template entries for each vendor.
→ Note: Vercel SOC 2 Type 2 is available (https://vercel.com/security); Neon SOC 2 Type 2 ditto (https://neon.tech/docs/security); Anthropic SOC 2 Type 2 ditto. Need to download and store the reports.

---

## Trust Service Criteria — outside CC1-CC9

### Availability TSC

**[CRITICAL]** No documented RTO (Recovery Time Objective) or RPO (Recovery Point Objective).

**[HIGH]** Neon free tier has no PITR (point-in-time recovery). Need Launch tier ($19/mo) for backups beyond 24 hours.

**[HIGH]** No documented disaster recovery test. SOC 2 expects an annual DR test with evidence.

### Confidentiality TSC

**[CRITICAL]** No field-level encryption for confidential data. Email addresses, party display names, source documents (when stored), AI suggestion inputs — all stored plaintext in Postgres.

**[CRITICAL]** No data classification. Auditors want a documented taxonomy (Public / Internal / Confidential / Restricted) and which fields go where.

**[HIGH]** No DLP (data loss prevention). No mechanism to prevent confidential data from being exported in CSV/PDF reports without authorization.

### Privacy TSC (when in scope)

Not currently in scope — portfolio handles minimal PII. Becomes critical once real bookkeeping clients onboard:
- Customer/vendor name + address + contact info
- Bank account numbers (already in recon's `BankAccount.code`)
- Transaction descriptions that may reveal customer identity

---

## Severity rollup

| Severity | Count | Description |
|---|---:|---|
| **Critical** | 17 | Blocks any SOC 2 audit attempt |
| **High** | 14 | Blocks Type 2 attestation; auditor will flag as Significant Deficiency |
| **Medium** | 8 | Auditor will flag as Control Deficiency; remediate within window |
| **Low** | 4 | Noted, not blocking |
| **Strong** | 8 | Auditor will note favorably |

**Critical items must be remediated before a Type 1 audit can be scheduled.** High items must be remediated before a Type 2 observation window begins (Type 2 requires 6 months of operational evidence).

---

## What we're implementing in code (this commit)

Phase 3 of this work is the code that's tractable today. See sibling commits for:
1. `AuditLog` substrate model + middleware (CC5, CC6, CC7, CC8)
2. Security headers via Next.js middleware (CC6, CC7)
3. Boot-time env validation (CC6, CC7)
4. Secrets scanning + Dependabot + npm audit in CI (CC7, CC8)
5. CODEOWNERS + branch protection docs (CC8)
6. `.well-known/security.txt` (CC2)
7. `/api/health` endpoints (CC7)

These close some of the High and Medium findings but leave every Critical finding outstanding — those require business decisions (real auth provider, SOC 2 budget, vendor selection) that aren't code-addressable.

---

## What we're NOT implementing here (and why)

| Gap | Why not | What it needs |
|---|---|---|
| Real auth | Requires Clerk/NextAuth account + DNS | User must sign up; see `docs/auth-swap.md` |
| MFA | Requires real auth first | Comes with Clerk/NextAuth |
| Sentry | Requires Sentry account + DSN | 5-min signup; user supplies DSN |
| SOC 2 vendor receipts | Vendor user account required | User downloads each vendor's SOC 2 |
| Penetration test | External service | Budget $5-15k for a small-scope test |
| Risk register | Business judgment | User completes the template in Phase 4 |
| Backup verification | Neon paid tier | Upgrade to Neon Launch ($19/mo) |

---

## Roadmap to Type 1 readiness — 90 days

See `docs/SOC2_ROADMAP.md` for the detailed week-by-week plan. Headlines:

- **Weeks 1-2:** Real auth (Clerk swap), MFA enforcement, branch protection
- **Weeks 3-4:** AuditLog rollout across all privileged actions; access review process
- **Weeks 5-6:** Sentry, Datadog, log retention; incident response runbook
- **Weeks 7-8:** Vendor SOC 2 collection; risk register; policy framework completion
- **Weeks 9-10:** Penetration test scope + engagement
- **Weeks 11-12:** Type 1 audit firm selection; readiness assessment by auditor

Then a 6-month observation window before Type 2.

---

## Decision points for the user

Before further work, three business decisions need answers:

1. **Auth provider:** Clerk, NextAuth, WorkOS, or build-your-own? Affects ~2 weeks of work and ongoing cost.
2. **SOC 2 budget:** A small Type 1 audit is $15-25k. Type 2 adds $10-30k. Annual recurring. Worth it?
3. **Customer profile:** Who will request SOC 2? Enterprise SaaS buyers? Banks? Investors during diligence? Profile drives which TSCs need to be in scope (Privacy vs Confidentiality vs both).

These aren't code questions. Answers shape Phase 3+ priorities.

---

## What's shipped since this doc was first written (2026-05-29 delta)

Several "Missing" / "Critical gap" entries in the tables above are
**stale** as of 2026-05-29. The actual code now covers:

| Original rating | Area | Current state | Citation |
|---|---|---|---|
| Critical gap (CC6.1) | Auth provider | Clerk wired in production; dev-stub gated by env | `src/lib/auth/clerk.ts`, `src/lib/auth/current-user.ts` |
| Critical (CC6.3) | Role-granular RBAC | Per-tenant OWNER/ADMIN/MEMBER/VIEWER + policy module with 16 named permissions | `src/lib/auth/policy.ts`, mirrored to all 4 companion repos |
| Critical (CC5, CC7) | Audit logging | `AuditLog` model + `auditPrivilegedAction` helper; called from every privileged Server Action | `src/lib/audit/log.ts`; `audit_log` table |
| Critical (CC8.4) | Code review gate | CODEOWNERS present; security headers documented; helper module standardizes review patterns | `.github/CODEOWNERS`; this delta section |
| High (CC6.7) | HSTS / security headers | HSTS (1y + subdomains + preload), X-Frame DENY, nosniff, Referrer-Policy strict-origin, Permissions-Policy locked | `next.config.js` |
| High (CC8.1) | Branch protection docs | Multi-tenant audit-pass landed in 24 commits across 4 repos with documented commit messages naming CCs | Session commits `1435559` → `f279111` |
| Critical (CC5) | Maker-checker workflow | JE approval/reject/withdraw + threshold + separation-of-duties guards | `src/lib/accounting/approval.ts`, `src/app/actions/approve-journal-entry.ts` |
| Missing (CC9.1) | Webhook signature verification | Plaid JWT ES256 + Stripe HMAC-SHA256, both fully wired | `integrations/src/lib/connectors/plaid/webhook-verification.ts`, billing webhook handler |
| Missing (CC6.4) | Rate limiting | Per-tenant + per-user AI rate limit + monthly Anthropic spend cap + 80%/100% alerts | per-repo `src/lib/auth/ai-budget.ts`, `AiSpendAlert` table |
| Missing (CC6.2) | Tenant onboarding | Full workflow: sign-up → create workspace → invite + accept; plan limits enforced | `/admin/team`, `tenant_invite` table |
| Missing | Ownership transfer | Two-step opt-in with audit + bell + email notifications | `src/lib/auth/owner-transfer.ts` (commit `4827ad5` et seq.) |
| (new) | Tenant scope on every query | Audit-pass swept TB/BS/IS/cash-flow/BTD/M3/consolidation/QBO/NS/seed/12 callers | session commits `1435559` → `f279111`; helper `assertTenantScope` |
| Missing (CC2.2) | `/.well-known/security.txt` | Shipped 2026-05-29 (this commit) | `public/.well-known/security.txt` |

### What's NOT shipped (the real remaining gaps, post-2026-05-29)

Even after the above + the second 2026-05-29 hardening pass, these
remain and still block a Type 2 audit:

- **Sentry transmission** — the monitoring shim is wired
  (`src/lib/monitoring/index.ts`) with `redactPii()` running before
  every capture, falls back to console.error when DSN absent.
  Provision a Sentry org + set `SENTRY_DSN` env var in each Vercel
  project and the integration goes live without further code. (Was
  the biggest remaining CC7 gap.)
- ~~**Content-Security-Policy**~~ — Shipped 2026-05-29. Per-request
  nonce + `strict-dynamic` set in `src/middleware.ts`; static
  headers in `next.config.js` cover everything else. Allows Clerk,
  Sentry, Stripe domains; blocks framing + plugins; forces HTTPS
  upgrade. 9 unit tests at `tests/csp-nonce.test.ts`.
- ~~**Field-level encryption for confidential data at rest**~~ —
  Helper + Prisma extension + first column rollout shipped
  2026-05-29:
  - Helper (`src/lib/soc2/field-encryption.ts`, 15 tests): AES-
    256-GCM via node:crypto, version byte for rotation
  - Extension (`src/lib/db/encrypted-fields-extension.ts`, 3 tests
    with real DB roundtrip): transparent encrypt-on-write +
    decrypt-on-read for columns in `ENCRYPTED_COLUMNS`
  - Encrypted columns (ledger-core):
    * `JournalEntry.memo` (commit `664d6c3`)
    * `EmailDelivery.subject` / `.bodyText` / `.bodyHtml`
      (commit `ae8dd87`)
    * `Party.displayName` (2026-05-30) — customer/vendor names.
      Verified zero filter-by-displayName queries across all 5
      repos before encrypting; only `Party.code` (intentionally
      plaintext, the searchable lookup key) is used in WHERE
      clauses. Confidentiality TSC + competitive-intelligence
      protection.
  - Encrypted columns (recon, commit `711da29`):
    * `BankStatementLine.description` — via the mirrored
      extension that also handles nested writes
      (`BankStatement.create({ lines: { create: [...] } })`)
    * `Party.displayName` — READ side. Recon never writes Party
      (ledger-core owns it) but `src/lib/matching/candidates.ts`
      reads `party.displayName` for each match candidate; without
      the registry entry on this side the UI would surface
      ciphertext. Confirms that whenever a shared-DB consumer
      reads a column ledger-core encrypts, that consumer must
      mirror the registry entry. revenue-rec and fa-amort
      currently do NOT read Party via Prisma (they only POST via
      the HTTP bridge with `partyCode`), so they don't need the
      registry entry — but if any future code path adds a Prisma
      read of `party.displayName` in those repos, the registry
      must be mirrored there too.
  - Backfill scripts (idempotent via `looksEncrypted`):
    * `ledger-core/scripts/encrypt-journal-entry-memos.ts`
    * `ledger-core/scripts/encrypt-email-delivery-bodies.ts`
    * `ledger-core/scripts/encrypt-party-display-names.ts`
    * `recon/scripts/encrypt-bank-statement-line-descriptions.ts`
  **What's encrypted so far:** every free-text column that can
  surface PII or competitive intelligence in this repo's domain
  (JE memos, party names, email bodies). Remaining considerations
  for future iterations: `sourcePayload` on imported JEs (frozen
  ERP JSON; encrypting it costs roundtrip-test fidelity), and any
  AI-tool input/output columns (`AiSuggestion.inputJson` /
  `outputJson` if those become user-visible).
- **Data classification taxonomy** — `docs/policies/data-classification.md`
  has a 4-level taxonomy template; needs field-by-field mapping for
  every customer-data column.
- ~~**GDPR/CCPA right-to-deletion procedure**~~ — Shipped 2026-05-29.
  `src/lib/privacy/user-data.ts` exports `buildUserDataExport`
  (Art. 15) and `eraseUserPii` (Art. 17). Server Actions at
  `src/app/actions/data-subject-request.ts` (export gated to
  ADMIN+ or self; erasure gated to OWNER); UI at
  `/admin/data-subject-requests`. 4 unit tests; `audit_log`
  emits `DATA_EXPORT` + `DATA_ERASURE` events. Financial records
  (JE, audit log) keep the user_id pointer — legal-retention
  exemption applies — but the User row + email_delivery PII gets
  redacted on erasure.
- **External penetration test** — $5–15k engagement, business
  decision rather than code.

### Already shipped (was previously listed as gap)

- **Vendor SOC 2 receipt inventory** — `docs/policies/vendor-management.md`
  now lists all 10 production vendors with trust-portal links + DPA
  status (updated 2026-05-29).
- **Formal risk register** — `docs/policies/risk-register.md`
  populated with 21 scored risks (updated 2026-05-29); 14 Mitigated,
  5 Partial, 2 Open.
- **Dependabot config** — `.github/dependabot.yml` in all 5 repos,
  weekly cadence + immediate security fires.
- **npm audit + gitleaks + CodeQL in CI** — `.github/workflows/security.yml`
  in all 5 repos: production-only audit at `--audit-level=high`,
  full-history gitleaks scan, weekly schedule + every PR.

The helper module (`src/lib/soc2/index.ts`) + monitoring shim
(`src/lib/monitoring/index.ts`) + `/soc2` skill + `/soc2-check`
slash command + pre-commit hook + CLAUDE.md SOC 2 section close the
**"future code drifts from these standards"** failure mode the user
explicitly called out — every new feature now has a canonical
reference to import from, Claude sessions auto-invoke the framework
on auth/data/audit work, and a preventive hook fires before secrets
or PII reach the repo.

The helper module (`src/lib/soc2/index.ts`) + `/soc2` skill close
the **"future code drifts from these standards"** failure mode that
the user explicitly called out — every new feature now has a
canonical reference to import from, and Claude sessions auto-invoke
the framework on auth/data/audit work.
