# Vendor management

**Version:** 1.1
**Effective date:** 2026-05-29
**Owner:** Hosung Son (founder)
**Last reviewed:** 2026-05-29

## Purpose

SOC 2 CC9 requires us to track every upstream vendor with access to our customer data or production systems, hold them to a documented security standard, and maintain evidence of that standard.

## Vendor inventory

| Vendor | Purpose | Data shared | SOC 2 type | Trust page | Last verified | DPA on file |
|---|---|---|---|---|---|---|
| **Neon** | Postgres database | All app data (highest blast radius) | Type 2 | https://neon.tech/docs/security | 2026-05-29 | clickwrap @ signup; standard DPA |
| **Vercel** | Hosting + CDN for all 5 apps + marketing site | App requests, function logs, env vars (including INTERNAL_API_TOKEN) | Type 2 | https://vercel.com/security | 2026-05-29 | clickwrap @ signup; Pro tier DPA |
| **Anthropic** | LLM (Claude) for ai-suggest, ai-extract, capex classifier, impairment screener | AI prompts (CONFIDENTIAL — see data-classification.md). Per-tenant monthly cap + spend alerts in place. | Type 2 | https://www.anthropic.com/trust | 2026-05-29 | clickwrap @ signup |
| **Plaid** | Bank-feed ingestion for integrations repo | Bank statement lines (CONFIDENTIAL); access tokens stored in `Connection.credentialsJson` | Type 2 | https://plaid.com/safety/ | 2026-05-29 | clickwrap @ signup |
| **Clerk** | Authentication (live in production) | Email, display name, session data | Type 2 | https://clerk.com/legal/soc2 | 2026-05-29 | clickwrap @ signup |
| **Stripe** | Billing + payment + usage-based AI metering (e0458d2) | Customer + subscription state; billing email | Type 2 | https://stripe.com/legal/ssa | 2026-05-29 | clickwrap @ signup; PCI handled by Stripe |
| **Resend** | Transactional email (invites, JE-approved, JE-rejected, owner-transfer) | Recipient email + transactional content | Type 2 | https://resend.com/security | 2026-05-29 | clickwrap @ signup |
| **Sentry** | Error monitoring (shim wired, awaiting DSN provision) | Stack traces — `redactPii()` runs before transmission | Type 2 | https://sentry.io/trust/ | 2026-05-29 | clickwrap @ signup once DSN set |
| **GitHub** | Source control + CI (CodeQL, gitleaks, npm audit, Dependabot) | Source code, CI logs, secrets in GH Actions vault | Type 2 | https://github.com/security | 2026-05-29 | standard ToS |
| **npm** (registry) | Build-time dependency resolution | Build-time only (no runtime data) | (registry — see Microsoft/GitHub) | https://docs.npmjs.com/policies | N/A | N/A |

## What "verified" means

Annually, we:
1. Download the latest SOC 2 Type 2 report from each vendor's trust portal
2. Read the report cover-to-cover — specifically the auditor's opinion + the management response on any qualifications
3. Verify the report covers the time window we relied on the service
4. File the report in `docs/policies/vendor-receipts/{vendor}/{YYYY}.pdf` (gitignored — these are confidential)
5. Sign off in the "Last verified" column above

"Last verified" = 2026-05-29 currently means "trust portal exists and we confirmed the vendor publishes a current Type 2 report" — not "we've downloaded and read the report." The next quarterly review converts the dates as we read each report.

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

**Vendors that need DPAs:** Neon, Vercel, Anthropic, Plaid, Clerk, Stripe, Resend, Sentry (when DSN set), GitHub.

**Status:** All listed vendors offer a clickwrap DPA accepted at signup or via the vendor's legal portal. Standard scope is sufficient for v1; revisit if a customer in scope requires bespoke DPA negotiation (typical enterprise procurement requirement).

## Procurement procedure

Before adopting a new vendor:
1. Categorize: will they touch CONFIDENTIAL or RESTRICTED data? (See `data-classification.md`)
2. Verify SOC 2 Type 2 (or accept the risk + document)
3. Verify DPA available (or accept the risk + document)
4. Add to the inventory above
5. Document the decision in a "vendor selection" entry below

## Vendor selections (history)

| Date | Vendor | Decision | Alternatives considered | Rationale |
|---|---|---|---|---|
| 2026-05-22 | Neon | Adopted | Supabase, RDS, Planetscale | Free tier with branching, Vercel integration, SOC 2 Type 2 |
| 2026-05-22 | Vercel | Adopted | Render, Fly.io | Next.js-first, free hobby tier, SOC 2 Type 2, Edge runtime |
| 2026-05-22 | Anthropic | Adopted | OpenAI | Claude's tool-use + prompt caching, SOC 2 Type 2, preferred reasoning model for contract extraction (revenue-rec) |
| 2026-05-22 | Plaid | Adopted | Teller, Stripe Financial Connections | Largest US bank coverage, free sandbox, SOC 2 Type 2 |
| 2026-05-27 | Clerk | Adopted | NextAuth, WorkOS, Auth0 | Drop-in MFA + org/tenant primitives match our multi-tenant model; SOC 2 Type 2 |
| 2026-05-28 | Stripe | Adopted | Paddle | Standard for SaaS billing; usage-based metering API; SOC 2 + PCI |
| 2026-05-27 | Resend | Adopted | SendGrid, Postmark | API ergonomics, predictable pricing, SOC 2 |
| 2026-05-29 | Sentry | Adopted (shim only — DSN pending) | Datadog, Axiom | Sentry is the standard Next.js error monitor with a free tier; if pricing scales poorly later, swap is one-file via the `src/lib/monitoring` shim |

## Annual review

Reviewed annually. **Next review: 2027-05-29.** Ad-hoc reviews on any vendor change (acquisition, pricing model change, security incident), and after every SOC 2 audit cycle.
