# Access review — YYYY-QN

**Date:** YYYY-MM-DD
**Reviewer:** [name]
**Audit-log row:** [audit_log row id of CONFIG_CHANGE/access_review.completed]

This file is a **template**. Copy it to `access-review-{YYYY-Q}.md`
(e.g. `access-review-2026-Q3.md`) on the first Monday of each
quarter per `docs/policies/access-control.md` "Access reviews"
procedure.

The completed quarterly file becomes the auditor's evidence that the
access review actually happened.

## Per-tenant memberships

Export from `/admin/access-review` (CSV) and paste below.

| Tenant | User | Role | Last login | Decision |
|---|---|---|---|---|
| | | | | Promote / Demote / Revoke / Keep |

## OWNER verification (highest-stakes)

For each OWNER, verify the OWNER is still the appropriate one:

| Tenant | OWNER | Verified? | Notes |
|---|---|---|---|
| | | Y / N | If N: ownership transfer in flight? |

## ADMIN verification

For each ADMIN, verify the assignment is still warranted:

| Tenant | ADMIN | Justification | Decision |
|---|---|---|---|
| | | | Promote / Demote / Keep |

## Service token rotation

For each of the 4 standing service tokens, verify rotation age
against the per-token cadence in `docs/policies/access-control.md`
"Service tokens" table.

| Token | Last rotated | Age | Within cadence? | Action |
|---|---|---|---|---|
| `INTERNAL_API_TOKEN` | YYYY-MM-DD | N days | Y/N | None / Rotate |
| `CRON_SECRET` | YYYY-MM-DD | N days | Y/N | None / Rotate |
| `FIELD_ENCRYPTION_KEY` | YYYY-MM-DD | N days | Y/N | None / Schedule rotation |
| `FIELD_DETERMINISTIC_KEY` | YYYY-MM-DD | N days | Y/N | None / Schedule rotation |

## Departed contributors (if any)

For each contributor who left this quarter, verify offboarding
completion against the 6-step procedure in
`docs/policies/access-control.md` "Deprovisioning" → "Contractor /
departing employee offboarding":

| Contributor | Departed | Vercel revoked? | CODEOWNERS removed? | User deactivated? | Tokens rotated? | Role-orphan check? |
|---|---|---|---|---|---|---|
| | YYYY-MM-DD | Y/N | Y/N | Y/N | Y/N | Y/N |

## Sign-off

| | |
|---|---|
| Reviewer | [name] |
| Date | YYYY-MM-DD |
| Audit-log row | `audit_log` row id |

This completes the quarterly access review. Filed in
`docs/policies/access-review-{YYYY-Q}.md`.

---

**Next review:** First Monday of the next calendar quarter.
