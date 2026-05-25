# Security policy

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}} · **Last reviewed:** {{DATE}}

## Purpose

This policy establishes how ledger-nexus protects customer data and system integrity. It satisfies SOC 2 CC1 (control environment) and serves as the umbrella for the more-specific policies in this directory.

## Scope

Applies to:
- All code in the 5 ledger-nexus repos: `ledger-core`, `recon`, `revenue-rec`, `integrations`, `fa-amort`
- Production deployments on Vercel and the shared Neon Postgres database
- All employees, contractors, and AI agents (including Claude) that contribute to the codebase
- All third-party services the system depends on (see `vendor-management.md`)

## Roles and responsibilities

| Role | Responsibility |
|---|---|
| Security Officer | {{NAME}} — owns every policy in this directory, runs annual review, tracks deficiencies |
| Engineering | Implements controls, runs tests, responds to incidents |
| All contributors | Read these policies, sign acknowledgement annually, follow `change-management.md` |

For solo-team operation, all roles map to {{NAME}}; the audit-trail compensating control is documented in `change-management.md`.

## Tone at the top

- **Customer financial data is the most valuable asset we handle.** Loss, leak, or unauthorized modification is the failure mode we optimize against.
- **Honesty in process is the most valuable habit we have.** If a control failed, it gets documented and remediated; it does not get hidden.
- **AI is a tool, not an actor.** Every AI surface follows the "AI proposes; humans approve; substrate posts" pattern. No AI writes to ledger state without human ratification.

## Acceptable use

Production credentials (Vercel tokens, Neon connection strings, internal API tokens, Anthropic API keys) MUST NOT be:
- Committed to git (caught by gitleaks CI; see `.github/workflows/security.yml`)
- Shared via Slack, email, or screenshots
- Stored in IDE config files

Production credentials MAY be:
- Pasted into Vercel's environment-variable UI
- Stored in 1Password / Bitwarden / similar
- Generated and rotated by the deploy script (`bin/deploy.sh`)

## Annual review

This policy is reviewed annually on {{REVIEW_DATE}}. Changes are tracked in git history.

## References

- `access-control.md` — CC6
- `change-management.md` — CC8
- `incident-response.md` — CC7
- `risk-register.md` — CC3
- `vendor-management.md` — CC9
- `SOC2_READINESS.md` — current SOC 2 gap analysis
