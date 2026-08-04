# Security policy

**Version:** 2.0 · **Effective date:** 2026-06-03 · **Owner:** Founder (sole maintainer) · **Last reviewed:** 2026-06-03
**Prior version:** 1.0 (pre-multi-tenant, pre-Clerk, pre-portfolio-policy-suite)

This is the SOC 2 CC1 (Control Environment) **umbrella policy**.
Every other policy in this directory is sub-policy under this one;
each is referenced below with what criterion it satisfies + its
current version. The auditor reads this doc first to understand the
overall posture, then drills into the specifics.

If a contradiction surfaces between this document and any sub-policy,
the sub-policy is authoritative. This doc is the **table of contents
+ tone-at-the-top**; the sub-policies are the operating procedures.

## Purpose

This policy establishes how the ledger-nexus portfolio protects
customer data and system integrity. It satisfies SOC 2 CC1 (Control
Environment) and serves as the umbrella for the specific policies
that satisfy CC2–CC9 + the four TSCs in scope (Confidentiality,
Privacy, Availability, Processing Integrity).

## Scope

Applies to:

- All code in the 5 ledger-nexus repos: `ledger-core`, `recon`,
  `revenue-rec`, `integrations`, `fa-amort`
- Production deployments on Vercel + the shared Neon Postgres database
- All employees, contractors, and AI agents (including Claude) that
  contribute to the codebase
- All third-party services the system depends on (see
  `vendor-management.md`)
- All customer data the system processes — see
  `docs/architecture/portfolio-data-locations.md` for the portfolio-
  wide map

## Tone at the top

The principles every contributor (human or AI) is expected to apply:

1. **Customer financial data is the most valuable asset we handle.**
   Loss, leak, or unauthorized modification is the failure mode we
   optimize against. Every architectural decision asks "what's the
   blast radius?" before "what's the dev velocity?"
2. **Honesty in process beats appearance of completeness.** If a
   control failed, it gets documented and remediated; it does not
   get hidden. The bypass-log file
   (`docs/policies/bypass-log.md`) is the cultural expression of this.
3. **AI is a tool, not an actor.** Every AI surface follows the "AI
   proposes; humans approve; substrate posts" pattern. No AI writes
   to ledger state without human ratification (CLAUDE.md
   non-negotiable #3).
4. **Defense-in-depth, not single-point-of-prevention.** Every
   sensitive operation has at least two independent controls (e.g.,
   AES encryption + per-tenant query scoping; service-token gate +
   audit log; pre-commit hook + CI checks).
5. **Fail closed, not open.** When in doubt — env var missing, token
   not verifiable, schema fingerprint mismatched — refuse the
   operation. Boot-time env validation (`src/lib/env.ts`) is the
   anchor.
6. **Auditability over auditability theater.** Every privileged
   action lands in `audit_log` with append-only Postgres RULE
   enforcement; the auditor's evidence is queryable, not narrated.

## Roles and responsibilities

| Role | Responsibility | Today's holder |
|---|---|---|
| Security Officer / Privacy Lead | Owns every policy in this directory; runs annual review; tracks deficiencies | Founder |
| Engineering | Implements controls; runs tests; responds to incidents | Founder |
| All contributors | Read these policies; sign acknowledgement annually; follow `change-management.md` | Founder + Claude (AI contributor — read CLAUDE.md SOC 2 section on every session) |

For solo-team operation, all roles map to the founder; the
audit-trail compensating control is documented in
`change-management.md` "Solo-dev exception" section.

**Trigger to add a separate Security Officer role:** second employee
joins, OR first SOC 2 audit kickoff, whichever comes first.

## Policy directory (sub-policies + their criteria)

The criterion each sub-policy satisfies, and the current version.
**Latest version in `main` may lag the version in an open PR.** Where
applicable the open-PR version is noted.

| Sub-policy | Criterion | Current version | Last reviewed |
|---|---|---|---|
| `security.md` (this file) | CC1 (Control Environment) | 2.0 | 2026-06-03 |
| `access-control.md` | CC6.1, CC6.2, CC6.3 (Logical access, provisioning, role-granular) | 2.0 (PR #17) | 2026-06-03 |
| `change-management.md` | CC8 (Change Management) | 2.0 (PR #16) | 2026-06-03 |
| `incident-response.md` | CC7.3, CC7.4 (Security event evaluation + response) | 1.0 (refresh pending; runbook on `incident-response-runbook` branch) | 2026-06-03 |
| `data-classification.md` | CC6, Privacy TSC | Current (latest hardening checked in main + DSR/retention checkboxes flipped) | 2026-06-03 |
| `data-subject-requests.md` | Privacy TSC | New (PR #13) — GDPR Art. 15/17/16/20/21 + CPRA equivalents | 2026-06-03 |
| `vendor-management.md` | CC9 (Risk Mitigation) | 2.0 (PR #19) | 2026-06-03 |
| `risk-register.md` | CC3 (Risk Assessment) | 2.0 (PR #15) | 2026-06-03 |
| `business-continuity.md` | CC7 (System Operations), Availability TSC | 2.0 (PR #18) | 2026-06-03 |
| `control-deficiency-log.md` | CC4 (Monitoring) | Current | Per-deficiency basis |
| `bypass-log.md` | CC8 compensating control | Skeleton (PR #16) | Per-bypass basis |

## Standing reference artifacts (cross-criterion)

These are the code/file paths the auditor will see referenced across
multiple sub-policies. Each one is a single source of truth.

| Artifact | What it does | Sub-policies that reference it |
|---|---|---|
| `src/lib/soc2/index.ts` | SOC 2 helper module — `assertTenantScope`, `constantTimeEqual`, `redactPii`, `sanitizeError`, `auditedMutation`, etc. | access-control, change-management, data-classification, DSR |
| `src/lib/auth/current-user.ts`, `src/lib/auth/tenant.ts` | Auth + per-tenant role checks (`isAdmin` / `isTenantAdmin` / `requireAdmin`). A centralized `policy.ts` permission catalog is **planned, not built** (access-control v2.1, deficiency #29). | access-control |
| `src/lib/audit/log.ts` | `logAuditEvent` + `auditPrivilegedAction` + `auditedMutation` | change-management, access-control, incident-response, DSR, retention |
| `src/lib/db/encrypted-fields-extension.ts` | Prisma client extension — transparent AES-256-GCM encryption + HMAC search hashes | data-classification, DSR, business-continuity (key-loss scenario) |
| `src/lib/retention/policies.ts` | Declarative retention registry walked by `/api/cron/retention` | data-classification, retention, change-management |
| `prisma/sql/audit-log-append-only.sql` | Postgres RULE making `audit_log` immutable | change-management, incident-response, BC (audit-log gap), vendor-management |
| `src/middleware.ts` | CSP nonce + HTTPS upgrade + auth boundary | access-control |
| `src/lib/env.ts` + `src/instrumentation.ts` | Boot-time env validation — fails closed on missing required env | change-management, BC |
| `src/lib/monitoring/index.ts` | Sentry shim with `redactPii` + console fallback | incident-response, vendor-management |
| `src/app/api/health/route.ts` | DB ping + schema fingerprint + encryption status | change-management (CC8.1), BC (recovery verification) |
| `scripts/pre-commit-secrets-scan.sh` | Pre-commit hook — secrets + console.log PII scan | change-management |
| `.claude/commands/soc2-check.md` | Slash command for per-diff SOC 2 audit | change-management |
| `.claude/skills/soc2/SKILL.md` | Skill that surfaces SOC 2 framework into every Claude session | CC2 (internal communication of policies) |

## Acceptable use

**Production credentials** (Vercel CLI tokens, Neon connection strings,
service tokens — `INTERNAL_API_TOKEN`, `CRON_SECRET`,
`FIELD_ENCRYPTION_KEY`, `FIELD_DETERMINISTIC_KEY`, Clerk admin
credentials, Anthropic API keys, Stripe live keys, Resend API key)
MUST NOT be:

- Committed to git (caught by `scripts/pre-commit-secrets-scan.sh`)
- Shared via Slack, email, screenshots, or chat (including AI chat
  surfaces — Claude sessions never see production secrets)
- Stored in IDE config files or shell history
- Discussed in any public forum (issue tracker, PR description,
  social media)

Production credentials MAY be:

- Stored in Vercel's encrypted env variable UI (operational copy)
- Stored in 1Password (canonical copy + emergency-kit per BC policy)
- Generated by `openssl rand -hex 32` and rotated per
  `access-control.md` cadence

## Acceptable use — AI contributors (Claude)

The portfolio relies on Claude as an AI contributor. Specific rules
in addition to the human acceptable-use:

1. **Claude reads CLAUDE.md on every session.** The SOC 2 framework
   section is non-negotiable; conflicts with user requests must be
   surfaced + clarified before proceeding.
2. **Claude never sees production secrets.** Local dev `.env.local`
   uses test values; production env is set in Vercel directly.
3. **Claude operates against a fork or branch, never against `main`
   directly.** The branch-protection rules from `change-management.md`
   apply equally to AI-authored commits.
4. **Claude commits are co-authored** with the visible "Claude as
   AI contributor" attribution so the git history accurately reflects
   who wrote what.
5. **Claude does not execute irreversible destructive operations**
   (`git push --force`, `git reset --hard`, `prisma migrate reset`,
   `vercel rm`, DB DROPs) without explicit per-operation user
   confirmation in chat. This is the harness-enforced default plus
   the policy reinforcement.

## Annual policy acknowledgement

Every contributor (human or AI) acknowledges the policy directory
annually. For solo operation: the founder commits a signed file at
`docs/policies/annual-acknowledgement-{YYYY}.md` with a list of every
sub-policy version they read, plus an audit-log row
`CONFIG_CHANGE/policy.acknowledged`.

When a second contributor joins, each one signs their own
acknowledgement file with the same format.

## Annual review

Reviewed annually. Trigger an out-of-cycle review when:

- A sub-policy bumps its major version (e.g., access-control 2.0 →
  3.0 — happened twice this year)
- A new sub-policy is added to the directory
- A SOC 2 audit kickoff is scheduled
- A new contributor joins (re-acknowledgement triggers a sweep)
- An incident postmortem identifies a policy gap

The review itself goes in the audit log as
`CONFIG_CHANGE/security_policy.review` by the founder.

## References

Sub-policies (every one of these is required reading for any
contributor):

- `access-control.md` — CC6.1–CC6.3
- `change-management.md` — CC8
- `data-classification.md` — CC6 + Privacy
- `data-subject-requests.md` — Privacy TSC
- `incident-response.md` — CC7.3, CC7.4
- `vendor-management.md` — CC9
- `risk-register.md` — CC3
- `business-continuity.md` — CC7 + Availability
- `bypass-log.md` — CC8 compensating control (operational ledger of bypasses)
- `control-deficiency-log.md` — CC4 (operational ledger of identified failures)

Standing reference docs (cross-criterion):

- `docs/architecture/portfolio-data-locations.md` — portfolio-wide
  data location map (auditor entry point)
- `docs/SOC2_CONTROL_MATRIX.md` — CC1–CC9 → file/line evidence map
- `docs/SOC2_READINESS.md` — gap analysis (updated per sprint)
- `docs/runbooks/encryption-rollout.md` — key rotation runbook
- `docs/runbooks/incident-response.md` — operational runbook (paired
  with the incident-response.md policy)
