# Security policy

## Reporting a vulnerability

If you have found a security issue in this repository, please report it
**privately** via one of:

- Email: `security@ledger-nexus.com` (replace with real address when
  the domain is provisioned)
- GitHub: open a private security advisory at
  https://github.com/ledger-nexus/ledger-core/security/advisories/new

Please **do not** open a public GitHub issue for security problems.

## Response timeline

- **48 hours**: acknowledgement of receipt
- **7 days**: initial triage + severity assessment
- **30 days**: fix or remediation plan, whichever applies
- **90 days**: public disclosure following the standard responsible-
  disclosure window after the fix ships

## In-scope

- All code in this repository
- Production deployment at the published URL (when one exists)
- Internal HTTP boundary endpoints (`/api/internal/*`) — token-gated;
  bypass attempts welcome

## Out-of-scope

- Third-party services we depend on (Vercel, Neon, Anthropic, Plaid,
  GitHub) — report directly to those vendors
- Social engineering against employees
- Physical security of contributor workstations

## Recognition

We don't currently offer a bug bounty. We will acknowledge reporters
in the project changelog with permission, and provide a signed letter
of acknowledgement on request.

## SOC 2 framework

This project is approaching SOC 2 Type 1 audit readiness. The
authoritative artifacts:

- `docs/SOC2_READINESS.md` — current assessment + per-criterion status
- `docs/SOC2_CONTROL_MATRIX.md` — CC1–CC9 + 4 TSCs → file/line evidence map
- `docs/policies/` — 10-document policy framework (security, access-control,
  change-management, incident-response, data-classification, data-subject-
  requests, vendor-management, risk-register, business-continuity,
  control-deficiency-log, bypass-log)
- `docs/architecture/portfolio-data-locations.md` — portfolio-wide data
  location map (auditor entry point)

## Incident handling

If your report meets the SEV-1 or SEV-2 bar (production data exposure,
auth bypass, unauthorized JE post, encryption-key compromise, vendor
breach), it gets triaged per the procedure in
`docs/policies/incident-response.md` — acknowledgement within 15 minutes,
status update within 30 minutes, GDPR Art. 33 notification within 72
hours if PII is confirmed exposed.

Operational steps for the on-call engineer live in
`docs/runbooks/incident-response.md`.

