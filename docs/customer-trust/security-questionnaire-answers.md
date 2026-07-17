# Pre-answered security questionnaire

**Owner:** Founder · **Last updated:** 2026-06-03

This document is the **sales-enablement artifact** that short-circuits
the enterprise procurement security review. When a prospect's CISO /
GRC team asks for a SIG-Lite, CAIQ, or custom security questionnaire,
the responses below cover ~90% of the common questions with citations
to specific policy files + code paths.

The structure follows the **Cloud Security Alliance CAIQ v4 domains**
(the most common form), grouped into the categories enterprise
procurement actually cares about. Each answer cites the authoritative
artifact in this repo. **All citations resolve to public files** in
the `ledger-nexus` portfolio.

**Procurement instructions:**

1. Skim the headers to find the section your team cares about most.
2. Each answer references a specific file path in the public repo
   `github.com/ledger-nexus/ledger-core` (or in a sibling repo per
   the portfolio map). Click through to verify.
3. If your custom questionnaire asks something not covered here,
   email `security@<our-domain>` and we'll provide a direct response
   within 2 business days.

---

## TL;DR for procurement

| Question | One-line answer | Authoritative artifact |
|---|---|---|
| Are you SOC 2 attested? | Not yet attested; Type 1 audit-ready (≈ 70%). Target Type 1 in Q3 2026; Type 2 follows the 6-month observation window. | `docs/SOC2_READINESS.md` v2.0 |
| What's encrypted at rest? | 26+ confidential columns across 5 repos with AES-256-GCM transparent encryption + HMAC search hashes (2-key separation). | `docs/architecture/portfolio-data-locations.md` |
| What's your data-classification scheme? | 4-tier (PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED) per-column, enforced at the helper-library level. | `docs/policies/data-classification.md` |
| Multi-tenant? Cross-tenant isolation? | Yes — `tenantId` on every customer-data table; `assertTenantScope()` helper enforces post-fetch; 4 pen-test passes have shipped. | `docs/SOC2_CONTROL_MATRIX.md` CC6.1 |
| How do you handle data subject requests (GDPR / CPRA)? | Procedure documented + executable code shipped. UI at `/admin/data-subject-requests`. 30-day SLA. | `docs/policies/data-subject-requests.md` |
| Sub-processors? | 11 vendors, 3-tier classified, sub-processor disclosure documented. | `docs/policies/vendor-management.md` v2.0 |
| Incident response procedure? | Policy + runbook split; SEV-1 = 15-minute acknowledgment; GDPR Art. 33 72h breach notification. | `docs/policies/incident-response.md` + `docs/runbooks/incident-response.md` |
| Audit logging? | Append-only Postgres RULE on `audit_log`; every privileged action emits a row; metadata is Json-mode encrypted at rest. | `prisma/sql/audit-log-append-only.sql` |
| Change management? | PR + CI + CODEOWNERS + pre-commit hook + `/soc2-check`. Solo-dev compensating controls documented. | `docs/policies/change-management.md` v2.0 |

---

## CSA CAIQ-v4 domain coverage

### A&A — Audit & Assurance

| Question | Answer | Reference |
|---|---|---|
| Do you have a formal audit + assurance program? | Yes — SOC 2 framework live, gap analysis maintained per-sprint. | `docs/SOC2_READINESS.md` v2.0 + `docs/SOC2_CONTROL_MATRIX.md` |
| Are independent third-party audits performed annually? | **Not yet.** SOC 2 Type 1 target Q3 2026; Type 2 follows 6-month window. We have internal pen-test passes (4 documented in git history) pending external pen-test before Type 1 audit. | Risk register #11, #12 |
| Do you maintain a risk register? | Yes — 30 reality-checked risks with file-path-cited mitigations. | `docs/policies/risk-register.md` v2.0 |

### AIS — Application & Interface Security

| Question | Answer | Reference |
|---|---|---|
| Application security testing? | CodeQL weekly + Dependabot batched + pre-commit secrets scan + `/soc2-check` per-diff manual gate. 4 pen-test passes documented. | `.github/workflows/security.yml` + `scripts/pre-commit-secrets-scan.sh` + `.claude/commands/soc2-check.md` |
| API authentication? | Internal APIs token-gated via `INTERNAL_API_TOKEN`; token comparison via `constantTimeEqual` (no timing oracle); secrets in Vercel env, never in code. | `src/lib/soc2/index.ts constantTimeEqual` + `src/lib/env.ts` |
| Input validation? | Every Server Action validates inputs via Zod before use. Client-supplied IDs re-checked server-side via the read-with-tenantId pattern. | `docs/policies/change-management.md` v2.0 "What counts as a change" + CLAUDE.md SOC 2 section |

### BCR — Business Continuity & Resilience

| Question | Answer | Reference |
|---|---|---|
| Documented RTO/RPO? | Yes — pre- and post-paying-customer tiers documented. Pre-customer: 4h RTO / 24h RPO. Post-customer (with Neon Launch upgrade): 1h RTO / ~minutes RPO. | `docs/policies/business-continuity.md` v2.0 |
| Backup strategy? | Today: Neon's internal redundancy. Post-first-paying-customer: Neon Launch ($19/mo) with 7-day PITR + weekly pg_dump cron to encrypted R2 bucket + 12-week retention. | BC v2.0 "Backup strategy" |
| DR test cadence? | Quarterly restore drill + quarterly tabletop + annual end-to-end DR. **Trigger to start the cadence: first paying customer signs.** | BC v2.0 "DR test cadence"; deficiency #3 |
| Per-scenario restore procedures? | 7 scenarios documented: DB corruption / Vercel outage / Anthropic outage / Neon account compromise / Vercel account compromise / laptop lost / lost encryption keys. | BC v2.0 "Restore procedures (per scenario)" |
| Founder unavailable / key-person risk? | 8-row delegation matrix (sealed envelopes, alternate-email recovery, 1Password emergency kit) with 7-day-no-activity trigger. | BC v2.0 "Founder unavailable" |

### CCC — Change Control & Configuration

| Question | Answer | Reference |
|---|---|---|
| Change management procedure? | Documented; every change goes through a PR even when self-authored. 8 required gates in CI. | `docs/policies/change-management.md` v2.0 |
| Solo-developer compensating controls? | Documented: every PR reviewed by Claude with PR-thread evidence; bypass-log discipline; stacked PR pattern. When a second contributor joins, the exception goes away. | CM v2.0 "Solo-dev exception" |
| Schema drift detection? | Source-side gate: `scripts/check-schema-fingerprint.sh` runs in CI on every PR; mismatch fails CI. Runtime gate: `schemaFingerprint()` surfaced via `/api/health`. | `scripts/check-schema-fingerprint.sh` + `src/app/api/health/route.ts` |
| Emergency change procedure? | Documented + bypass-log enforced; retroactive PR within 24h. | CM v2.0 "Emergency changes" + `docs/policies/bypass-log.md` |

### CEK — Cryptography, Encryption & Key Management

| Question | Answer | Reference |
|---|---|---|
| Encryption in transit? | TLS 1.3 via Vercel; HSTS header + middleware HTTPS upgrade + per-request CSP nonce + strict-dynamic. | `src/middleware.ts` |
| Encryption at rest? | AES-256-GCM transparent column encryption via Prisma `$extends`. 26+ encrypted columns across 5 repos. Json-mode encryption for nested payloads (`AuditLog.metadata`, `JournalEntry.sourcePayload`, AI suggestion bodies). | `src/lib/db/encrypted-fields-extension.ts` (mirrored across 5 repos) |
| Key management? | `FIELD_ENCRYPTION_KEY` (AES) + `FIELD_DETERMINISTIC_KEY` (HMAC search hash) — 2-key separation; search-hash leak does NOT yield plaintext. Keys in Vercel encrypted env (RESTRICTED tier). Rotation procedure documented. | `docs/policies/access-control.md` v2.0 "Service tokens" |
| Algorithm choice + spec? | AES-256-GCM with random IV per row + auth tag + version byte prefix. HMAC-SHA256 for deterministic search hashes (with domain separation: `domain‖NUL‖normalize(plaintext)`). | `docs/design/deterministic-encryption.md` |
| Encryption-at-rest covers PII? | Yes — every `User.email`, `User.displayName`, `Tenant.name`, `Party.displayName`, AI suggestion content, audit-log metadata, JE source payload, bank statement content. | `docs/policies/data-classification.md` field inventory |
| Key compromise / recovery? | Defense: 1Password vault canonical copy + Vercel env operational copy. Emergency kit per BC policy. Restoration runbook: `docs/policies/business-continuity.md` v2.0 "Lost encryption keys". | BC v2.0 + risk register #22, #23 |

### DCS — Datacenter Security

Outsourced to vendors. See [STA — Supply Chain Management] below for vendor inventory.

### DSP — Data Security & Privacy

| Question | Answer | Reference |
|---|---|---|
| Data classification scheme? | 4-tier: PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED. Per-column classification on every model. PII-field allowlist runtime-enforces redaction before log emission. | `docs/policies/data-classification.md` |
| Multi-tenant isolation? | `tenantId UUID @db.Uuid` on every customer-data table; `assertTenantScope()` helper enforced post-fetch; 4 pen-test passes ship; `tests/pen-test-tenant-isolation.test.ts` covers regressions. | `docs/SOC2_CONTROL_MATRIX.md` CC6.1 |
| Data residency? | US-East (Vercel + Neon default). Multi-region read replica trigger: 10+ paying customers OR EU customer (per BC v2.0). | BC v2.0 |
| Cross-border transfer compliance? | Default-US setup; EU customer triggers GDPR-specific DPA + SCCs negotiation per the vendor-management procurement procedure. Not in place yet (deficiency #15). | `docs/policies/vendor-management.md` v2.0 + deficiency log #15 |
| Data subject request handling? | GDPR Art. 15 (access) + Art. 17 (erasure) + Art. 16 (rectification) + Art. 20 (portability) + Art. 21 (object) + CPRA equivalents. 3 request channels, channel-specific identity verification, 30-day SLA, OWNER-only erasure gate, encryption-at-rest carve-out documented under Art. 34(3)(a). | `docs/policies/data-subject-requests.md` |
| Sub-processor disclosure? | 11 vendors classified into 3 tiers (RESTRICTED / CONFIDENTIAL / INTERNAL handlers) with per-vendor data-share matrix. **Limitation:** today the disclosure lives in the public ledger-core repo; ledger-nexus has no marketing site yet (deficiency #16/#23). | `docs/policies/vendor-management.md` v2.0 + deficiency log #16, #23 |
| Data retention policy + enforcement? | Declarative policy table in code; daily cron purges age-out rows; audit-log row per run. Per-data-class retention windows documented. | `docs/policies/data-classification.md` "Retention" + `src/lib/retention/policies.ts` + `/api/cron/retention` |
| Anonymization / pseudonymization? | DSR erasure procedure: User.email → `redacted-{userId}@deleted.local`; financial-record attribution edges preserved (legal-retention exemption Art. 17(3)(b/e)). | DSR procedure "Right to erasure" + `src/lib/privacy/user-data.ts eraseUserPii` |

### GRC — Governance, Risk & Compliance

| Question | Answer | Reference |
|---|---|---|
| Information security policy? | 10-document policy directory at v2.0. CC1 umbrella with sub-policies per CC2-CC9 + 4 TSCs. | `docs/policies/security.md` v2.0 |
| Risk management program? | 30-row risk register, reality-checked; every Mitigated row cites a commit hash. | `docs/policies/risk-register.md` v2.0 |
| Control deficiency management? | Operating ledger; 12 currently Open (mostly customer-trigger-gated); annual review + per-bypass discipline. | `docs/policies/control-deficiency-log.md` v2.0 |
| Compliance certifications? | **Pending:** SOC 2 Type 1 target Q3 2026. Today: documented framework + internal evidence. GDPR + CPRA compliance documented in DSR procedure + retention engine. | `docs/SOC2_READINESS.md` v2.0 |
| Annual policy review? | Documented cadence (first Monday of January) per policy + out-of-cycle triggers per sub-policy. | Each sub-policy's "Annual review" section |

### HRS — Human Resources

| Question | Answer | Reference |
|---|---|---|
| Background checks? | **N/A** — solo founder today. Documented compensating control: AI contributor (Claude) follows the SOC 2 framework on every session; CLAUDE.md is the auto-loaded contract. | `docs/policies/security.md` v2.0 "Acceptable use — AI contributors" |
| Acceptable use policy? | Documented for human contributors + AI contributors. Annual acknowledgement procedure documented. | Security v2.0 "Acceptable use" + `docs/policies/annual-acknowledgement-template.md` |
| Onboarding / offboarding? | Onboarding: read CLAUDE.md, read policy directory, sign annual acknowledgement. Offboarding: 6-step procedure (Vercel revoke, CODEOWNERS removal, User deactivation, token rotation, role-orphan verification, audit-log emission). | `docs/policies/access-control.md` v2.0 "Deprovisioning" |
| Security training? | N/A solo. When second contributor joins: each one signs the annual acknowledgement (= attestation of policy review). | Security v2.0 + access-control v2.0 |

### IAM — Identity & Access Management

| Question | Answer | Reference |
|---|---|---|
| Authentication provider? | Clerk (commit `b99bbb4` — middleware fails closed in production without Clerk env). | `docs/policies/access-control.md` v2.0 |
| MFA available + enforced? | Available via Clerk; partial enforcement (target: enforce for OWNER + ADMIN roles). Documented as Partial in risk register #20. | access-control v2.0 + risk register #20 |
| Role-based access control? | Three per-tenant membership roles (`OWNER > ADMIN > MEMBER`) on `TenantMembership.role`. Enforced per Server Action: `requireCurrentUser()` + session-derived tenant scope, then a role check (`isTenantAdmin` = OWNER/ADMIN, or global `requireAdmin`) for privileged actions; every customer-data query is pinned to the session `tenantId`. A read-only `VIEWER` role and a centralized `requirePermission()` permission catalog are planned, not yet implemented (control-deficiency-log #29). | access-control v2.1 + `src/lib/auth/{current-user,tenant}.ts` |
| Privileged access procedure? | OWNER-only for irreversible operations (admin reset, owner transfer, data erasure, billing); ADMIN-only for memberships + period close + audit-log export. | access-control v2.0 permission catalog |
| Access review cadence? | Quarterly per documented procedure (first Monday of each quarter). Template at `docs/policies/access-review-template.md`. | access-control v2.0 + `docs/policies/access-review-template.md` |
| Session management? | Clerk-managed (8h idle / 24h absolute defaults; tunable per tenant). Session revocation via logout + Clerk admin remote sign-out. | access-control v2.0 |

### IPY — Interoperability & Portability

| Question | Answer | Reference |
|---|---|---|
| Data export format? | Customer self-export available to any member via `/admin/data-subject-requests`. Format is JSON (schema-versioned at `DataExportBundle.schemaVersion = 1`). | DSR procedure "Right to portability" + `src/lib/privacy/user-data.ts buildUserDataExport` |
| Vendor migration? | Internal docs/migrations exist for the substrate; per-customer migration is a manual support engagement. | (Not in public docs yet.) |
| Standards compliance? | ASC 606 (revenue), ASC 842 (leases), GAAP/IFRS multi-book, US tax + IFRS tax difference reporting. | `docs/universal-schema.md` + CLAUDE.md |

### IVS — Infrastructure & Virtualization

| Question | Answer | Reference |
|---|---|---|
| Network segmentation? | Outsourced to Vercel + Neon (vendor-managed). | `docs/policies/vendor-management.md` v2.0 |
| Production network boundary? | Per-request CSP with nonce + `strict-dynamic`; HSTS; X-Frame-Options; webhook signature verification (Plaid ES256, Stripe HMAC). | `next.config.js` + `src/middleware.ts` |
| Internal API authorization? | Token-gated via `INTERNAL_API_TOKEN`; verification through `constantTimeEqual`; tokens in Vercel encrypted env (RESTRICTED tier). | `docs/policies/access-control.md` v2.0 "Service tokens" |

### LOG — Logging & Monitoring

| Question | Answer | Reference |
|---|---|---|
| Audit log? | Append-only Postgres RULE on `audit_log` table. Every privileged action emits a row via `auditPrivilegedAction()` or `auditedMutation()`. RULE prevents UPDATE + DELETE — even DB admin cannot tamper. | `prisma/sql/audit-log-append-only.sql` |
| Log retention? | `audit_log`: 7 years (SOC 2 + IRS). Vercel function logs: 7-30 days (vendor). Sentry: 30+ days when DSN provisioned. | `docs/policies/data-classification.md` retention table |
| PII redaction in logs? | Yes — `redactPii()` runs before every console.log + Sentry transmit. Field allowlist in `src/lib/soc2/index.ts`. | `src/lib/soc2/index.ts redactPii` + `src/lib/monitoring/index.ts` |
| Monitoring + alerting? | Sentry shim with redactPii (PR #10); falls back to console when DSN absent. Vercel built-in health checks. `/api/health` surfaces DB connectivity + schema fingerprint + encryption status. | `src/lib/monitoring/index.ts` + `src/app/api/health/route.ts` |
| Real-time anomaly detection? | **Partial** — Sentry DSN provisioning pending. IP-anomaly alerting deferred to Sentry paid tier. | Risk register #20 |

### SEF — Security Incident, E-Discovery & Cloud Forensics

| Question | Answer | Reference |
|---|---|---|
| Incident response policy? | 4-row severity matrix with per-row acknowledgment + external-comms SLA. Default-up triage rule. | `docs/policies/incident-response.md` v2.0 |
| Incident response runbook? | Per-incident-class playbooks (leaked credential, unauthorized JE, period reopened, deploy bricked, encryption-key compromise, vendor breach, PII exfiltration). | `docs/runbooks/incident-response.md` |
| SEV-1 acknowledgment SLA? | < 15 minutes. | IR v2.0 severity matrix |
| Customer-facing incident communication? | Status page (NOT on Vercel) + email within 30 minutes of detection; hourly updates until resolved. | IR v2.0 + BC v2.0 "Communication during an outage" |
| GDPR Art. 33 breach notification? | 72-hour SLA to supervisory authority; Art. 34 notification to subjects when "high risk"; Art. 34(3)(a) encryption-at-rest carve-out documented as no-notification decision basis. | IR v2.0 "Privacy-incident overlay" |
| Postmortem requirements? | Blameless, 5-business-day SLA, 8 required sections (Summary / Impact / Timeline / Root cause / What worked / What didn't / Action items / Updated risk register). | IR v2.0 "Postmortem requirements" |
| Tabletop exercise cadence? | Annual (second Monday of January per IR v2.0). | IR v2.0 + `docs/incidents/README.md` |

### STA — Supply Chain Management, Transparency & Accountability

| Question | Answer | Reference |
|---|---|---|
| Vendor inventory + classification? | 11 vendors, 3-tier classified (RESTRICTED handlers / CONFIDENTIAL handlers / INTERNAL handlers) with per-vendor data-share matrix. | `docs/policies/vendor-management.md` v2.0 "Vendor inventory" |
| Vendor SOC 2 receipts on file? | **Procedure documented; first download January 2027** (annual cadence). PDFs in `docs/policies/vendor-receipts/` (gitignored per "do not distribute" clauses). | vendor-management v2.0 + `docs/policies/vendor-receipts/README.md` |
| DPAs with vendors? | Every Tier 1/2 vendor has a clickthrough DPA. Signed DPAs trigger: first customer requiring negotiated terms OR first EU customer. | vendor-management v2.0 "Data Processing Agreements" + deficiency log #15 |
| Subprocessor change notification? | 30-day customer notification window per MSA. | vendor-management v2.0 "Subprocessor disclosure" |
| Software bill of materials (SBOM)? | CycloneDX-format SBOM generated on every push to main; uploaded as 90-day-retained workflow artifact. | `.github/workflows/sbom.yml` |

### TVM — Threat & Vulnerability Management

| Question | Answer | Reference |
|---|---|---|
| Vulnerability management? | CodeQL weekly + Dependabot batched + npm audit hard-fail at high severity in CI. SBOM artifact per main push. **Gap:** npm versions not pinned to exact (Open / Partial). | Risk register #11 + deficiency log #4 |
| Penetration testing? | 4 internal pen-test passes documented in git history (`72c164b`, `185902f`, `3c6d0a2`, `b99bbb4`). External pen-test scheduled prior to SOC 2 Type 1 audit. | Risk register + git log |
| Patch management? | Dependabot opens upgrade PRs; CI runs them through the same gates as human PRs. | `.github/dependabot.yml` |
| Vulnerability disclosure / responsible-disclosure? | Documented in `SECURITY.md` per repo + RFC 9116 `.well-known/security.txt` per Next.js app. 48-hour acknowledgement, 90-day disclosure window. | `SECURITY.md` + `public/.well-known/security.txt` |

### UEM — Universal Endpoint Management

N/A — cloud-only deployment. Contributor endpoints are personal laptops covered by acceptable-use policy.

---

## Questions we can't yet say "yes" to (and why)

The questionnaire framework expects honest answers. Here are the open items:

| Question | Today's state | Trigger to close |
|---|---|---|
| Have you completed a SOC 2 Type 2 audit? | No — Type 1 target Q3 2026 | External auditor engagement |
| Have you tested a backup restore in production? | No | First paying customer signs (Neon Launch upgrade) — see deficiency #3 |
| Do you have signed (non-clickthrough) DPAs with Tier 1 vendors? | No | First customer requiring negotiated terms OR EU customer |
| Are sub-processors disclosed on a customer-facing page? | No — disclosure is in the public ledger-core repo only | ledger-nexus marketing site exists OR MSA-cited GitHub URL accepted |
| Is your error monitoring fully wired? | Shim + fallback shipped; paid DSN pending | DSN provisioned |
| MFA enforced for all admin roles? | Available via Clerk; not yet enforced | Clerk policy configuration |
| Is RLS enabled on Postgres? | No — application-layer scoping is the enforcement; pen-test-tenant-isolation covers regressions | Customer requirement or EU customer |
| Have you completed an external penetration test? | No — 4 internal passes documented | Engagement scheduled prior to SOC 2 Type 1 |

We declare these honestly so the customer can decide whether they're a deal-breaker or whether the documented compensating controls / triggers meet their risk threshold.

---

## How to use this document

**For procurement / GRC teams:**
- Skim the TL;DR at the top for the headline answers
- Drill into the CAIQ-domain section that maps to your custom questionnaire
- The "Questions we can't yet say 'yes' to" section is the honest gap analysis — read this before deciding whether to pass us through procurement

**For our sales:**
- Send this URL (the public GitHub link) when prospect asks "do you have a SOC 2 report?"
- For custom questionnaires, copy-paste relevant sections; do not lie about anything in the "Questions we can't yet say 'yes' to" section — every gap is documented honestly in the risk register or deficiency log
- For enterprise customers requesting signed DPAs (deficiency #15), this PR is the prompt to start that conversation

**Update cadence:**
- Reviewed annually with the policy directory + per-sprint when a major status flip happens
- Out-of-cycle review when first paying customer signs (triggers many "today's state" rows to flip)
