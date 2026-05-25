# Policies — SOC 2 framework

This directory holds the policy documents an SOC 2 auditor will ask to see. They are TEMPLATES — the {{PLACEHOLDERS}} need real answers before they're audit-ready.

## Required policies (CC1, CC3, CC5, CC6, CC7, CC8, CC9)

| File | Covers | Audit criterion |
|---|---|---|
| `security.md` | Tone-at-the-top, acceptable use, ethics | CC1 |
| `access-control.md` | Auth, RBAC, MFA, access reviews, provisioning | CC6 |
| `change-management.md` | PR review, CI gates, deploy approvals | CC8 |
| `incident-response.md` | Detection, escalation, postmortem | CC7 |
| `data-classification.md` | Public / Internal / Confidential / Restricted; retention | CC6, Privacy |
| `vendor-management.md` | Inventory of all upstream vendors + SOC 2 receipts | CC9 |
| `risk-register.md` | Top risks, likelihood × impact, mitigation status | CC3 |
| `business-continuity.md` | RTO/RPO, backup strategy, DR test cadence | CC7, Availability |
| `control-deficiency-log.md` | Ongoing log of identified failures and remediation | CC4 |

## Process

1. Fill in the placeholders in each policy with real answers.
2. Each policy needs a signed acknowledgement from each person it applies to. For a solo dev, you sign your own.
3. Annual review: every policy gets reviewed once a year. Document the review date and any changes at the top of each doc.
4. Bring this directory to your SOC 2 auditor's kickoff meeting. They will ask for these documents BEFORE they begin testing controls.

## What policies are NOT

They are not novels. The shortest SOC 2 policy I've ever seen is one page; the longest, ~5 pages. Auditors care about whether the policy MATCHES the code/process you're running, not how long it is. Lie in the policy → fail the audit. Match the policy to what you actually do, even if that's "we use Vercel and Neon and trust them" → pass.

## Order of operations

For pre-audit prep:
1. **risk-register.md** first — establishes what you're protecting against
2. **data-classification.md** second — establishes what's sensitive
3. **access-control.md** third — gates how people interact with sensitive data
4. **change-management.md** fourth — gates how production changes
5. **incident-response.md** fifth — what to do when (4) fails
6. **vendor-management.md** sixth — covers your blast radius
7. **business-continuity.md** seventh — what to do if a vendor goes down
8. **security.md** zeroth or last — the umbrella that references all of the above
9. **control-deficiency-log.md** ongoing
