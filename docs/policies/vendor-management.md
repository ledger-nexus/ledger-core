# Vendor management

**Version:** 2.0 · **Effective date:** 2026-06-03 · **Owner:** Founder (sole maintainer)
**Last reviewed:** 2026-06-03
**Prior version:** 1.0 (pre-Clerk, pre-Stripe-billing, pre-Resend)

This is the SOC 2 CC9 (Risk Mitigation) anchor document. CC9 covers
the controls we depend on but **don't own** — every upstream vendor
with access to customer data or production systems. The standard:
track them, hold them to a documented baseline, maintain evidence.

This doc also covers **subprocessor disclosure** under GDPR Art. 28
+ CPRA §1798.115 — our customers need to see which vendors process
their data.

## Vendor inventory

Eleven vendors in scope. Each row maps to a specific data sharing
relationship, a SOC 2 receipt, and a DPA.

| Vendor | Purpose | Data shared | Classification of data shared | SOC 2 Type 2 | DPA on file | Blast radius |
|---|---|---|---|---|---|---|
| **Neon** | Postgres database (all 5 apps) | All app data — ledger, user records, encrypted PII at rest | RESTRICTED + CONFIDENTIAL | ✅ ([neon.tech/security](https://neon.tech/docs/security)) | ✅ (clickthrough at signup) | **HIGHEST** — total data loss if account compromised |
| **Vercel** | Hosting + CDN (all 5 apps) | App requests, function logs, encrypted env vars | RESTRICTED (env) + INTERNAL (logs) | ✅ ([vercel.com/security](https://vercel.com/security)) | ✅ (clickthrough) | All apps unreachable; encryption keys at rest in env |
| **Clerk** | Authentication (all 5 apps) | Email, name, session data, password (hashed by Clerk) | CONFIDENTIAL | ✅ ([clerk.com/legal](https://clerk.com/legal)) | ✅ (clickthrough) | New logins fail; existing sessions continue until expiry |
| **Anthropic** | LLM API (AI suggestions on 4 of 5 repos) | AI prompts + outputs — may include CONFIDENTIAL business data | CONFIDENTIAL | ✅ ([anthropic.com/trust](https://www.anthropic.com/trust)) | ✅ (clickthrough; opt-out of training enabled) | AI panels degrade; JE flow unaffected |
| **Plaid** (integrations) | Bank-statement ingest | OAuth tokens (RESTRICTED), bank transaction data | RESTRICTED + CONFIDENTIAL | ✅ ([plaid.com/safety](https://plaid.com/safety/)) | ✅ (signed during integration) | Auto-ingest paused; manual upload still works |
| **Stripe** | Subscription billing | Customer email, billing address, payment method (Stripe owns card data) | CONFIDENTIAL | ✅ ([stripe.com/legal](https://stripe.com/legal)) | ✅ (clickthrough) | New signups can't pay; existing subs auto-renew via Stripe |
| **Resend** | Transactional email (invites, notifications, DSR exports) | Email subject + body + recipient | CONFIDENTIAL | Type 2 (per Resend trust center) | ✅ (clickthrough) | Email delivery paused; transient failures retry per existing logic |
| **GitHub** | Source control + CI | Source code, CI logs, CODEOWNERS | INTERNAL (code) + RESTRICTED (if secrets accidentally committed — pre-commit hook is the defense) | ✅ ([github.com/security](https://github.com/security)) | ✅ (clickthrough — Microsoft enterprise DPA) | No deploys; running app keeps serving |
| **1Password** | Secret vault — service tokens, recovery codes, encryption keys | RESTRICTED | ✅ ([1password.com/security](https://1password.com/security)) | ✅ (clickthrough) | New rotations blocked; running app keeps serving. Physical-safe emergency kit per BC policy. |
| **Sentry** (DSN provisioning pending) | Error monitoring + redactPii shim | INTERNAL (stack traces; PII filtered via redactPii before transmit) | INTERNAL | ✅ ([sentry.io/trust](https://sentry.io/trust/)) | ⏳ (will sign on activation) | Errors fall back to console.log via monitoring shim |
| **npm** (registry, build-time only) | Package registry | None at runtime; package metadata at build time | N/A | (Microsoft/GitHub registry — see GitHub row) | N/A | Build paused until restored |

## Classification baseline

Every vendor row falls into one of three tiers:

| Tier | Requirement | Vendors |
|---|---|---|
| **Tier 1 — RESTRICTED data handler** | Type 2 + signed DPA + annual review + breach SLA in DPA | Neon, Vercel, Plaid, 1Password, Clerk |
| **Tier 2 — CONFIDENTIAL data handler** | Type 2 + clickthrough DPA + annual review | Anthropic, Stripe, Resend |
| **Tier 3 — INTERNAL data handler** | Type 2 OR self-assessment + annual review | GitHub, Sentry |

A vendor that handles RESTRICTED data **must** have a signed DPA, not
clickthrough. Today every Tier 1 vendor's DPA is clickthrough — this
is the gap to close as we sign customer agreements that require more
than the standard terms.

## What "reviewed" means

Annually (calendar reminder on the first Monday of January):

1. **Download** the latest SOC 2 Type 2 report from each vendor (most
   have a trust portal).
2. **Read** the auditor's opinion + the management response on any
   qualifications. Note any material qualifications in
   `risk-register.md`.
3. **Verify** the report covers the time window we relied on the
   service (most are 12-month rolling).
4. **File** the report at `docs/policies/vendor-receipts/{vendor}/{YYYY}.pdf`
   (gitignored — not public; ask the auditor for the path during
   kickoff).
5. **Sign off** in the table below by stamping a "last reviewed" date.
6. **Audit-log row** `CONFIG_CHANGE/vendor.reviewed` per vendor.

If a vendor doesn't have a SOC 2 Type 2 report:

- **Accept the risk** — document in `risk-register.md` with score
  reflecting the gap.
- **Migrate** to a vendor that has one.
- **Implement compensating controls** — e.g., field-level encryption
  at rest that doesn't trust the vendor (we already do this with
  Neon — even if Neon were compromised, encrypted columns remain
  unreadable without `FIELD_ENCRYPTION_KEY`).

## Data Processing Agreements

Each CONFIDENTIAL- or RESTRICTED-data-handling vendor needs a DPA on
file (GDPR Art. 28; CPRA equivalent). DPAs cover:

- What data the vendor processes
- Restrictions on subprocessing (vendor's own vendors)
- Breach notification SLA
- Data deletion on contract termination
- Data residency commitments

**Clickthrough vs signed:**
- **Clickthrough DPAs** are accepted during signup; the URL of the
  current version is captured in this doc.
- **Signed DPAs** are required when (a) a customer demands negotiated
  terms, (b) the vendor handles RESTRICTED data and we want stronger
  contractual hooks, or (c) we cross a regulatory threshold (EU
  customer → GDPR-specific DPA).

**Status:** Every Tier 1/2 vendor has a clickthrough DPA accepted.
First negotiated-DPA trigger: first customer requiring SCC modifications
or signed DPA terms.

## Subprocessor disclosure

Under GDPR Art. 28(2) + CPRA §1798.115, our customers can ask "who
processes my data on your behalf?" The answer must be specific and
maintained.

**Our subprocessors** (the vendor list above) are published at
`/legal/subprocessors` on the marketing site (or `/security/subprocessors`
in-product when shipped). The page is updated within 24 hours of
adding or removing a Tier 1 or Tier 2 vendor.

**Customer notification:** when a Tier 1 or Tier 2 subprocessor
changes, we notify existing customers within 30 days via email +
audit-log row `CONFIG_CHANGE/subprocessor.changed`. The customer's
30-day objection window is documented in their MSA.

## Procurement procedure

Before adopting a new vendor:

1. **Categorize** the data the vendor will touch. Tier 1 (RESTRICTED)
   gets the highest bar; Tier 3 (INTERNAL) gets the lowest.
2. **Verify SOC 2 Type 2** — pull from the vendor's trust portal.
3. **Verify DPA** is available. For Tier 1, prefer signed; for Tier
   2/3, clickthrough is acceptable.
4. **Run a 30-day trial** in dev/staging. Verify the integration works
   without leaking data per the data-classification doc.
5. **Document the selection** in the "Vendor selections (history)"
   table below — alternatives considered + rationale.
6. **Add to the inventory** above.
7. **Update the subprocessor disclosure** at `/legal/subprocessors`
   (within 24h of production deploy).
8. **Notify existing customers** if Tier 1/2 (30-day window per their
   MSA).
9. **Audit-log row** `CONFIG_CHANGE/vendor.added`.

## Vendor offboarding procedure

When we stop using a vendor:

1. **Verify all data is exported** from the vendor before terminating
   the contract.
2. **Confirm the vendor's data-deletion procedure** — most DPAs
   include a clause; request written confirmation of deletion within
   the DPA's stated window (typically 30 days post-termination).
3. **Rotate any credentials** the vendor had access to.
4. **Remove from the inventory** above; add a row to "Vendor
   selections (history)" with the termination date.
5. **Update the subprocessor disclosure** within 24h.
6. **Notify existing customers** if Tier 1/2 (30-day window).
7. **Audit-log row** `CONFIG_CHANGE/vendor.terminated`.

## Vendor selections (history)

| Date | Vendor | Decision | Alternatives considered | Rationale |
|---|---|---|---|---|
| 2024-Q3 | Neon | Adopted | Supabase, Vercel Postgres, RDS, PlanetScale | Branching for dev/staging (key feature), Vercel-Region edge, SOC 2 Type 2, generous free tier |
| 2024-Q3 | Vercel | Adopted | Render, Fly.io, AWS Amplify | Next.js-first DX, free hobby tier, SOC 2 Type 2 |
| 2024-Q4 | Anthropic | Adopted | OpenAI | Claude's tool-use + caching + thinking APIs, generous SLA, opt-out of training, SOC 2 Type 2 |
| 2025-Q1 | Plaid | Adopted | Teller, Stripe Financial Connections | Largest US bank coverage, free sandbox, SOC 2 Type 2 |
| 2026-Q1 | Clerk | Adopted | NextAuth (self-hosted), Auth0 | Webhook lifecycle, low-friction MFA, SOC 2 Type 2 |
| 2026-Q1 | Stripe | Adopted | Paddle, Lemon Squeezy | Subscription primitives, US bank-grade compliance, SOC 2 Type 2 |
| 2026-Q1 | Resend | Adopted | SendGrid, Postmark | Modern API, generous free tier, SOC 2 Type 2 |
| 2026-Q2 | 1Password | Adopted | Bitwarden, LastPass | Family-account emergency-kit feature (delegation pattern from BC policy), SOC 2 Type 2 |

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "List every third party that processes customer data" | This file → "Vendor inventory" |
| "Show me their SOC 2 Type 2 reports" | `docs/policies/vendor-receipts/{vendor}/{YYYY}.pdf` (gitignored — share path with auditor at kickoff) |
| "Show me your DPA for vendor X" | This file → "Vendor inventory" links to the clickthrough URL; signed DPAs in 1Password legal vault |
| "How do you disclose subprocessors to your customers?" | This file → "Subprocessor disclosure"; `/legal/subprocessors` page on marketing site |
| "What happens when you switch vendors?" | This file → "Vendor offboarding procedure" |
| "Show me an offboarding you've performed" | After first offboarding: `audit_log` row with `action=vendor.terminated` |
| "How do you handle a vendor breach?" | `docs/policies/incident-response.md` (CC7.4) — vendor breach is a specific incident class with documented triage |

## Annual review

Reviewed annually (first Monday of January). Trigger an out-of-cycle
review when:

- A new vendor is added (immediate update + customer notification)
- A vendor is terminated (immediate update + customer notification)
- A vendor's SOC 2 Type 2 report drops material qualifications
- A vendor experiences a publicly-disclosed breach (regardless of
  whether we were affected)
- A customer requests negotiated DPA terms (signed-vs-clickthrough
  triage)

The review itself goes in the audit log as
`CONFIG_CHANGE/vendor_management.review` by the founder.
