# Incident response runbook

**Audience:** the operator on call (currently the founder, until a second engineer joins).
**Scope:** all 5 ledger-nexus production deployments (ledger-core, recon, fa-amort, revenue-rec, integrations) on Vercel + shared Neon Postgres.
**Read this BEFORE you need it.** During a real incident is a bad time to learn the playbook.

This document satisfies SOC 2 CC7.3 (incident detection + response) + CC7.4 (incident communication) for technical-side incidents. Personnel-facing incidents (HR, vendor breach) follow a separate procedure, see `docs/policies/`.

---

## What counts as an incident

| Severity | Definition | Examples | Response time |
|---|---|---|---|
| **SEV-1** | Service down OR customer financial data at risk of loss/leak | All Vercel deploys 503; Neon DB unreachable; encryption key compromise; suspected unauthorized access to `audit_log` or `user`; ransomware-shaped activity in logs | Acknowledge < 15 min; status update < 30 min |
| **SEV-2** | Major feature degraded OR security control failing-open | `/api/internal/journal-entries` returning 500s; Clerk auth degraded but DB up; `FIELD_ENCRYPTION_KEY` becomes unset mid-deploy; one repo's CI gate bypassed | Acknowledge < 1 h; status update < 2 h |
| **SEV-3** | Single feature broken with workaround OR isolated customer impact | One Server Action throws on a specific tenant; one report's CSV export is broken; Sentry shows error spike < 100 events/h | Next business day |
| **SEV-4** | Cosmetic, low-priority, or fully self-recovered | UI typo; auto-scaled past a transient spike; expected error in a known-flake test | Triage at next planning |

Anything you're not sure about → treat as one level higher than you think and downgrade after triage. False alarms are cheaper than ignored real ones.

---

## When in doubt, the first 4 minutes

1. **Acknowledge** — post in the incident channel (or Slack DM to self if pre-team): "Investigating [signal]. Sev unknown."
2. **Capture** — screenshot the alerting dashboard / error / log line. Future-you needs the original signal during the postmortem.
3. **Decide blast radius** — is it 1 tenant or all tenants? 1 repo or all? Customer data at risk Y/N?
4. **Set the timer** — note the start time. The next status update window is anchored from here.

If steps 1–4 take longer than 4 minutes, something else is wrong (you're confused, the signal is ambiguous, multiple things are firing). Stop, page yourself a coffee, and start over with a clearer head.

---

## SEV-1 playbook

You have ~15 minutes to acknowledge. Order of operations:

### 1. Stop the bleeding (minutes 0–15)

- **Service-down (5xx everywhere):** revert the Vercel deployment to the last known-good. Vercel dashboard → Deployments → click the most recent green deploy → "Promote to production." This is the single most reliable mitigation for code-shaped incidents.
- **DB unreachable:** check Neon status (status.neon.tech). If a planned Neon maintenance is in progress, post status and wait. If unplanned, switch the app to the read-replica via Vercel env vars (instructions in `docs/deployment.md` → "Failover" section). Posting will fail until primary returns — this is acceptable for short outages.
- **Encryption key exposure:** rotate immediately, per the rotation procedure in `docs/runbooks/encryption-rollout.md`. Do NOT publish the rotation window in any external channel until rotation completes.
- **Suspected unauthorized access:**
  1. Revoke the active session (Clerk dashboard → Users → revoke).
  2. Force-rotate all admin tokens (`ADMIN_TOKEN`, `INTERNAL_API_TOKEN`, etc.) in Vercel env. App auto-redeploys on env change.
  3. Capture the audit_log range covering the suspected window with: `SELECT * FROM audit_log WHERE "occurredAt" BETWEEN ... ORDER BY "occurredAt" DESC` and save the result as evidence.
  4. THEN start investigation.

### 2. Communicate (parallel with step 1, in the same 15-minute window)

- **Internal:** post to the incident channel (or self-DM). State the time, the signal, the suspected blast radius, the action being taken.
- **External (customers):** post a status update on the status page (status.cpaura.com when it exists, or pinned tweet, or email to the announce list — whichever channel customers actually subscribe to). Format:
  ```
  [HH:MM TZ] We are investigating reports of [user-facing symptom].
              Estimated affected customers: [scope]. Next update by HH:MM.
  ```
- **Vendor:** if the root cause is suspected to be a vendor (Neon, Vercel, Clerk, Anthropic, Stripe, Plaid), open a ticket NOW. Vendor SLA timers start from when you contact them, not when the problem started.

### 3. Investigate (minute 15+)

Once you've stopped the bleeding and posted status, switch to investigation mode:

- **Pull error traces** from Sentry (when configured) or Vercel function logs (`vercel logs <deployment-id>`).
- **Diff** the most recent merge against the last known-good. `git log origin/main --since="2 hours ago"`.
- **Check `audit_log`** for unusual privileged actions in the last hour. Specifically: any non-OWNER mutations to tenant memberships, any DATA_EXPORT events, any `eventType = TOKEN_REJECTED` clusters.
- **Check `/api/health` on every project** for the encryption + DB + monitoring blocks. Anything degrading hints at root cause.
- **Capture a Neon backup branch** (`neon branches create --parent main incident-<date>`) before doing any DB-side investigation that mutates state. Insurance.

### 4. Resolve

When the immediate impact is mitigated:

- Post the resolution status update.
- Open the postmortem doc within 24 hours (template below).
- Add any new alerts you wish you'd had to the monitoring backlog.

---

## SEV-2 playbook

Same shape as SEV-1, but:
- The 4-minute first-response is still mandatory; the 15-minute mitigation window relaxes to 1 hour.
- "Stop the bleeding" usually means a config change (env var, feature flag, RBAC role flip) rather than a full revert.
- Customer communication is at your discretion — for security control failures (encryption off, audit log RULE dropped, etc.), DO post even if the failure isn't customer-visible.

---

## SEV-3 / SEV-4

- Open a GitHub issue with the `incident` label.
- No real-time communication required.
- Triage at the next planning session.
- If a SEV-3 / SEV-4 repeats 3+ times across a 30-day window, promote to SEV-2 and investigate the pattern.

---

## Common scenarios

### "I just deployed and now everything is broken"

The standard answer 95% of the time: **revert the deployment**. Don't debug a broken prod. Get the green deploy back, then debug from a branch.

```bash
# Find the last green deploy
gh run list --workflow=ci.yml --status=success --limit=5
# Promote that commit
vercel promote <deployment-url>  # or use the dashboard
```

After the revert: confirm `/api/health` returns ok on all 4 DB-having projects. Then start the postmortem.

### "Encryption is broken / `looksEncrypted` false-positive returns"

The bug shape: rows are being written as plaintext OR rows can't be read because `[encryption error — contact support]` shows in the UI.

- **Stop new writes from corrupting:** revert the deployment. Encrypted-data integrity is more important than uptime here.
- **Diagnose:**
  - Check `/api/health` → `encryption.configured` on every project. If `false` anywhere, `FIELD_ENCRYPTION_KEY` is missing/malformed in Vercel.
  - Spot-check production via `SELECT id, left(memo, 40) FROM gl_entry_header WHERE memo IS NOT NULL ORDER BY "createdAt" DESC LIMIT 10` — ciphertext should look like base64 starting with `AQ`. Plaintext means writes are not encrypting.
  - If `looksEncrypted` is the culprit (cf. commit `e992eec` history), check that the strict-base64 + roundtrip checks are present in `src/lib/soc2/field-encryption.ts`. The regression test should have caught this — if it didn't, something changed in the helper.
- **Recover:** rows written during the broken window may need a re-encryption sweep. Use `scripts/encrypt-*.ts` per column; they skip already-encrypted rows.

### "Neon DB unreachable / timing out"

- Check status.neon.tech. If they're aware, monitor. If not, open a ticket.
- Confirm your IP/region — sometimes regional outages.
- Check the connection-pool exhaustion case: `SELECT count(*) FROM pg_stat_activity WHERE datname = 'neondb'` (if you can reach it). If pinned around the max, restart all Vercel functions to dump connections.
- Failover to read-replica if primary won't return (see `docs/deployment.md`). Writes will fail; reads will serve. This is correct behavior.

### "Suspected unauthorized access"

The 3-minute version:
1. **Block the actor** — revoke all sessions for the suspect user (Clerk dashboard) and the suspect tenant (Vercel env `TENANT_SUSPENDED` list, see middleware).
2. **Preserve evidence** — `SELECT * FROM audit_log WHERE "actorUserId" = '...' OR "ipAddress" = '...' ORDER BY "occurredAt"` and save the result. The append-only RULE means nothing was deleted; capture the snapshot so you have a frozen artifact.
3. **Rotate** — `ADMIN_TOKEN`, `INTERNAL_API_TOKEN`, `RECON_INTERNAL_API_TOKEN`, `FIELD_ENCRYPTION_KEY`, `FIELD_DETERMINISTIC_KEY`, all webhook signing secrets. Use the rotation procedure for each (the encryption keys are in `encryption-rollout.md`; the API tokens are simpler — set new value in Vercel, app picks it up on redeploy, distribute new value to authorized consumers).
4. **Investigate** — once the door is shut. Reconstruction goes in the postmortem.

### "Plaid webhook flooding"

Symptoms: integrations Vercel project showing 500s; recon's bank-line endpoint pegged.

- The webhook has ES256 JWT signature verification — if attacker is forging, requests get rejected at signature-check (`AUTH_FAILED` audit events). Check that path.
- If genuine flood (Plaid resending), Plaid's docs cover retry semantics. Open ticket with Plaid.
- Local mitigation: increase the rate-limit backoff in `src/lib/connectors/plaid/rate-limiter.ts` and redeploy. Mid-incident, this is an env-var: `PLAID_WEBHOOK_RATE_LIMIT_BURST=10` (reduce from default).

---

## Vendor escalation contacts

| Vendor | Status page | Support | Notes |
|---|---|---|---|
| Vercel | vercel-status.com | dashboard → Support | Plan determines SLA. Pro = 24h response. |
| Neon | status.neon.tech | console.neon.tech → Help | Compute outages auto-failover to replica. Storage outages are bigger. |
| Clerk | status.clerk.com | dashboard → Support | Auth degraded mode still serves existing sessions for ~24h. |
| Anthropic | status.anthropic.com | support@anthropic.com | API outages → AI features degrade; deterministic core still works. |
| Stripe | status.stripe.com | dashboard → Help | Webhook backlog handled with their event-id idempotency. |
| Plaid | dashboard.plaid.com/status | dashboard → Support | Webhook resends arrive within 24h. |

When opening a vendor ticket during an incident, include:
- Your incident ID (e.g. `INC-2026-05-31-001`)
- The exact time range of impact
- The error message or status code
- Your account ID + plan tier

---

## On-call (solo-dev compensating control)

Until a second engineer joins, "on-call" is the founder. Compensating controls satisfy SOC 2 CC7:

- **Monitoring fires to multiple channels.** Sentry → email; Vercel deployment failures → email; Neon alerts → email. Three independent paths reduce the risk that a single notification gets lost.
- **Auto-escalation via timer.** If a SEV-1 alert isn't acknowledged in 15 minutes, an automated process (Vercel cron in the alerting repo) sends a follow-up email AND SMS via Twilio. Yes, this only escalates back to the founder — but the redundant signal catches "I missed the email" cases.
- **Dead-man switch.** A daily cron pings `/api/health` on every project and emails if any return non-200. Acts as a passive monitor: if the founder is out for a week, this catches what real-time alerts might miss.
- **Vacation handoff.** When the founder is unreachable for > 24h (PTO, etc.), services degrade gracefully: read paths continue, write paths gate to MAINTENANCE banner. Procedure in `docs/policies/business-continuity.md` (when written).

When a second engineer joins, this section becomes a real rotation policy.

---

## Postmortem template

Every SEV-1 and SEV-2 gets a postmortem within 24 hours of resolution. Even if root cause is "operator error, fixed by revert" — especially then; that's the most common shape.

File location: `docs/postmortems/INC-YYYY-MM-DD-NNN.md`.

```markdown
# INC-YYYY-MM-DD-NNN — [One-line description]

**Severity:** SEV-N
**Date:** YYYY-MM-DD
**Duration:** HH:MM:SS (start → resolution)
**Author:** [name]
**Reviewers:** [names of anyone else who read this]

## Summary

Two-sentence description. What broke + what the customer impact was.

## Timeline

All times in [TZ]. Use absolute timestamps so the diff between events is unambiguous.

- HH:MM — [event]
- HH:MM — [event]
- HH:MM — [event]
- HH:MM — Resolved

## Root cause

Be honest. Five-whys to actual cause, not the proximate symptom.

## What went well

- Specific examples. "The encryption health-check caught it before backfill started" is useful; "monitoring worked" is not.

## What went poorly

- Where did we lose time? What information was missing? What tool did we wish we had?

## Action items

| # | Action | Owner | Target |
|---|---|---|---|
| 1 | [specific, completable action] | [name] | [date] |
| 2 | ... | ... | ... |

Action items become GitHub issues with the `postmortem-action` label. Track to completion or explicit decline (with reason).

## Evidence

Attach or link:
- The original alert signal
- Status update timestamps
- Relevant log excerpts (redact PII via `redactPii()` before pasting)
- Audit log range, if security-relevant
- The git diff of the fix (if applicable)
```

## Blameless framing

Postmortems are **blameless** — the goal is to fix the system, not to assign fault. The standard test: read your draft and replace every "I should have known" / "X forgot to" / "Y didn't think to" with "the system allowed [outcome] because [cause]." If the sentence stops making sense, you're focused on the person, not the system. Rewrite.

---

## Drills

Run a quarterly drill of one scenario from "Common scenarios" above. Use a Neon backup branch as the playground; do not drill against production. The drill log is its own SOC 2 evidence artifact:

- Date of drill
- Scenario chosen
- Time to acknowledge / mitigate / resolve
- Gaps surfaced (added to the action-items backlog)

If you skip a quarter, document why in the drill log. Two consecutive skipped quarters → SEV-3 action item.

---

## See also

- `docs/policies/change-management.md` — pre-incident: how changes are gated
- `docs/runbooks/encryption-rollout.md` — encryption-specific operational procedures
- `docs/policies/risk-register.md` — risks that, if realized, become incidents (preemptive context)
- `src/lib/audit/log.ts` — the audit-log producer; understanding what's logged helps with evidence capture
