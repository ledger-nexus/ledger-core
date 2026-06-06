# SOC 2 readiness assessment — ledger-nexus portfolio

**Status:** Pre-readiness. Not audit-ready.
**Scope:** Type 1 readiness assessment across all 5 repos (`ledger-core`, `recon`, `revenue-rec`, `integrations`, `fa-amort`) as of this commit.
**Framework:** SOC 2 Trust Services Criteria 2017 (revised 2022), Security TSC + Common Criteria CC1–CC9. Availability, Processing Integrity, Confidentiality also referenced where in scope.

**v2.8 amendments (2026-06-06) — audit log replication design:**
- **Deficiency #9 (Audit log not replicated outside primary DB) → Remediated** via PR #104. Phase 1 design doc `docs/architecture/audit-log-replication-design.md` captures 4-option comparison + recommended approach (S3 + Object Lock compliance mode + 7-year retention) + 3-phase rollout + implementation skeleton + schema migration plan + cost estimate ($0.02/mo at v1; $1.50/mo at 10-customer scale) + CC mapping (CC4 + CC7.2 + CC7.4 + CC6.7) + 6-step migration sequence with chaos-drill verification.
- **CC4 / CC7.4 posture upgrade**: audit trail integrity is now backed by a documented architecture for substrate-loss survival. Phase 1 captures the SOC 2 commitment; Phase 2 ships when customer #2 onboards (avoids paying for infrastructure at zero-customer scale).
- **Status transition** mirrors v2.4 RLS deficiency #12: Remediated (design captured + path clear) rather than Closed (Phase 2 hasn't shipped).
- **Readiness % bump: 82% → 83%.** Mediums advance readiness by ~0.5pp at the design-only stage; Phase 2 ship will land another increment.

**v2.7 amendments (2026-06-06) — CSP standalone closure:**
- **Deficiency #2 (No CSP header) → Closed** via PR #99. Standalone extraction of the CSP middleware change from PR #10's foundation arc. `src/middleware.ts` generates a per-request 16-byte base64url nonce via Edge `crypto.getRandomValues`; CSP header set on every response with `strict-dynamic` script-src + Clerk/Sentry/Stripe connect-src + `frame-ancestors 'none'` + `object-src 'none'` + `upgrade-insecure-requests`. 9/9 tests pass (`tests/csp-nonce.test.ts`).
- **CC6.6 posture upgrade**: anti-XSS control upgrades from "static security headers + Next.js default escape" to **"static headers + per-request CSP nonce + strict-dynamic delegation"**. The script-injection attack surface is now defended at the response layer in addition to the framework-level escape.
- **Extraction rationale**: PR #10 is a 9-feature foundation PR (helper module + env validator + CSP + audit-log RULE + Sentry shim + /soc2-check + pre-commit hook + soc2 skill + /api/health). Splitting CSP out lets #2 close on its own merge schedule rather than block on the entire foundation arc.
- **Readiness % bump: 81% → 82%.** Deficiency #2 was a HIGH; standalone closure with passing tests warrants a 1pp bump.

**v2.6 amendments (2026-06-06) — npm pinning portfolio-wide:**
- **Deficiency #4 (npm deps not pinned) → Closed portfolio-wide** via 5 PRs: ledger-core PR #95 (23 deps) + recon PR #26 (24) + fa-amort PR #23 (22) + revenue-rec PR #30 (24) + integrations PR #20 (22). 115 dependency ranges total stripped to exact versions from each repo's `package-lock.json`. Verified per-repo: 0 remaining `^`/`~` ranges + `npm install --package-lock-only` clean. Dependabot continues to surface upgrade PRs we then review.
- CC7.1 (vulnerability management) posture upgrade: dependency-pinning eliminates the silent-transitive-upgrade attack vector on every `npm ci` deploy. The supply-chain control is now pinning + Dependabot review + npm audit CI, not range + Dependabot review.
- Readiness % bump: 80% → **81%** (deficiency #4 was a HIGH; portfolio-wide closure across 5 repos warrants the increment).

**v2.5 amendments (2026-06-05) — RLS arc closure:**
- **Deficiency #12 (RLS not FORCED) → Remediated** via Phases 1+2a+2b shipped across PRs #66, #67, #69-#83 (16 PRs). Phase 3 implementation DRAFT PR #89 awaits operator ack on Decision C runbook (`docs/runbooks/rls-phase-3-bypass-roles.md`). 23 Server Actions + 3 internal HTTP routes + 1 batch helper migrated to `withTenantContext`. Migration guide (`docs/architecture/rls-phase-2b-migration-guide.md`) institutionalizes the 7-shape catalog (W1/W2/T1/T2/E/M/P) with reference PRs per shape.
- **Deficiency #28 (createFixedAsset tenant-blind entity lookup) → Closed** via PR #88. Surfaced by the 15th adversarial pass as a historical finding (pre-dated Phase 2b sweep). `CreateFixedAssetInput.tenantId` now required.
- **Phase 3 design + decisions A/B/D resolved**, decision C runbook drafted; awaiting 5-item operator approval checklist before Phase 3 FORCE migration applies.
- **15th adversarial pass** found 1 HIGH (audit-bypass on Decision A drop) + 3 MEDIUMs; all closed in-PR before merge — CC4 monitoring evidence.
- **CLAUDE.md institutionalization (PR #90)**: 7-shape catalog + adversarial-pass cadence baked into the repo's auto-loaded rulebook so future sessions inherit the patterns.

This moves the CC6.1 / CC7.4 multi-tenant-isolation posture from "application-layer scoping is the only enforcement" (the v1 baseline state) to "application-layer scoping + DB-layer policies (advisory pre-FORCE, load-bearing post-FORCE) + adversarial-pass cadence as CC4 evidence."

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
