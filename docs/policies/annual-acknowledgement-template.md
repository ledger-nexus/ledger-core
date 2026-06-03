# Annual policy acknowledgement — YYYY

**Date:** YYYY-MM-DD
**Acknowledger:** [name]
**Audit-log row:** [audit_log row id of CONFIG_CHANGE/policy.acknowledged]

This file is a **template**. Copy it to `annual-acknowledgement-{YYYY}.md`
(e.g. `annual-acknowledgement-2027.md`) on the first Monday of January
per `docs/policies/security.md` "Annual policy acknowledgement"
procedure.

Every contributor (human or AI) acknowledges the policy directory
annually. The completed file becomes the auditor's evidence.

## Policies read

For each sub-policy, fill in the version number read and date read.
The versions must match the current `main` head on the date of
acknowledgement.

| Sub-policy | Version read | Date read |
|---|---|---|
| `security.md` (umbrella) | | |
| `access-control.md` | | |
| `change-management.md` | | |
| `data-classification.md` | | |
| `data-subject-requests.md` | | |
| `incident-response.md` | | |
| `vendor-management.md` | | |
| `risk-register.md` | | |
| `business-continuity.md` | | |
| `bypass-log.md` (read for context — verify steady state) | | |
| `control-deficiency-log.md` (read for open items) | | |

## Cross-cutting docs read

| Doc | Version / commit head | Date read |
|---|---|---|
| `docs/SOC2_READINESS.md` | | |
| `docs/SOC2_CONTROL_MATRIX.md` | | |
| `docs/architecture/portfolio-data-locations.md` | | |
| `CLAUDE.md` (this repo + 4 companions) | | |

## Acknowledgement

By signing below, the acknowledger affirms:

1. I have read every sub-policy listed above at the version
   indicated.
2. I understand the non-negotiables in the `security.md`
   "Tone at the top" section.
3. For human contributors: I will follow the gates in
   `change-management.md` and the acceptable-use rules in
   `security.md`.
4. For AI contributors (Claude): I will read CLAUDE.md on every
   session, never see production secrets, branch-only-never-main,
   co-author commits, no irreversible destructive operations without
   explicit per-operation confirmation.
5. If any policy conflicts with a user request in a future session,
   I will surface the conflict and ask before proceeding.

## Sign-off

| | |
|---|---|
| Acknowledger | [name] |
| Date | YYYY-MM-DD |
| Audit-log row | `audit_log` row id |

---

**Next acknowledgement:** First Monday of the next calendar year.
