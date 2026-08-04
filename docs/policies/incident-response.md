# Incident response policy

**Version:** 2.0 · **Effective date:** 2026-06-03 · **Owner:** Founder (sole maintainer)
**Last reviewed:** 2026-06-03
**Prior version:** 1.0 (titled "Incident response runbook"; conflated policy + runbook)

This is the SOC 2 CC7.3 (Security Event Evaluation) + CC7.4 (Incident
Response) anchor document.

**Policy vs runbook split.** v1.0 conflated the two. v2.0 splits them:

- This file (`docs/policies/incident-response.md`) is the **policy** —
  what counts as an incident, severity matrix, roles, SLAs, comms
  obligations, postmortem requirement. The auditor reads this.
- `docs/runbooks/incident-response.md` (on `incident-response-runbook`
  branch — PR pending) is the **runbook** — operational steps during
  a live incident. The on-call engineer reads this.

## Purpose

Detect, contain, investigate, communicate, and learn from security
and availability incidents. Every step has a documented SLA and an
audit-log emission so a regulator can verify the response after the
fact.

## What counts as an incident

| Severity | Definition | Examples | Acknowledgement SLA | External comms SLA |
|---|---|---|---|---|
| **SEV-1** | Production down OR customer data at risk of loss/leak/unauthorized access | All Vercel deploys 503; Neon DB unreachable; encryption-key compromise; suspected unauthorized `audit_log` access; PII exfiltrated; unauthorized JE posted; period-close bypassed | < 15 min | < 30 min status page + 72h GDPR Art. 34 notification if PII confirmed exposed |
| **SEV-2** | Major feature degraded OR security control failing-open | `/api/internal/*` returning 500s; Clerk auth degraded; `FIELD_ENCRYPTION_KEY` unset mid-deploy; CI gate bypassed in one repo; retention cron silently stopped | < 1 hour | Within 4 business hours via status page if customer-facing |
| **SEV-3** | Single feature broken with workaround OR isolated tenant impact | One Server Action throws on a specific tenant; CSV export broken; Sentry error spike < 100 events/h | Next business day | None unless customer reports |
| **SEV-4** | Cosmetic, low-priority, fully self-recovered | UI typo; auto-scaled past a transient spike; expected error in a known-flake test | Triage at next planning | None |

**Default-up rule:** anything you're not sure about → treat as one
level higher than you think and downgrade after triage. False
alarms are cheaper than ignored real ones.

**Privacy-incident overlay:** any incident classified SEV-1 OR SEV-2
that involves customer PII triggers the privacy-incident sub-procedure
(GDPR Art. 33 within 72 hours to supervisory authority; GDPR Art. 34
to data subjects if "high risk").

## Detection sources

| Source | What it catches | Who notices |
|---|---|---|
| **Sentry** (when DSN provisioned) | Unhandled exceptions, error-rate spikes | Automated alert → founder email |
| **Vercel built-in health checks** | Deployment 5xx, function timeout | Vercel UI dashboard |
| **`/api/health` endpoint** | DB connectivity, schema fingerprint mismatch, missing required env | Operator (cron-monitored when wired) |
| **Audit-log queries** | Anomalous patterns — `outcome=ANOMALOUS` events, unexpected `eventType=SECURITY_EVENT`, missing retention-cron rows in past 24h | Operator (manual today; scheduled query post-paying-customer) |
| **Customer report** | What we missed | Email to `security@<domain>` (pending domain provisioning); GitHub security advisory |
| **Internal noticing** | What we missed | Whoever happens to look at the right thing |

## Roles during an incident

Solo posture: founder fills all four roles.

| Role | Responsibility |
|---|---|
| Incident Commander (IC) | Owns the response; makes decisions; communicates externally; ends the incident |
| Engineer on duty | Investigates, fixes, deploys |
| Comms | Updates status page, customer email, internal stakeholders; coordinates with privacy lead for PII overlay |
| Scribe | Writes the timeline doc in real time; converts to postmortem |

**Trigger to split roles:** second contributor joins. The IC role
separates first; the Scribe role separates second.

## Response procedure (policy-level)

The operational steps are in `docs/runbooks/incident-response.md`.
The policy-level requirements:

1. **Acknowledge** within the per-severity SLA above.
2. **Open an incident timeline** at `docs/incidents/YYYY-MM-DD-<slug>.md`.
   The timeline is a chronological "what we know, what we did" with
   timestamps; lives in source control under git history so it's
   auditable.
3. **Contain.** Stop the bleeding before investigating the cause —
   revert, rotate, redeploy, or block.
4. **Investigate.** Pull logs (Vercel function logs, audit-log
   queries, git history, customer report). Document hypotheses + what
   ruled them out in the timeline.
5. **Communicate** per the External Comms SLA in the severity matrix.
   The Comms role coordinates; for PII overlay the privacy lead
   coordinates GDPR Art. 33/34 notifications.
6. **Remediate.** Permanent fix with tests OR a documented compensating
   control OR a documented decision-to-accept-risk recorded in the
   risk register.
7. **Audit-log emit** `SECURITY_EVENT/incident.<id>` at every state
   transition (opened, contained, investigated, communicated, resolved).
8. **Postmortem** within 5 business days for SEV-1/SEV-2.

## Postmortem requirements (CC7.4)

Within 5 business days of incident resolution, a blameless postmortem
is published at `docs/incidents/YYYY-MM-DD-<slug>.md` (same path as
the timeline; the timeline becomes the postmortem's "Timeline"
section).

The postmortem MUST include:

| Section | Required content |
|---|---|
| Summary | One paragraph: what happened, who was affected, how long it lasted |
| Impact | Quantified customer impact; tenant count, data volume, dollar value where relevant |
| Timeline | The real-time timeline from the incident |
| Root cause | 5-whys analysis ending at a code or process root, not a person |
| What worked | Controls + procedures that fired correctly |
| What didn't | Controls that failed; gates that didn't trigger; detection paths that were delayed |
| Action items | Concrete code or policy changes with owner + due date |
| Updated risk register | Any new risk discovered AND any existing risk whose score changes |

**Blameless** means: no individual contributor is named as the
proximate cause. Code paths, process gaps, and decision-trees are
named; people are not. This is a cultural commitment (security.md
tone-at-the-top #2) and a regulatory one (auditors hate
finger-pointing postmortems because they suppress reporting).

## Specific incident-class runbooks

Operational steps for the most common SEV-1 classes are in
`docs/runbooks/incident-response.md`. Each class has a written
sub-runbook with stop-the-bleeding commands. As of 2026-06-03:

| Class | Runbook location | Audit-log row |
|---|---|---|
| Leaked credential | `docs/runbooks/incident-response.md` → "Leaked credential" | `SECURITY_EVENT/credential.rotated` |
| Unauthorized JE posted | `docs/runbooks/incident-response.md` → "Unauthorized JE posted" | `SECURITY_EVENT/journal_entry.unauthorized` |
| Period reopened without authorization | `docs/runbooks/incident-response.md` → "Period reopened" | `SECURITY_EVENT/period.reopened_unauthorized` |
| Deploy bricked production | `docs/runbooks/incident-response.md` → "Deploy bricked" | `SECURITY_EVENT/deploy.rolled_back` |
| Encryption-key compromise | `docs/policies/business-continuity.md` → "Lost encryption keys" + this policy's privacy-incident overlay | `SECURITY_EVENT/encryption.key_compromised` |
| Vendor breach (Neon, Vercel, Clerk, Plaid, Anthropic, Stripe, …) | `docs/policies/business-continuity.md` → scenario per vendor + this policy's PII overlay | `SECURITY_EVENT/vendor.breached` |
| PII exfiltration (any path) | This policy's privacy-incident overlay (GDPR Art. 33/34) | `SECURITY_EVENT/pii.exfiltrated` |

## Privacy-incident overlay (GDPR Art. 33 + Art. 34)

When an incident involves customer PII (any field classified
CONFIDENTIAL or RESTRICTED in `data-classification.md`):

| Trigger | Action | SLA |
|---|---|---|
| PII may have been accessed by an unauthorized party | Privacy lead notifies supervisory authority (GDPR Art. 33) | Within 72 hours of becoming aware |
| Risk to data subjects is "high" (e.g., financial data exposed without encryption) | Privacy lead notifies affected data subjects directly (GDPR Art. 34) | Without undue delay; same 72-hour reference window |
| Encryption-at-rest defense held (data was encrypted; keys were not compromised) | Notification to subjects may be unnecessary per Art. 34(3)(a); document the decision in the postmortem | Document the basis for the no-notification decision in the postmortem |

The privacy lead is the founder until a separate role is hired
(per `security.md` Roles + Responsibilities).

## Annual tabletop exercise

Annually (calendar reminder on the second Monday of January):

1. **Pick a scenario** from the specific-incident-class runbooks
   above OR from a real industry incident in the past 12 months.
2. **Walk through the procedure** end-to-end as if it were real —
   detect, acknowledge, contain, investigate, communicate, remediate,
   postmortem.
3. **Document the exercise** in `docs/incidents/tabletop-{YYYY}.md`
   with the scenario, the gaps surfaced, and the action items.
4. **Audit-log row** `CONFIG_CHANGE/incident_response.tabletop_completed`.

Annual tabletop exercises are how the response procedure stays
current; they also generate evidence the auditor can verify.

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "Show me your incident response policy" | This file |
| "Show me your incident response runbook" | `docs/runbooks/incident-response.md` (operational steps; pairs with this policy) |
| "Show me a real incident you handled" | `docs/incidents/YYYY-MM-DD-<slug>.md` per incident (empty today — steady state) |
| "Show me your tabletop exercise history" | `docs/incidents/tabletop-{YYYY}.md` (annual cadence) |
| "How do you decide severity?" | This file → "What counts as an incident" matrix |
| "Show me your privacy-breach notification procedure" | This file → "Privacy-incident overlay" (GDPR Art. 33/34) |
| "Show me the postmortem requirements" | This file → "Postmortem requirements" (blameless; 5-business-day SLA; 8 required sections) |
| "Show me an audit-log row of a real incident" | `audit_log` rows with `eventType=SECURITY_EVENT` — empty today |

## Annual review

Reviewed annually (second Monday of January — same week as the
tabletop). Trigger an out-of-cycle review when:

- A real SEV-1 or SEV-2 incident occurs (every postmortem prompts a
  review)
- A new specific-incident-class runbook is added
- The detection-source landscape changes (e.g., Sentry DSN
  provisioned; cron-monitored health checks wired)
- A privacy regulation update (e.g., a new US state law passes with
  different notification SLA)
- A new contributor joins (role-split trigger)

The review itself goes in the audit log as
`CONFIG_CHANGE/incident_response.review` by the founder.
