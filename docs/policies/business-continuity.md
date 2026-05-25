# Business continuity & disaster recovery

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}}

## Purpose

When something breaks — vendor outage, accidental DB wipe, regional cloud failure, lost laptop — we need a documented path back to a working production. This policy answers: how long can we be down, how much data can we lose, and what we do to get back.

SOC 2 references: CC7 (system operations & monitoring), Availability criterion (when in scope).

## Scope

Applies to:
- The ledger-nexus portfolio production environment (ledger-core + recon + revenue-rec + integrations + fa-amort)
- The Neon Postgres database that all 5 repos share
- The Vercel deployments serving each app
- The Anthropic API integration (AI surfaces)
- Local development environments are NOT in scope — those are recoverable from git

## RTO and RPO

| Tier | Definition | Target |
|---|---|---|
| **RTO** (Recovery Time Objective) | How long until production is back up | 4 hours for full outage, 1 hour for single-app outage |
| **RPO** (Recovery Point Objective) | How much data we accept losing | 24 hours (current — Neon free tier); 1 hour (target — Neon Launch with PITR) |

Reality check on RTO: We are a solo / small team without 24x7 oncall. RTO during business hours is realistic. RTO at 3 AM on a Sunday is "best effort, hours" — not minutes. Customers should be told this upfront in the MSA.

## Backup strategy

### Current state (Phase 0)

- **Database**: Neon free tier — no point-in-time recovery, no scheduled backups beyond Neon's own internal redundancy. If the DB is corrupted or wiped, we lose everything since the last manual snapshot.
- **Code**: GitHub remotes for all 5 repos. Multiple developer clones if more than 1 person on the team. Loss risk: low.
- **Vercel config**: Reproducible via `vercel.json` + env vars stored in Vercel dashboard. Loss risk: low for code, medium for env vars (no automated export).
- **Audit logs**: In the same Postgres DB. If the DB is lost, audit history is lost too. Major gap.

### Target state (Phase 1 — next 30 days)

1. **Upgrade Neon to Launch tier** ($19/month) — enables 7-day PITR. RPO drops to ~minutes.
2. **Quarterly snapshot export** — `pg_dump` to an encrypted bucket (S3 or R2) outside Vercel/Neon. Manual but documented.
3. **Audit log replication** — if AuditLog is critical, mirror it to an append-only log outside the DB (S3, GCS, or a dedicated audit DB).

### Target state (Phase 2 — by month 6)

1. **Weekly automated backup** — cron job (Vercel cron or GitHub Action) runs `pg_dump`, uploads to encrypted bucket, retains 12 weeks.
2. **Backup restore drill** — quarterly. Pull a backup, restore to a Neon branch, run smoke tests, document.
3. **Multi-region read replica** — Neon supports read replicas in additional regions. Adds vendor-region failover capability.

## Restore procedures

### Scenario: Neon DB corruption / accidental data deletion

1. Identify the corruption window from audit_log (when did the bad write happen?)
2. **If within Neon PITR window**: Neon dashboard → branch from timestamp → swap connection string in Vercel. RTO ~30 minutes.
3. **If outside PITR window**: load the most recent quarterly `pg_dump` snapshot into a new Neon branch. Determine which writes happened between snapshot and now — replay from `audit_log` if possible.
4. Notify customers if any data loss occurred. Be honest about the window.

### Scenario: Vercel outage (single region or global)

1. Vercel is single-vendor — if Vercel is down, all 5 apps are down.
2. Status check: status.vercel.com
3. If outage is regional, Vercel auto-fails over (we're on hobby/pro tier with default region settings).
4. If outage is global: wait it out. We don't have a hot standby on another platform. Communicate to customers via the status page (which itself must NOT be hosted on Vercel — use Statuspage or a static GitHub Pages site).
5. Postmortem: document the outage duration and Vercel's SLA credit calculation.

### Scenario: Anthropic API outage

1. AI surfaces are non-blocking — all journal entries still post through the substrate without AI assist.
2. UI degrades gracefully: AI-suggestion panels show "AI temporarily unavailable, please use manual flow."
3. No restore action — just wait. RTO = Anthropic's RTO.

### Scenario: Laptop lost or compromised

1. From any other device with GitHub access: revoke the lost device's SSH keys + Vercel CLI tokens (per access-control.md offboarding).
2. Rotate any secrets the lost device had access to.
3. Re-clone repos to a new device. Local development environment is reproducible from `bin/setup.sh` and `.env.example`.

### Scenario: Founder unavailable

This is the highest-impact single-person-dependency in a solo company. Document:
1. Where the secrets live (1Password vault name, not the password)
2. Who has emergency read access to that vault (named delegate)
3. GitHub admin access fallback (2FA recovery codes printed and stored physically)
4. Vercel account recovery email (alternate email under family member's name, not the founder's)
5. Neon account recovery email (same)

This is morbid but necessary for any business that wants to be acquirable or sold to customers who depend on it.

## DR test cadence

| Frequency | Test |
|---|---|
| Quarterly | Restore most recent backup to a Neon branch, boot the app against it, run the smoke test suite |
| Quarterly | Tabletop exercise — walk through one of the scenarios above with the team |
| Annual | End-to-end DR drill — fully simulate the loss of production and time the recovery |

Document every drill in `docs/dr-drills/YYYY-QN-<scenario>.md` with: scenario, duration, what worked, what didn't, action items.

## Communication during an outage

| Audience | Channel | Cadence |
|---|---|---|
| Customers | Status page + email to subscribers | Within 30 minutes of detection; updates every hour until resolved |
| Internal team | Slack / wherever team chats | Real-time |
| Auditors | Email to SOC 2 auditor's POC | Within 24 hours of resolution; include timeline and impact |

## Vendor dependency map

This is the blast radius if a single vendor goes down. See vendor-management.md for full details.

| Vendor | What we use it for | What happens if it goes down |
|---|---|---|
| Neon | Postgres DB for all 5 apps | All apps return 5xx. Cold start once Neon recovers. |
| Vercel | Hosting all 5 apps | All apps unreachable. Static status page on alternate platform. |
| Anthropic | AI suggestions | AI panels show degraded; JE flow unaffected. |
| GitHub | Source of truth for code | No deploys possible until restored; running app keeps serving. |
| Plaid (future) | Bank-statement ingest | Recon's auto-ingest paused; manual upload still works. |

## Annual review

Reviewed annually on {{REVIEW_DATE}}. Re-evaluate RTO/RPO against actual production usage. Add new vendor dependencies as they're introduced. Re-run the DR drills documented above.
