# Business continuity & disaster recovery

**Version:** 2.0 · **Effective date:** 2026-06-03 · **Owner:** Founder (sole maintainer)
**Last reviewed:** 2026-06-03
**Prior version:** 1.0 (pre-multi-tenant, pre-encryption, pre-audit-log)

This is the SOC 2 CC7 (System Operations) + Availability TSC anchor
document. Every claim below cites the underlying mechanism or, if
not yet implemented, marks the gap honestly with a trigger condition.

The risk register (`docs/policies/risk-register.md`) carries the
operational status of each scenario; this doc explains **what to do
when it happens**.

## Purpose

When something breaks — vendor outage, accidental DB wipe, regional
cloud failure, lost laptop, founder unavailable — there's a documented
path back to a working production. This policy answers: how long can
we be down, how much data can we lose, what we do to get back.

## Scope

Applies to:

- The ledger-nexus portfolio production environment (ledger-core +
  recon + fa-amort + revenue-rec + integrations)
- The Neon Postgres database that all 5 repos share
- The Vercel deployments serving each app
- The Anthropic API integration (AI surfaces)
- The 4 standing service tokens (see `access-control.md` "Service
  tokens" table)

Local development environments are NOT in scope — those are
recoverable from git.

## RTO and RPO

| Tier | Definition | Pre-paying-customer | Post-paying-customer (target) |
|---|---|---|---|
| **RTO** | Time until production is back up | 4 hours full / 1 hour single-app | 1 hour full / 30 min single-app |
| **RPO** | Acceptable data loss window | 24 hours (Neon free tier — no PITR) | 1 hour (Neon Launch with 7-day PITR) |

**Reality check on RTO:** solo team without 24×7 oncall. RTO during
business hours is realistic. RTO at 3 AM on a Sunday is "best effort,
hours" — not minutes. Customers must be told this in the MSA.

**Trigger to move from pre- to post-paying-customer column:** first
signed customer agreement. The Neon Launch upgrade ($19/mo) is the
mechanical change; this doc gets a same-day revision.

## Backup strategy

### Today (2026-06-03)

| Asset | Backup mechanism | RPO | Restore path |
|---|---|---|---|
| Postgres data | Neon's internal redundancy (free tier — NO PITR) | 24h theoretical / "we hope" practical | Neon support ticket — no self-serve |
| Code | GitHub remotes (5 repos) + founder's local clones | ~minutes (commit cadence) | `git clone` |
| `audit_log` table | Same Postgres DB — append-only Postgres RULE prevents tampering BUT does not prevent loss if the DB itself is wiped | Same as Postgres data | Same as Postgres data — **THIS IS THE GAP** |
| Vercel deployments | Reproducible from git + `vercel.json` | N/A (rebuild from source) | Push to main → Vercel deploys |
| Vercel env vars | NO automated export — only Vercel dashboard view | "permanent loss possible" | Manual re-entry from 1Password |
| Encryption keys (`FIELD_ENCRYPTION_KEY`, `FIELD_DETERMINISTIC_KEY`) | 1Password vault + Vercel env | "permanent loss = all encrypted columns unreadable" | Restore from 1Password — see "Lost keys" scenario below |

**The biggest gap:** if the Neon DB is wiped, the audit_log is wiped
with it. The append-only RULE protects against tampering, not loss.
Closing this gap is risk-register #19 (the single Open row).

### Trigger-driven upgrades

| Trigger | Upgrade |
|---|---|
| First paying customer signs | Neon Launch ($19/mo) — enables 7-day PITR; RPO drops to ~minutes |
| First paying customer signs | Weekly `pg_dump` cron to encrypted R2 bucket; 12-week retention |
| 5+ paying customers | Quarterly backup restore drill — pull backup, restore to Neon branch, smoke test, document in `docs/dr-drills/YYYY-QN-restore.md` |
| 10+ paying customers OR EU customer | Multi-region read replica + audit-log replication to a second region |

None of these are aspirational — each maps to a customer-event trigger.
The earliest one is days from now if a customer signs.

## Restore procedures (per scenario)

### Scenario: Neon DB corruption or accidental data deletion

1. **Identify the corruption window** from `audit_log`:
   ```sql
   SELECT * FROM audit_log
   WHERE outcome IN ('FAILURE', 'ANOMALOUS')
     AND created_at > '<suspected-window-start>'
   ORDER BY created_at;
   ```
2. **If within PITR window** (post-Launch-upgrade): Neon dashboard →
   create a branch from the pre-corruption timestamp → swap the
   `DATABASE_URL` in Vercel for all 5 repos → redeploy. RTO ~30 min.
3. **If outside PITR window** (pre-Launch-upgrade — today's reality):
   - Load the most recent `pg_dump` snapshot (none today — gap).
   - Replay writes from `audit_log` between snapshot timestamp and
     corruption.
   - Notify customers of any data loss; be honest about the window.
4. Audit row `CONFIG_CHANGE/database.restored` with the affected
   timestamp range.

### Scenario: Vercel outage (single region or global)

1. **Status check:** status.vercel.com.
2. **Single-region:** Vercel auto-fails over; nothing for us to do.
3. **Global:** wait it out. We don't have a hot standby on another
   platform.
4. **Communicate** to customers via the status page — which is
   **NOT hosted on Vercel** (use a static GitHub Pages site or
   Statuspage). Cron audit-log signal: no `CONFIG_CHANGE/retention.purge`
   row in the past 24h indicates the cron stopped — useful as a
   secondary outage signal.
5. **Postmortem** documents the outage duration + Vercel's SLA credit
   calculation in `docs/dr-drills/YYYY-MM-DD-vercel-outage.md`.

### Scenario: Anthropic API outage

1. **AI surfaces are non-blocking** — all journal entries still post
   through `postJournalEntry` without AI assist.
2. UI degrades gracefully: AI-suggestion panels show "AI temporarily
   unavailable, please use manual flow."
3. No restore action — wait for Anthropic to recover. RTO = Anthropic's
   RTO.
4. Customers should be told upfront that AI is best-effort assist,
   not a hard dependency (covered in TOS §10 no-warranty per
   `revrecengine` legal framing).

### Scenario: Neon ACCOUNT compromised (auth, not data)

1. **Immediately rotate Neon password + revoke all API tokens** from
   neon.tech.
2. **Audit recent Neon activity log** — any unauthorized branches,
   queries, role changes.
3. **Rotate `DATABASE_URL`** in Vercel for all 5 repos.
4. **Postmortem** + audit-log row `SECURITY_EVENT/vendor.compromised`.

### Scenario: Vercel ACCOUNT compromised

1. **Immediately rotate Vercel password + revoke all API tokens + CLI
   tokens** from vercel.com.
2. **Review recent Vercel activity log** — deploy events, env var
   changes, team-member additions.
3. **Rotate every env var in Vercel** — all 4 service tokens + Clerk
   API keys + Anthropic key + Resend key.
4. **Force a deploy** to ensure the running app has the new env vars.
5. **Postmortem** + audit-log row `SECURITY_EVENT/vendor.compromised`.

### Scenario: Laptop lost or compromised

1. **From any other device with GitHub access**: revoke the lost
   device's SSH keys + Vercel CLI tokens.
2. **Rotate** any secrets the lost device had access to per the
   `access-control.md` rotation procedure:
   - All 4 service tokens
   - Clerk admin password (if cached)
   - 1Password vault if browser-cached
3. **Re-clone** repos to a new device. Local dev env reproducible from
   `bin/setup.sh` + `.env.example`.
4. **Audit-log row** `SECURITY_EVENT/device.lost`.

### Scenario: Lost encryption keys (`FIELD_ENCRYPTION_KEY` or `FIELD_DETERMINISTIC_KEY`)

This is the **worst non-data-loss scenario** — encrypted columns
become unreadable. There is no recovery path from cryptographic loss;
defense is the 1Password backup.

1. **Restore from 1Password vault** — the canonical copy of both keys
   lives there. Vercel env is the operational copy.
2. **If 1Password is also lost:** every encrypted column is permanently
   unreadable. Affected columns become blank/erased for all users; the
   `tenantId` + relational schema survives; rebuild from upstream
   sources (Plaid for bank statements, ERP imports for ledger).
3. **Audit-log row** `SECURITY_EVENT/encryption.key_loss` with affected
   key version.

### Scenario: Founder unavailable (medical, legal, or worse)

This is the **highest-impact single-person-dependency** in a solo
company. The following must be true at all times — verify quarterly:

| Item | Where | Delegate |
|---|---|---|
| 1Password emergency kit (vault recovery) | Physical safe + photographed copy in a sealed envelope with a named delegate | Spouse (per founder's last update) |
| GitHub 2FA recovery codes | Printed; sealed envelope; in the same safe | Same |
| Vercel account recovery email | Alternate email (NOT founder's main account) | Same |
| Neon account recovery email | Alternate email (NOT founder's main account) | Same |
| Clerk account recovery email | Alternate email | Same |
| Domain registrar account (revrecengine.com, etc.) | Alternate email + recovery phone | Same |
| Encryption keys (`FIELD_ENCRYPTION_KEY`, `FIELD_DETERMINISTIC_KEY`) | 1Password emergency kit | Same |
| Customer contracts + invoicing | Cloud-stored; access in 1Password emergency kit | Same |

**Trigger:** if 7 consecutive days pass without founder activity
(commits, PRs, deploys, email response), the named delegate initiates
the customer-notification protocol from this section.

This is morbid but necessary for any business that wants to be
acquirable or sold to customers who depend on it.

## DR test cadence

| Frequency | Test | Today | Target post-paying-customer |
|---|---|---|---|
| Quarterly | Restore most-recent backup to Neon branch, boot app, run smoke suite | Not run (gap — risk-register #19) | Required |
| Quarterly | Tabletop exercise — walk through one of the scenarios above with a named delegate | Not run | Required |
| Annual | End-to-end DR drill — simulate full production loss, time the recovery | Not run | Required |

Document every drill in `docs/dr-drills/YYYY-QN-<scenario>.md` with
scenario, duration, what worked, what didn't, action items.

## Communication during an outage

| Audience | Channel | Initial cadence | Follow-up cadence |
|---|---|---|---|
| Customers | Status page (NOT on Vercel) + email | Within 30 min of detection | Hourly until resolved |
| Internal delegate | Personal phone / Slack | Real-time | Real-time |
| SOC 2 auditor (when in audit window) | Email to the auditor's POC | Within 24h of resolution | Final postmortem within 7 days |
| Privacy lead → impacted users (if PII exposed) | Email per `data-subject-requests.md` 30-day SLA | Within 72h per GDPR Art. 34 | Until resolved |

## Vendor dependency map

Single-vendor blast radius. See `docs/policies/vendor-management.md`
for the full inventory and SOC 2 receipts on file.

| Vendor | What we use | What happens if it goes down | Alternate? |
|---|---|---|---|
| **Neon** | Postgres DB (all 5 apps) | All apps return 5xx | None today — would require migrating to Supabase or RDS (multi-day effort) |
| **Vercel** | Hosting (all 5 apps) | All apps unreachable | Status page on alternate (GitHub Pages) |
| **Clerk** | Auth (all 5 apps) | New logins fail; existing sessions continue until expiry | None today |
| **Anthropic** | AI suggestions (asc606, recon, fa-amort, revenue-rec) | AI panels degrade; JE flow unaffected | None — would require switching to OpenAI or Bedrock |
| **GitHub** | Source of truth, CI | No deploys; running app keeps serving | Local clones survive |
| **Plaid** (integrations) | Bank-statement ingest | Recon auto-ingest paused; manual upload still works | Manual fallback covers it |
| **Stripe** (billing) | Subscription billing | Customers can't sign up new; existing subscriptions auto-renew via Stripe's own redundancy | None — billing-critical |
| **1Password** | Secret vault | New rotations can't happen; running app keeps serving | Physical-safe backup of emergency kit |
| **Sentry** (when DSN provisioned) | Error monitoring | Errors fall back to `console.log` via the monitoring shim | Already designed for graceful degradation |

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "What's your RTO and RPO?" | This file → "RTO and RPO" table; per-customer-tier columns |
| "Show me your backup strategy" | This file → "Backup strategy" — including the honest gap (no PITR today) |
| "Show me your DR drill history" | `docs/dr-drills/` directory — empty today, populated post-first-paying-customer |
| "What happens if Vercel/Neon/etc. goes down?" | This file → "Vendor dependency map" |
| "What happens if the founder is unavailable?" | This file → "Founder unavailable" — named delegate, sealed envelopes, 7-day trigger |
| "Show me proof you've tested your restore" | After post-first-paying-customer Q1 drill: `docs/dr-drills/YYYY-QN-restore.md` + audit-log row of completion |
| "How do you communicate during an outage?" | This file → "Communication during an outage" |

## Annual review

Reviewed annually. Trigger an out-of-cycle review when:

- First paying customer signs (RTO/RPO column flip + Neon Launch upgrade)
- A new vendor joins the dependency map (e.g., new connector in integrations)
- An outage occurs and the postmortem identifies a scenario not covered above
- The named delegate (founder unavailable section) changes
- An encryption-key compromise (any kind) — even if recoverable

The review itself goes in the audit log as
`CONFIG_CHANGE/business_continuity.review` by the founder.
