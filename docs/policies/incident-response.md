# Incident response runbook

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}}

## What counts as an incident

| Severity | Examples | Response SLA |
|---|---|---|
| **SEV-1 / Critical** | Production down, customer data leaked, unauthorized JE posted, period-close bypassed | Immediate (within 1 hour of detection) |
| **SEV-2 / High** | Significant feature broken, AI surface returning wrong answers, slow performance | Within 4 business hours |
| **SEV-3 / Medium** | Minor feature broken, cosmetic bug, deprecation warning | Within 1 business day |
| **SEV-4 / Low** | Wishlist, refactor, doc improvement | When time permits |

## Detection

How we find out something's wrong:

1. **Automated alerts** — once Sentry is wired (Phase 3 follow-up), error rates > baseline alert via email
2. **Health checks** — `/api/health` endpoints monitored by Vercel's built-in checks
3. **Customer report** — incoming email to `security@ledger-nexus.com` (when domain provisioned) or GitHub security advisory
4. **Internal noticing** — engineer spots something during normal work

## Roles during an incident

Solo posture: {{NAME}} fills all roles. When more contributors join:

| Role | Responsibility |
|---|---|
| Incident Commander (IC) | Coordinates response, makes decisions, communicates externally |
| Engineer on duty | Investigates, fixes, deploys |
| Comms | Updates status page, customer email, internal stakeholders |
| Scribe | Writes timeline + postmortem |

## Response procedure

### Step 1: Acknowledge

Within the SLA above, the IC acknowledges receipt and starts the timeline. The timeline is a chronological list of "what we know, what we did" with timestamps. Lives in a doc per incident (`docs/incidents/YYYY-MM-DD-<slug>.md`).

### Step 2: Contain

Stop the bleeding. Examples:
- Revert the bad commit / redeploy previous version
- Rotate the leaked credential
- Disable the broken feature via env var
- Block the malicious IP (if applicable)

### Step 3: Investigate

Once contained, understand the root cause. Look at:
- Vercel function logs (7 days retention on free tier — pull immediately)
- `audit_log` table (long-term retention)
- Git history (any recent commits to affected paths?)
- Customer report (what did they see, what were they trying to do?)

### Step 4: Communicate

External (if customers affected):
- Status page update
- Email to affected customers within 24 hours
- Public postmortem within 5 business days for SEV-1/SEV-2

Internal:
- Slack / wherever the team chats
- Update the timeline doc in real-time

### Step 5: Remediate

Permanent fix that prevents recurrence:
- Code change with tests
- Process change documented in this directory
- New monitoring/alert to catch similar issues earlier

### Step 6: Postmortem

Within 5 business days of resolution, write a blameless postmortem:
- What happened
- What was the impact
- Timeline of events
- Root cause (5-whys)
- What worked, what didn't
- Action items to prevent recurrence

Postmortems are public within the company (in `docs/incidents/`) and shared with customers if they were affected.

## Specific runbooks

### Leaked credential

1. Identify which credential leaked (look at GitHub Security tab if gitleaks caught it)
2. Rotate immediately:
   - Vercel token: revoke at vercel.com/account/tokens; generate new; update CI secrets
   - Internal API token: generate new via `openssl rand -hex 32`; rotate per `access-control.md`
   - Database URL: rotate Neon's password (Neon dashboard → Roles); update Vercel env
   - Anthropic API key: revoke at console.anthropic.com; generate new; update Vercel env
3. Audit `audit_log` for the rotation period: any unexpected uses?
4. If yes: assume breach. Escalate.

### Unauthorized JE posted

1. Identify the JE: `entryNumber` from audit_log lookup
2. Reverse it: post a reversal JE through the substrate (proper accounting trail)
3. Investigate: who posted it? Via what credential? When did the credential leak?
4. Rotate the involved credential
5. Period close: if the period is now closed because of this JE, reopen it (admin), reverse, close again

### Period reopened without authorization

This is a SEV-1. Period close is one of the highest-trust operations.
1. Look at `audit_log` filtered by `eventType=PRIVILEGED_ACTION action=reopen-period`
2. Was the actor a real admin? If not: their credential leaked; rotate everything per "Leaked credential"
3. If the actor IS a real admin but didn't intend to reopen: investigate session hijack
4. Re-close the period
5. Notify affected stakeholders (if any reports already shipped based on the closed numbers)

### Deploy bricked production

1. Vercel UI: roll back to the previous deployment (one click)
2. Verify production is healthy via `/api/health`
3. Investigate the bad commit; do NOT re-merge until tested
4. Postmortem within 24 hours focused on "why did this not get caught in CI?"

## Annual review

Reviewed annually on {{REVIEW_DATE}}. Walk through each runbook with a tabletop exercise — even if no real incidents occurred. Document the exercise in `docs/incidents/tabletop-{YYYY}.md`.
