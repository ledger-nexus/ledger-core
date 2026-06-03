# Incidents

**Owner:** Founder (Incident Commander by default; see `docs/policies/incident-response.md` for role-split triggers)
**Last reviewed:** 2026-06-03

This directory holds the **evidence trail** for every security or
availability incident the portfolio handles. Each file in here is
an auditable record an SOC 2 assessor reads to verify the response
procedure operated as documented in
`docs/policies/incident-response.md`.

If this directory is empty, that means no SEV-1 or SEV-2 incidents
have occurred since the policy was adopted. That is the desired
steady state.

## File naming

Two file kinds live here:

### Per-incident files

```
YYYY-MM-DD-<short-slug>.md
```

Example: `2026-06-15-leaked-internal-api-token.md`

One file per incident. Created the moment an incident is acknowledged
(per the SLA in `incident-response.md`). The file holds the
chronological timeline during the incident and becomes the postmortem
after resolution.

### Annual tabletop exercises

```
tabletop-YYYY.md
```

Example: `tabletop-2027.md` (created at the annual tabletop exercise
on the second Monday of January per the IR policy).

## Per-incident file format

Each per-incident file follows the postmortem template from
`docs/policies/incident-response.md` "Postmortem requirements":

```markdown
# YYYY-MM-DD — Short description (e.g., "Leaked internal API token")

**Severity:** SEV-1 / SEV-2 / SEV-3 / SEV-4
**Status:** Open / Contained / Resolved
**Opened:** YYYY-MM-DD HH:MM TZ
**Closed:** YYYY-MM-DD HH:MM TZ
**Incident Commander:** [name]
**Audit-log row(s):** [list of audit_log row ids]
**Affected tenants:** [count or "all"]
**PII overlay triggered:** Yes / No (if Yes, see GDPR Art. 33/34 section below)

## Summary

One paragraph: what happened, who was affected, how long it lasted.

## Impact

Quantified customer impact: tenant count, data volume, dollar value
where relevant. Whether PII was exposed.

## Timeline

Chronological "what we knew, what we did" with timestamps. Updated
in real time during the incident; frozen at resolution.

| HH:MM TZ | What we observed / did |
|---|---|
| 12:00 | Sentry alert fired … |
| 12:03 | IC acknowledged … |
| … | … |

## Root cause

5-whys analysis ending at a code or process root, not a person.
Blameless per the IR policy.

## What worked

Controls + procedures that fired correctly.

## What didn't

Controls that failed; gates that didn't trigger; detection paths
that were delayed.

## Action items

| Owner | Description | Due date | Status |
|---|---|---|---|
| Founder | … | YYYY-MM-DD | Open / Done |

## Updated risk register

Any new risk discovered AND any existing risk whose score changes
based on this incident. Cross-reference the `docs/policies/risk-register.md`
row numbers.

## GDPR Art. 33/34 actions (if applicable)

If the PII overlay triggered:

- **Art. 33 notification** to supervisory authority — sent YYYY-MM-DD at HH:MM
- **Art. 34 notification** to affected data subjects — sent / not required (Art. 34(3)(a) encryption-at-rest carve-out documented below)
- **Encryption-at-rest defense status:** held / failed
```

## Tabletop file format

```markdown
# Tabletop YYYY — [scenario name]

**Date:** YYYY-MM-DD
**Facilitator:** [name]
**Participants:** [list]
**Scenario source:** internal hypothetical / real industry incident from past 12 months

## Scenario summary

What the exercise simulated.

## Walkthrough

How we walked through the procedure (detect → acknowledge → contain
→ investigate → communicate → remediate → postmortem) as if it were
real.

## Gaps surfaced

What didn't quite work. What we'd do differently in a real incident.

## Action items

| Owner | Description | Due date | Status |
|---|---|---|---|
```

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "Show me a real incident you handled" | `YYYY-MM-DD-<slug>.md` per incident |
| "Show me your tabletop exercise history" | `tabletop-YYYY.md` per year |
| "Show me the audit-log row corresponding to a specific incident" | Per-incident file's `Audit-log row(s)` header field |
| "Show me your postmortem requirements" | `docs/policies/incident-response.md` → "Postmortem requirements" |
