# Vendor management

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}}

## Purpose

SOC 2 CC9 requires us to track every upstream vendor with access to our customer data or production systems, hold them to a documented security standard, and maintain evidence of that standard.

## Vendor inventory

| Vendor | Purpose | Data shared | SOC 2 type | Last SOC 2 reviewed | DPA on file |
|---|---|---|---|---|---|
| **Neon** | Postgres database | All app data (highest blast radius) | Type 2 (https://neon.tech/docs/security) | {{DATE}} | {{Y/N}} |
| **Vercel** | Hosting + CDN | App requests, function logs, env vars | Type 2 (https://vercel.com/security) | {{DATE}} | {{Y/N}} |
| **Anthropic** | LLM (Claude) | AI prompts (CONFIDENTIAL — see data-classification.md) | Type 2 (https://www.anthropic.com/trust) | {{DATE}} | {{Y/N}} |
| **Plaid** | Bank data | Bank statement lines | Type 2 (https://plaid.com/safety/) | {{DATE}} | {{Y/N}} |
| **GitHub** | Source control + CI | Source code, CI logs | Type 2 (https://github.com/security) | {{DATE}} | {{Y/N}} |
| **npm** | Package registry | Build-time only (no runtime data) | (registry — see Microsoft/GitHub) | N/A | N/A |
| **Clerk** (when added) | Authentication | Email, name, session data | Type 2 | {{DATE}} | {{Y/N}} |
| **Sentry** (when added) | Error monitoring | Stack traces, may include PII | Type 2 (https://sentry.io/trust/) | {{DATE}} | {{Y/N}} |

## What "reviewed" means

Annually, we:
1. Download the latest SOC 2 Type 2 report from each vendor (most have a portal)
2. Read the report cover-to-cover — specifically the auditor's opinion + the management response on any qualifications
3. Verify the report covers the time window we relied on the service
4. File the report in `docs/policies/vendor-receipts/{vendor}/{YYYY}.pdf`
5. Sign off in this table

If a vendor doesn't have a SOC 2 Type 2 report, we either:
- Accept the risk (document in `risk-register.md`)
- Migrate to a vendor that has one
- Implement compensating controls (e.g., end-to-end encryption that doesn't trust the vendor)

## Data Processing Agreements

Each CONFIDENTIAL-data-handling vendor needs a DPA on file (GDPR Article 28 / CCPA equivalent). DPAs typically:
- Define what data the vendor processes
- Restrict subprocessing (vendor's own vendors)
- Require breach notification within X hours
- Govern data deletion on contract termination

**Vendors that need DPAs:** Neon, Vercel, Anthropic, Plaid, GitHub, Clerk (when added), Sentry (when added).

**Status:** {{Most vendors have a standard DPA you accept clickwrap-style during signup. Confirm + file each.}}

## Procurement procedure

Before adopting a new vendor:
1. Categorize: will they touch CONFIDENTIAL or RESTRICTED data? (See `data-classification.md`)
2. Verify SOC 2 Type 2 (or accept the risk + document)
3. Verify DPA available (or accept the risk + document)
4. Add to the inventory above
5. Run a 30-day trial; document the decision in a "vendor selection" entry below

## Vendor selections (history)

| Date | Vendor | Decision | Alternatives considered | Rationale |
|---|---|---|---|---|
| {{DATE}} | Neon | Adopted | Supabase, RDS, Planetscale | Free tier with branching, Vercel integration, SOC 2 |
| {{DATE}} | Vercel | Adopted | Render, Fly.io | Next.js-first, free hobby tier, SOC 2 |
| {{DATE}} | Anthropic | Adopted | OpenAI | Claude's tool-use + caching APIs, SOC 2 |
| {{DATE}} | Plaid | Adopted | Teller, Stripe Financial Connections | Largest US bank coverage, free sandbox |

## Annual review

Reviewed annually on {{REVIEW_DATE}}.
